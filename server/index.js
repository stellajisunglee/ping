import { createServer } from 'node:http';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { CallEngine, LimitError, PlanError } from './calls.js';
import { PING, PLAN_MINUTES } from './contacts.js';
import { createPushSender } from './push.js';
import { createOpenAI } from './openai.js';
import { isValidTimeZone } from './schedule.js';
import { cleanMetrics, metricsProblems } from '../public/turn-metrics.js';
import { FREE_WORD_LIMIT } from './stack.js';
import { buildSession, NOT_NOW_GOODBYES, smartTurnRules, turnDetection, voiceMessageFor } from './tutor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const TICK_MS = 1_000;
const MAX_BODY_BYTES = 64_000; // room for a full call's transcript
const MAX_FEEDBACK_LENGTH = 2_000;
const MAX_WRONG_CODES_PER_MINUTE = 10;
const MAX_TRACKED_IPS = 10_000;
const DEFAULT_ADMIN_CODE = 'minabystella_admin_only';
const DEFAULT_BETA_CODE = 'beta-01';
const DEFAULT_YC_CODE = 'YC-Demo'; // for YC reviewers: the beta tester's version on Premium, counted separately
const PLAN_FOR_CODE = { yc: 'premium' }; // codes not listed start on Free
const STARTER_STACK_CODES = new Set(['yc']); // accounts that start with a few example words and sentences

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};
// Image files are already compressed. Everything else is sent brotli-compressed when the browser accepts it.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.webmanifest', '.wasm', '.onnx']);
// Smart Turn's runtime and models have their version in the path, so a browser can keep them for good.
const IMMUTABLE_PATHS = ['/vendor/', '/models/'];
const SMART_TURN_FILES = new Set([
  'vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs',
  'vendor/onnxruntime-web-1.30.0/ort-wasm-simd-threaded.mjs',
  'vendor/onnxruntime-web-1.30.0/ort-wasm-simd-threaded.wasm',
  'models/smart-turn-v3.2-cpu.onnx',
  'models/silero-vad-2026-10.onnx',
]);

const SECURITY_HEADERS = {
  // 'wasm-unsafe-eval' lets Smart Turn's WebAssembly compile. It doesn't allow eval() of JavaScript.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // These two make the page "cross-origin isolated", which browsers require before WebAssembly can use
  // several threads. Smart Turn needs them to decide fast enough on a phone.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const compress = promisify(brotliCompress);
const compressed = new Map(); // file -> { mtimeMs, bytes: Promise<Buffer> }, made once per version of a file

function compressedFile(file, body, mtimeMs) {
  const cached = compressed.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.bytes;
  const bytes = compress(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length } });
  compressed.set(file, { mtimeMs, bytes });
  bytes.catch(() => compressed.delete(file));
  return bytes;
}

const digest = (value) => createHash('sha256').update(String(value)).digest();
const codesMatch = (given, expected) => timingSafeEqual(digest(given), digest(expected));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new SyntaxError('Body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const isSubscription = (value) =>
  typeof value?.endpoint === 'string' && value.endpoint.startsWith('https://') && typeof value.keys?.p256dh === 'string' && typeof value.keys?.auth === 'string';

export function createApp({ engine, openai, config }) {
  const { inviteCodes, vapidPublicKey, model, voice, dataDir } = config;
  const registerAttempts = new Map();
  const voiceMessageJobs = new Map();
  const voiceMessageFile = (contactId) => join(dataDir ?? ROOT, 'voice-messages', `${contactId}.mp3`);

  // One recording per contact is shared by everyone, so it's made once and kept.
  function ensureVoiceMessage(contact = PING) {
    const file = voiceMessageFile(contact.id);
    if (!openai.hasKey || !dataDir || existsSync(file)) return Promise.resolve();
    if (!voiceMessageJobs.has(contact.id)) {
      const job = openai
        .speak(voiceMessageFor(contact).japanese, contact.voice ?? voice)
        .then((audio) => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(`${file}.tmp`, audio);
          renameSync(`${file}.tmp`, file);
        })
        .catch((error) => console.warn(`Voice message could not be recorded: ${error.message}`))
        .finally(() => voiceMessageJobs.delete(contact.id));
      voiceMessageJobs.set(contact.id, job);
    }
    return voiceMessageJobs.get(contact.id);
  }

  function publicVoicemail(user) {
    const voicemail = engine.voicemail(user);
    if (!voicemail) return null;
    const { message, contact } = voicemail;
    return {
      id: message.id,
      at: message.at,
      heard: message.heard,
      contactId: contact.id,
      contactName: contact.name,
      ...voiceMessageFor(contact),
      audioUrl: `/voice-messages/${contact.id}.mp3`,
    };
  }

  // A problem with the transcript shouldn't stop the call itself.
  async function mintSession(session, userId) {
    try {
      return await openai.mintClientSecret(session, userId);
    } catch (error) {
      console.warn(`Retrying the voice session without a transcript: ${error.message}`);
      const { transcription, ...input } = session.audio.input;
      return openai.mintClientSecret({ ...session, audio: { ...session.audio, input } }, userId);
    }
  }

  // Codes aren't case-sensitive, so "yc-demo" works as well as "YC-Demo".
  const codeNameFor = (given) => Object.entries(inviteCodes).find(([, code]) => code && codesMatch(given.toLowerCase(), code.toLowerCase()))?.[0] ?? null;

  const recentWrongCodes = (ip) => (registerAttempts.get(ip) ?? []).filter((at) => Date.now() - at < 60_000);

  // Only wrong codes count, so a group joining from the same Wi-Fi isn't locked out.
  function recordWrongCode(ip) {
    if (registerAttempts.size > MAX_TRACKED_IPS) registerAttempts.clear();
    registerAttempts.set(ip, [...recentWrongCodes(ip), Date.now()]);
  }

  function publicUser(user) {
    return {
      role: user.role,
      plan: user.plan,
      turnMode: user.turnMode,
      clearAt: user.clearAt,
      settings: user.settings,
      hasSubscription: Boolean(user.subscription),
      streak: engine.streak(user),
      lastCall: engine.lastCall(user),
      voicemail: publicVoicemail(user),
      contacts: engine.contacts(user),
      words: user.words,
      sentences: user.sentences,
      freeWordLimit: FREE_WORD_LIMIT,
      calling: engine.calling(user),
      planMinutes: PLAN_MINUTES,
    };
  }

  const callState = (call) => ({ id: call.id, state: call.state, contactName: engine.contactNameOf(call) });

  async function handleApi(req, res, pathname) {
    const { method } = req;

    if (method === 'GET' && pathname === '/api/config') {
      return json(res, 200, { vapidPublicKey, voiceReady: openai.hasKey });
    }

    if (method === 'POST' && pathname === '/api/register') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
      if (recentWrongCodes(ip).length >= MAX_WRONG_CODES_PER_MINUTE) return json(res, 429, { error: 'Too many tries. Wait a minute and try again.' });
      if (!Object.values(inviteCodes).some(Boolean)) return json(res, 503, { error: 'Sign-ups are closed.' });
      const body = await readJson(req);
      const codeName = codeNameFor(String(body.inviteCode ?? ''));
      if (!codeName) {
        recordWrongCode(ip);
        return json(res, 403, { error: "That invite code isn't right." });
      }
      if (!isValidTimeZone(body.timeZone)) return json(res, 400, { error: 'Your time zone was not recognized.' });
      const { user, token } = engine.register(body.timeZone, codeName === 'admin' ? 'admin' : 'beta', codeName, PLAN_FOR_CODE[codeName], STARTER_STACK_CODES.has(codeName));
      return json(res, 201, { token, ...publicUser(user) });
    }

    // Links to a call work without a login so the service worker can use them.
    // The call id is a random UUID that only the user's own phone ever receives.
    const callAction = pathname.match(/^\/api\/calls\/([\w-]+)\/(delivered|answer|decline)$/);
    if (method === 'POST' && callAction) {
      const [, id, action] = callAction;
      const call = action === 'delivered' ? engine.markDelivered(id) : action === 'answer' ? engine.answer(id) : engine.decline(id);
      return call ? json(res, 200, callState(call)) : json(res, 404, { error: 'Call not found.' });
    }

    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const user = engine.userForToken(token);
    if (!user) return json(res, 401, { error: 'Please sign in again.' });

    if (method === 'GET' && pathname === '/api/me') return json(res, 200, publicUser(user));

    if (method === 'DELETE' && pathname === '/api/me') {
      for (const contact of user.customContacts) rmSync(voiceMessageFile(contact.id), { force: true });
      engine.deleteUser(user);
      return json(res, 200, {});
    }

    if (method === 'PUT' && pathname === '/api/push') {
      const body = await readJson(req);
      if (!isSubscription(body.subscription)) return json(res, 400, { error: 'Invalid subscription.' });
      engine.setSubscription(user, body.subscription, isValidTimeZone(body.timeZone) ? body.timeZone : null);
      return json(res, 200, publicUser(user));
    }

    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = await readJson(req);
      const settings = engine.updateSettings(user, body);
      return json(res, 200, {
        settings,
        turnDetection: turnDetection({ thinkingTime: settings.thinkingTime, speed: settings.speed, turnMode: user.turnMode }),
        smartTurn: smartTurnRules(settings.thinkingTime),
      });
    }

    if (method === 'POST' && pathname === '/api/test-ring') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      engine.requestTestRing(user);
      return json(res, 202, {});
    }

    if (method === 'GET' && pathname === '/api/admin/invites') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      return json(res, 200, { invites: engine.inviteReport(Object.keys(inviteCodes).filter((name) => inviteCodes[name])) });
    }

    if (method === 'POST' && pathname === '/api/calls') {
      const body = await readJson(req);
      const call = engine.callBack(user, typeof body.contactId === 'string' ? body.contactId : null);
      return json(res, 201, callState(call));
    }

    if (method === 'PUT' && pathname === '/api/plan') {
      if (user.role !== 'admin') return json(res, 403, { error: "Plans can't be changed during the beta." });
      const body = await readJson(req);
      if (!engine.setPlan(user, body.plan)) return json(res, 400, { error: 'That plan was not recognized.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'PUT' && pathname === '/api/turn-mode') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      const body = await readJson(req);
      if (!engine.setTurnMode(user, body.turnMode)) return json(res, 400, { error: 'That turn mode was not recognized.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'PUT' && pathname === '/api/contact') {
      const body = await readJson(req);
      if (!engine.selectContact(user, body.contactId)) return json(res, 404, { error: 'Contact not found.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'POST' && pathname === '/api/contacts') {
      const contact = engine.createContact(user, await readJson(req));
      if (!contact) return json(res, 400, { error: 'Give your contact a name, a topic and a voice.' });
      ensureVoiceMessage(contact);
      return json(res, 201, publicUser(user));
    }

    const contactRoute = pathname.match(/^\/api\/contacts\/([\w-]+)$/);
    if (method === 'DELETE' && contactRoute) {
      if (!engine.deleteContact(user, contactRoute[1])) return json(res, 404, { error: 'Contact not found.' });
      rmSync(voiceMessageFile(contactRoute[1]), { force: true });
      return json(res, 200, publicUser(user));
    }

    if (method === 'POST' && pathname === '/api/stack/words') {
      const result = engine.addWord(user, await readJson(req));
      return json(res, result.invalid ? 400 : 200, result);
    }

    const wordRoute = pathname.match(/^\/api\/stack\/words\/([\w-]+)$/);
    if (method === 'DELETE' && wordRoute) {
      if (!engine.removeWord(user, wordRoute[1])) return json(res, 404, { error: 'Word not found.' });
      return json(res, 200, publicUser(user));
    }

    const examplesRoute = pathname.match(/^\/api\/stack\/words\/([\w-]+)\/examples$/);
    if (method === 'POST' && examplesRoute) {
      if (!openai.hasKey) return json(res, 503, { error: 'Example sentences are not set up yet.' });
      const word = engine.startLookup(user, examplesRoute[1]);
      if (!word) return json(res, 404, { error: 'Word not found.' });
      return json(res, 200, { sentences: await openai.exampleSentences(word, user.settings.proficiency) });
    }

    if (method === 'POST' && pathname === '/api/stack/sentences') {
      const sentence = engine.saveSentence(user, await readJson(req));
      if (!sentence) return json(res, 400, { error: 'That sentence could not be saved.' });
      return json(res, 201, publicUser(user));
    }

    const sentenceRoute = pathname.match(/^\/api\/stack\/sentences\/([\w-]+)$/);
    if (method === 'DELETE' && sentenceRoute) {
      if (!engine.removeSentence(user, sentenceRoute[1])) return json(res, 404, { error: 'Sentence not found.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'POST' && pathname === '/api/feedback') {
      const { text } = await readJson(req);
      const feedback = typeof text === 'string' ? text.trim().slice(0, MAX_FEEDBACK_LENGTH) : '';
      if (!feedback) return json(res, 400, { error: 'Please write something first.' });
      engine.addFeedback(feedback);
      console.log(`Feedback: ${JSON.stringify(feedback)}`);
      return json(res, 201, {});
    }

    const ended = pathname.match(/^\/api\/calls\/([\w-]+)\/ended$/);
    if (method === 'POST' && ended) {
      if (!engine.endCall(user, ended[1])) return json(res, 404, { error: 'Call not found.' });
      return json(res, 200, { calling: engine.calling(user) });
    }

    const connected = pathname.match(/^\/api\/calls\/([\w-]+)\/connected$/);
    if (method === 'POST' && connected) {
      if (!engine.markConnected(user, connected[1])) return json(res, 409, { error: 'This call has ended.' });
      return json(res, 200, { streak: engine.streak(user) });
    }

    // Timing numbers only, which is why every user's are accepted, unlike transcripts.
    const metricsRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/metrics$/);
    if (method === 'POST' && metricsRoute) {
      const body = await readJson(req);
      const metrics = cleanMetrics(body);
      if (!metrics) {
        console.warn(`turn-metrics rejected ${JSON.stringify(metricsProblems(body))}`);
        return json(res, 400, { error: 'Invalid metrics.' });
      }
      const record = engine.saveTurnMetrics(user, metricsRoute[1], metrics);
      if (!record) {
        console.warn('turn-metrics rejected: call not found');
        return json(res, 404, { error: 'Call not found.' });
      }
      console.log(`turn-metrics ${JSON.stringify(record)}`);
      return json(res, 201, {});
    }

    const transcript = pathname.match(/^\/api\/calls\/([\w-]+)\/transcript$/);
    if (method === 'POST' && transcript) {
      const { lines } = await readJson(req);
      return json(res, 200, { saved: engine.saveConversation(user, transcript[1], lines) });
    }

    const heard = pathname.match(/^\/api\/messages\/([\w-]+)\/heard$/);
    if (method === 'POST' && heard) {
      return json(res, engine.markHeard(user, heard[1]) ? 200 : 404, {});
    }

    const session = pathname.match(/^\/api\/calls\/([\w-]+)\/session$/);
    if (method === 'POST' && session) {
      if (!openai.hasKey) return json(res, 503, { error: 'The voice engine is not set up yet.' });
      const details = engine.sessionDetails(user, session[1]);
      if (!details) return json(res, 409, { error: 'This call has ended.' });
      const clientSecret = await mintSession(buildSession({ model, voice, ...details }), user.id);
      return json(res, 200, {
        clientSecret,
        sdpUrl: openai.sdpUrl,
        maxSeconds: details.maxSeconds,
        hangUpLines: details.calledBack ? [] : Object.values(NOT_NOW_GOODBYES),
        question: details.question,
        turnMode: details.turnMode,
        smartTurn: smartTurnRules(details.settings.thinkingTime),
      });
    }

    return json(res, 404, { error: 'Not found.' });
  }

  async function handleStatic(req, res, pathname) {
    const voiceMessage = pathname.match(/^\/voice-messages\/([\w-]+)\.mp3$/);
    if (voiceMessage) {
      const contact = engine.contactById(voiceMessage[1]);
      if (!contact) {
        res.writeHead(404).end();
        return;
      }
      ensureVoiceMessage(contact);
      try {
        const audio = await readFile(voiceMessageFile(contact.id));
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': audio.length });
        res.end(audio);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = normalize(join(PUBLIC_DIR, relative));
    const type = CONTENT_TYPES[extname(file)];
    if (!type || !file.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const [body, info] = await Promise.all([readFile(file), stat(file)]);
      const immutable = IMMUTABLE_PATHS.some((path) => pathname.startsWith(path));
      const headers = { 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS };
      if (COMPRESSIBLE.has(extname(file)) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '')) {
        const bytes = await compressedFile(file, body, info.mtimeMs);
        res.writeHead(200, { ...headers, 'Content-Encoding': 'br', 'Content-Length': bytes.length, Vary: 'Accept-Encoding' });
        res.end(bytes);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': body.length, Vary: 'Accept-Encoding' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (!pathname.startsWith('/api/')) {
      await handleStatic(req, res, pathname);
      return;
    }
    try {
      await handleApi(req, res, pathname);
    } catch (error) {
      if (error instanceof LimitError) return json(res, 429, { error: error.message });
      if (error instanceof PlanError) return json(res, 403, { error: error.message });
      if (error instanceof SyntaxError) return json(res, 400, { error: 'Invalid request.' });
      console.error(error);
      json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  });

  return { server, ensureVoiceMessage };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR ?? join(ROOT, 'data');
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required. Run `npm run setup` to create them.');
    process.exit(1);
  }
  const voice = process.env.REALTIME_VOICE ?? 'marin';
  const store = new Store(join(dataDir, 'ping.json'));
  const sendPush = createPushSender({
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT ?? process.env.RENDER_EXTERNAL_URL ?? 'https://ping.example.com',
  });
  const engine = new CallEngine({ store, sendPush, dailyCallLimit: Number(process.env.DAILY_CALL_LIMIT) || null });
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '', baseUrl: process.env.OPENAI_BASE_URL, textModel: process.env.TEXT_MODEL });
  const { server, ensureVoiceMessage } = createApp({
    engine,
    openai,
    config: {
      inviteCodes: {
        admin: process.env.ADMIN_INVITE_CODE ?? DEFAULT_ADMIN_CODE,
        beta: process.env.BETA_INVITE_CODE ?? DEFAULT_BETA_CODE,
        yc: process.env.YC_INVITE_CODE ?? DEFAULT_YC_CODE,
      },
      vapidPublicKey: VAPID_PUBLIC_KEY,
      model: process.env.REALTIME_MODEL ?? 'gpt-realtime',
      voice,
      dataDir,
    },
  });
  setInterval(() => engine.tick().catch((error) => console.error(error)), TICK_MS);
  ensureVoiceMessage();
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`Ping running on http://localhost:${port}`);
    if (!process.env.OPENAI_API_KEY) console.warn('OPENAI_API_KEY is not set: calls and voice messages will not work.');
    warmCompression();
  });
}

// Compressing Smart Turn's 25 MB of files takes a few seconds, so do it once at start-up
// rather than making the first caller wait.
async function warmCompression() {
  const files = [...SMART_TURN_FILES].map((path) => join(PUBLIC_DIR, path));
  for (const file of files) {
    try {
      const [body, info] = await Promise.all([readFile(file), stat(file)]);
      await compressedFile(file, body, info.mtimeMs);
    } catch (error) {
      console.warn(`Could not prepare ${file}`, error.message);
    }
  }
}
