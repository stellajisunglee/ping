import { createServer } from 'node:http';
import { existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { CallEngine, cleanComment, cleanName, cleanRating, cleanReading, needsOnboarding, cleanTranscript, LimitError, PlanError, policyNoticeFor, recordingLocked, recordsCalls } from './calls.js';
import { audioExtension, Recordings } from './recordings.js';
import { callConfig, ENGINES, RANDOM_MIX } from './experiment.js';
import { SCENARIOS } from './scenarios.js';
import { AGENT_URL, agentListen, agentSettings, agentSpeak, createDeepgram } from './deepgram.js';
import { PING, PLAN_LIMITS } from './contacts.js';
import { createPushSender } from './push.js';
import { createOpenAI } from './openai.js';
import { isValidTimeZone } from './schedule.js';
import { cleanMetrics, metricsProblems } from '../public/turn-metrics.js';
import { cleanLearning } from '../public/learning-metrics.js';
import { cleanTurnData } from '../public/turn-records.js';
import { LIVE_BACKEND_MODEL, LIVE_MODEL, LIVE_VOICE, liveSession } from './live.js';
import { createElevenLabs, elevenOverrides } from './elevenlabs.js';
import { buildSession, NOT_NOW_GOODBYES, PROMPT_VERSION, smartTurnRules, TIME_UP_LINES, turnDetection, voiceMessageFor } from './tutor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
// The deployed commit, for the call log. Render sets RENDER_GIT_COMMIT on every deploy; anything that
// doesn't look like a commit (or no value, as on a laptop) is saved as null rather than guessed.
export const buildCommit = (value) => (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null);
const TICK_MS = 1_000;
const MAX_BODY_BYTES = 64_000; // room for a full call's transcript
const MIN_EXPORT_KEY_LENGTH = 32; // EXPORT_KEY must be at least this long, or the data export stays off
const MIN_GRADED_TURNS = 3;
// What engines that take a note mid-call (GPT-Live, ElevenLabs) are told near the time limit.
const TIME_UP_NOTE = 'Time is nearly up. Say a short warm goodbye in Japanese now, then end the call.'; // learner lines a recorded call needs before its speaking level is estimated
const MAX_RECORDING_BYTES = 25_000_000; // a 10-minute call is about 10 MB from an iPhone
const MAX_RECORDED_LINES = 400;
const MAX_FEEDBACK_LENGTH = 2_000;
const MAX_WRONG_CODES_PER_MINUTE = 10;
const MAX_TRACKED_IPS = 10_000;
// The invite codes come only from the environment, never from this file, so the code can be public.
// A code that isn't set lets no one join with it. The yc code is for YC reviewers: the beta tester's version on Premium, counted separately.
const PLAN_FOR_CODE = { yc: 'premium', beta: 'platinum' }; // codes not listed (admin, free) start on Free
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
  '.json': 'application/json; charset=utf-8', // the JLPT word list
};
// Image files are already compressed. Everything else is sent brotli-compressed when the browser accepts it.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.webmanifest', '.wasm', '.onnx', '.json']);
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://api.openai.com wss://agent.deepgram.com wss://api.elevenlabs.io; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'",
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

class TooLargeError extends Error {}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new TooLargeError('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof TooLargeError) throw new SyntaxError(error.message);
    throw error;
  }
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

const isSubscription = (value) =>
  typeof value?.endpoint === 'string' && value.endpoint.startsWith('https://') && typeof value.keys?.p256dh === 'string' && typeof value.keys?.auth === 'string';

// The recordings' size, the store file's, and the disk's size and free space where the data lives (null if unknown).
export function diskUsage({ dataDir, recordingsBytes }) {
  const storeFile = dataDir ? join(dataDir, 'ping.json') : null;
  let storeBytes = 0;
  try {
    if (storeFile && existsSync(storeFile)) storeBytes = statSync(storeFile).size;
  } catch {}
  let diskBytes = null;
  let freeBytes = null;
  try {
    const stats = statfsSync(dataDir ?? ROOT);
    diskBytes = stats.blocks * stats.bsize;
    freeBytes = stats.bavail * stats.bsize;
  } catch {}
  return { recordingsBytes, storeBytes, diskBytes, freeBytes };
}

export function createApp({ engine, openai, deepgram = createDeepgram({ apiKey: '' }), elevenlabs = createElevenLabs({ apiKey: '', agentId: '' }), config }) {
  const liveModel = config.liveModel ?? LIVE_MODEL;
  const liveVoice = config.liveVoice ?? LIVE_VOICE;
  const liveBackendModel = config.liveBackendModel ?? LIVE_BACKEND_MODEL;
  const elevenLlm = config.elevenLlm ?? 'gpt-4.1-mini'; // what the Ping agent was set up with, for the call log
  const pendingLive = new Map(); // callId -> the GPT-Live session waiting for the phone's WebRTC offer
  const { inviteCodes, vapidPublicKey, model, voice, dataDir, exportKey = '' } = config;
  const deepgramThinkModel = config.deepgramThinkModel ?? 'gpt-4.1-mini';
  const deepgramVoice = config.deepgramVoice ?? 'flux-ayumi-ja';
  const commit = buildCommit(config.buildCommit);
  const recordings = new Recordings(config.recordingsDir ?? join(dataDir ?? join(ROOT, 'data'), 'recordings'));
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

  // A problem with the transcript shouldn't stop the call itself. Returns the key and the session it was made
  // for, so the call log records whether the transcript was dropped.
  async function mintSession(session, userId) {
    try {
      return { clientSecret: await openai.mintClientSecret(session, userId), session };
    } catch (error) {
      console.warn(`Retrying the voice session without a transcript: ${error.message}`);
      const { transcription, ...input } = session.audio.input;
      const withoutTranscript = { ...session, audio: { ...session.audio, input } };
      return { clientSecret: await openai.mintClientSecret(withoutTranscript, userId), session: withoutTranscript };
    }
  }

  // Build, prompt version, and what the engine was actually sent, kept with the call's log entry.
  const recordConfig = (user, callId, setup) => engine.recordConfig(user, callId, { buildCommit: commit, promptVersion: PROMPT_VERSION, ...callConfig(setup) });

  // Codes match ignoring case, spaces, full-width letters from a Japanese keyboard (ＢＥＴＡ is BETA) and dashes of any
  // kind, so "abc-123", "ABC 123" and "abc123" all work. iPhone keyboards don't always type a plain hyphen: the
  // Japanese keyboard's "-" key types the long-vowel mark ー, and others give an en dash or a minus sign.
  const normalCode = (code) => code.normalize('NFKC').replace(/[\s\p{Pd}\u2212\u30fc]/gu, '').toLowerCase();
  const codeNameFor = (given) => Object.entries(inviteCodes).find(([, code]) => code && codesMatch(normalCode(given), normalCode(code)))?.[0] ?? null;

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
      levelChosen: user.levelChosen, // false until they pick a JLPT level, which the app asks for before Home
      name: user.name,
      nameReading: user.nameReading,
      needsOnboarding: needsOnboarding(user), // beta testers and Free users see the two onboarding pages once
      progress: engine.progress(user),
      recentCalls: engine.recentCalls(user),
      hasSubscription: Boolean(user.subscription),
      streak: engine.streak(user),
      lastCall: engine.lastCall(user),
      voicemail: publicVoicemail(user),
      contacts: engine.contacts(user),
      words: user.words,
      sentences: user.sentences,
      calling: engine.calling(user),
      planLimits: PLAN_LIMITS,
      recording: { on: recordsCalls(user), canTurnOff: !recordingLocked(user) },
      policyNotice: policyNoticeFor(user.policyVersion), // null, or what changed since the policy they last saw
      ...(user.role === 'admin' ? { callSetup: { manual: user.callSetupManual, engine: user.engine, turnMode: user.turnMode, engines: ENGINES, randomMix: RANDOM_MIX, topicMode: user.topicMode, scenarioId: user.scenarioId, scenarios: SCENARIOS } } : {}),
    };
  }

  // scenarioId is set only on an admin's controlled test call, so the phone can show its checklist.
  const callState = (call) => ({ id: call.id, state: call.state, contactName: engine.contactNameOf(call), ...(call.scenarioId ? { scenarioId: call.scenarioId } : {}) });

  // A recorded call with enough of the learner's Japanese gets a speaking-level estimate from OpenAI, in the
  // background so the phone isn't kept waiting. Only recorded calls, whose transcript is already kept, are graded.
  function gradeLevel(user, call, lines) {
    if (!openai.hasKey || lines.filter((line) => line.from === 'you').length < MIN_GRADED_TURNS) return;
    if (user.levelEstimates.some((estimate) => estimate.callId === call.id)) return;
    openai
      .gradeLevel(lines)
      .then((estimate) => {
        if (!engine.saveLevelEstimate(user, call.id, estimate)) return;
        recordings.saveLevelEstimate(engine.recordingInfo(user, call), estimate);
      })
      .catch((error) => console.warn(`Level estimate failed: ${error.message}`));
  }

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

    // The data export, for analysis on a laptop (scripts/pull-data.js). It needs EXPORT_KEY, not an account: off when
    // the key isn't set (or is shorter than MIN_EXPORT_KEY_LENGTH), and wrong keys count toward the same per-minute limit
    // as wrong invite codes. Sign-in tokens and push subscriptions are never included.
    const exportRoute = pathname.match(/^\/api\/export(?:\/audio\/([\w-]+))?$/);
    if (method === 'GET' && exportRoute) {
      if (!exportKey || exportKey.length < MIN_EXPORT_KEY_LENGTH) return json(res, 404, { error: 'Not found.' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress;
      if (recentWrongCodes(ip).length >= MAX_WRONG_CODES_PER_MINUTE) return json(res, 429, { error: 'Too many tries. Wait a minute and try again.' });
      const given = String(req.headers['x-export-key'] ?? '');
      if (!given || !codesMatch(given, exportKey)) {
        recordWrongCode(ip);
        return json(res, 403, { error: 'Wrong export key.' });
      }
      if (exportRoute[1]) {
        const audio = recordings.audio(exportRoute[1]);
        if (!audio) return json(res, 404, { error: 'No audio for that call.' });
        res.writeHead(200, { 'Content-Type': audio.type, 'Content-Length': audio.size, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        audio.stream().pipe(res);
        return;
      }
      console.log('data-export');
      return json(res, 200, { exportedAt: Date.now(), buildCommit: commit, promptVersion: PROMPT_VERSION, data: engine.exportData(), recordings: recordings.all() });
    }

    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const user = engine.userForToken(token);
    if (!user) return json(res, 401, { error: 'Please sign in again.' });

    if (method === 'GET' && pathname === '/api/me') return json(res, 200, publicUser(user));

    if (method === 'DELETE' && pathname === '/api/me') {
      for (const contact of user.customContacts) rmSync(voiceMessageFile(contact.id), { force: true });
      recordings.deleteUser(user.id);
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
        // A call keeps the turn mode it was assigned, so a mid-call change only adjusts its timing.
        turnDetection: turnDetection({ thinkingTime: settings.thinkingTime, speed: settings.speed, turnMode: engine.liveTurnMode(user) ?? 'silence' }),
        smartTurn: smartTurnRules(settings.thinkingTime),
        // On Deepgram, a mid-call change updates Flux's patience and the voice's speed.
        agent: { listen: agentListen(settings), speak: agentSpeak(settings, deepgramVoice) },
      });
    }

    if (method === 'POST' && pathname === '/api/test-ring') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      engine.requestTestRing(user);
      return json(res, 202, {});
    }

    if (method === 'PUT' && pathname === '/api/recording') {
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') return json(res, 400, { error: 'Invalid request.' });
      if (!engine.setRecording(user, on)) return json(res, 403, { error: 'Recording is part of testing, so it stays on for this account.' });
      return json(res, 200, { recording: { on: recordsCalls(user), canTurnOff: true } });
    }

    if (method === 'POST' && pathname === '/api/policy/seen') {
      engine.acknowledgePolicy(user);
      return json(res, 200, {});
    }

    if (method === 'GET' && pathname === '/api/admin/recordings') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      return json(res, 200, { recordings: recordings.list() });
    }

    const recordingRoute = pathname.match(/^\/api\/admin\/recordings\/([\w-]+)(\/audio)?$/);
    if (method === 'GET' && recordingRoute) {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      if (!recordingRoute[2]) {
        const found = recordings.find(recordingRoute[1]);
        return found ? json(res, 200, found) : json(res, 404, { error: 'Recording not found.' });
      }
      const audio = recordings.audio(recordingRoute[1]);
      if (!audio) return json(res, 404, { error: 'Recording not found.' });
      res.writeHead(200, { 'Content-Type': audio.type, 'Content-Length': audio.size, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      audio.stream().pipe(res);
      return;
    }

    // An admin deletes everything kept about one call, its recording included. Nothing else ever deletes
    // admin and beta testers' calls.
    const deleteCallRoute = pathname.match(/^\/api\/admin\/calls\/([\w-]+)$/);
    if (method === 'DELETE' && deleteCallRoute) {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      const deletedRecording = recordings.deleteCall(deleteCallRoute[1]);
      const deletedData = engine.deleteCallData(deleteCallRoute[1]);
      if (!deletedRecording && !deletedData) return json(res, 404, { error: 'Call not found.' });
      return json(res, 200, {});
    }

    // How full the disk is, so the admin knows when recordings need to move to cloud storage.
    if (method === 'GET' && pathname === '/api/admin/storage') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      return json(res, 200, diskUsage({ dataDir, recordingsBytes: recordings.bytes() }));
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

    // The learner's name, and how Ping says it, from onboarding or Manage Account.
    if (method === 'PUT' && pathname === '/api/profile') {
      const body = await readJson(req);
      if (!engine.setProfile(user, body)) return json(res, 400, { error: 'Please write your name, and its reading in katakana or hiragana.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'POST' && pathname === '/api/onboarding/done') {
      if (!engine.finishOnboarding(user)) return json(res, 400, { error: 'Please add your name and choose your level first.' });
      return json(res, 200, publicUser(user));
    }

    // Suggests how Ping should say their name, and lets them hear it in Ping's voice. Both count as lookups.
    if (method === 'POST' && pathname === '/api/name/reading') {
      const name = cleanName((await readJson(req)).name);
      if (!name) return json(res, 400, { error: 'Please write your name first.' });
      engine.countLookup(user);
      const reading = cleanReading(await openai.nameReading(name));
      return json(res, 200, { reading });
    }
    if (method === 'POST' && pathname === '/api/name/hear') {
      const reading = cleanReading((await readJson(req)).reading);
      if (!reading) return json(res, 400, { error: 'Write how to say your name in katakana or hiragana.' });
      engine.countLookup(user);
      const audio = await openai.speak(`${reading}さん、こんにちは！`, voice);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(audio);
      return;
    }

    if (method === 'PUT' && pathname === '/api/plan') {
      if (user.role !== 'admin') return json(res, 403, { error: "Plans can't be changed during the beta." });
      const body = await readJson(req);
      if (!engine.setPlan(user, body.plan)) return json(res, 400, { error: 'That plan was not recognized.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'PUT' && pathname === '/api/call-setup') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      const body = await readJson(req);
      if (!engine.setCallSetup(user, body)) return json(res, 400, { error: 'That engine and turn mode were not recognized.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'PUT' && pathname === '/api/topic-setup') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      const body = await readJson(req);
      if (!engine.setTopicSetup(user, body)) return json(res, 400, { error: 'That topic mode and scenario were not recognized.' });
      return json(res, 200, publicUser(user));
    }

    if (method === 'GET' && pathname === '/api/admin/calls') {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      return json(res, 200, { calls: engine.callLog(), scenarioChecks: engine.scenarioChecks(), comments: engine.callComments() });
    }

    const checkRoute = pathname.match(/^\/api\/admin\/calls\/([\w-]+)\/checks$/);
    if (method === 'PUT' && checkRoute) {
      if (user.role !== 'admin') return json(res, 403, { error: 'This is only for admins.' });
      const body = await readJson(req);
      const saved = engine.saveScenarioCheck(user, checkRoute[1], { checkpointId: body.checkpointId, result: body.result ?? null });
      if (saved === null) return json(res, 404, { error: 'No test scenario call found.' });
      if (!saved) return json(res, 400, { error: 'That checkpoint and result were not recognized.' });
      return json(res, 200, { ok: true });
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

    // The words with kanji in a saved sentence. Worked out once, then kept with the sentence.
    const sentenceWordsRoute = pathname.match(/^\/api\/stack\/sentences\/([\w-]+)\/words$/);
    if (method === 'POST' && sentenceWordsRoute) {
      const found = engine.sentenceWords(user, sentenceWordsRoute[1]);
      if (!found) return json(res, 404, { error: 'Sentence not found.' });
      if (found.words) return json(res, 200, { words: found.words });
      if (!openai.hasKey) return json(res, 503, { error: 'Looking up words is not set up yet.' });
      engine.countLookup(user, "That's all the lookups for today. Try again tomorrow.");
      const words = engine.keepSentenceWords(user, sentenceWordsRoute[1], await openai.sentenceWords(found.sentence.japanese));
      return json(res, 200, { words });
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
      // Why it ended, as the phone saw it. A call that broke straight away doesn't use up a call (see endCall).
      const { reason } = await readJson(req);
      if (!engine.endCall(user, ended[1], typeof reason === 'string' ? reason : null)) return json(res, 404, { error: 'Call not found.' });
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

    // One call's details for the Calls tab.
    const detailsRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/details$/);
    if (method === 'GET' && detailsRoute) {
      const details = engine.callDetails(user, detailsRoute[1]);
      return details ? json(res, 200, details) : json(res, 404, { error: 'Call not found.' });
    }

    // GPT-Live: the phone's WebRTC offer goes to OpenAI with the call's session, and OpenAI's answer comes back.
    // If GPT-Live can't start a randomly assigned call, the call falls back and the phone starts again on OpenAI.
    const liveRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/live$/);
    if (method === 'POST' && liveRoute) {
      const call = engine.store.calls[liveRoute[1]];
      const live = pendingLive.get(liveRoute[1]);
      if (!call || call.userId !== user.id || !live) return json(res, 404, { error: 'Call not found.' });
      const { sdp } = await readJson(req);
      if (typeof sdp !== 'string' || !sdp.startsWith('v=')) return json(res, 400, { error: 'Invalid offer.' });
      try {
        const answer = await openai.createLiveSession(live, sdp, user.id);
        pendingLive.delete(liveRoute[1]);
        return json(res, 200, { sdp: answer.sdp });
      } catch (error) {
        if (call.assigned === 'manual') return json(res, 503, { error: error.message });
        console.warn(`GPT-Live couldn't start a call, so it fell back to OpenAI: ${error.message}`);
        pendingLive.delete(liveRoute[1]);
        engine.fallBack(user, liveRoute[1]);
        return json(res, 409, { error: 'GPT-Live is unavailable.', fallback: true });
      }
    }

    // Which saved words came back, were used, or were asked about again on the call: word ids only.
    const wordsRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/words$/);
    if (method === 'POST' && wordsRoute) {
      const body = await readJson(req);
      const ids = (list) => (Array.isArray(list) && list.length <= 500 && list.every((id) => typeof id === 'string' && id.length <= 64) ? list : null);
      const [cameBack, used, lookedUp] = [ids(body.cameBack ?? []), ids(body.used ?? []), ids(body.lookedUp ?? [])];
      if (!cameBack || !used || !lookedUp) return json(res, 400, { error: 'Invalid word events.' });
      const events = engine.saveWordEvents(user, wordsRoute[1], { cameBack, used, lookedUp });
      if (!events) return json(res, 404, { error: 'Call not found.' });
      return json(res, 201, { events });
    }

    // Each reply's timing and each request for help, by type: numbers and type names only, like the timing summary.
    const turnsRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/turns$/);
    if (method === 'POST' && turnsRoute) {
      const data = cleanTurnData(await readJson(req));
      if (!data) return json(res, 400, { error: 'Invalid turn records.' });
      if (!engine.saveTurns(user, turnsRoute[1], data)) return json(res, 404, { error: 'Call not found.' });
      return json(res, 201, {});
    }

    // Numbers about the learner's Japanese, worked out on the phone from the call's transcript. Every user's are
    // accepted, like the timing numbers, since no words come with them.
    const learningRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/learning$/);
    if (method === 'POST' && learningRoute) {
      const learning = cleanLearning(await readJson(req));
      if (!learning) return json(res, 400, { error: 'Invalid learning numbers.' });
      if (!engine.saveLearning(user, learningRoute[1], learning)) return json(res, 404, { error: 'Call not found.' });
      return json(res, 201, {});
    }

    // The phone sends a transcript after every recorded call, and after every call on a paid plan.
    // A paid plan keeps it to personalize later calls; a recorded call keeps it for review.
    const transcript = pathname.match(/^\/api\/calls\/([\w-]+)\/transcript$/);
    if (method === 'POST' && transcript) {
      const { lines } = await readJson(req);
      const recordedCall = engine.recordedCall(user, transcript[1]);
      const kept = cleanTranscript(lines).slice(-MAX_RECORDED_LINES);
      const recorded = recordedCall ? recordings.saveTranscript(engine.recordingInfo(user, recordedCall), kept) : false;
      if (recorded) gradeLevel(user, recordedCall, kept);
      return json(res, 200, { saved: engine.saveConversation(user, transcript[1], lines), recorded });
    }

    // The two 1-5 taps after a call. Numbers only, like the timing numbers.
    const ratingRoute = pathname.match(/^\/api\/calls\/([\w-]+)\/rating$/);
    if (method === 'POST' && ratingRoute) {
      const body = await readJson(req);
      const rating = cleanRating(body);
      if (!rating) return json(res, 400, { error: 'Ratings are whole numbers from 1 to 5.' });
      const comment = cleanComment(body.comment);
      const record = engine.saveRating(user, ratingRoute[1], rating, comment);
      if (!record) return json(res, 404, { error: 'Call not found.' });
      const recordedCall = engine.recordedCall(user, ratingRoute[1]);
      if (recordedCall) recordings.saveRating(engine.recordingInfo(user, recordedCall), { ...rating, comment });
      // The server log gets the numbers only, never the comment's words.
      console.log(`call-rating ${JSON.stringify({ ...record, comment: undefined, commented: Boolean(comment) })}`);
      return json(res, 201, {});
    }

    // The call's audio, both voices, uploaded by the phone after a recorded call.
    const recordingUpload = pathname.match(/^\/api\/calls\/([\w-]+)\/recording$/);
    if (method === 'POST' && recordingUpload) {
      const recordedCall = engine.recordedCall(user, recordingUpload[1]);
      if (!recordedCall) return json(res, 404, { error: 'This call is not being recorded.' });
      const extension = audioExtension(req.headers['content-type']);
      if (!extension) return json(res, 415, { error: 'Unsupported audio format.' });
      let audio;
      try {
        audio = await readBody(req, MAX_RECORDING_BYTES);
      } catch (error) {
        if (error instanceof TooLargeError) return json(res, 413, { error: 'The recording is too large.' });
        throw error;
      }
      if (!audio.length) return json(res, 400, { error: 'The recording is empty.' });
      recordings.saveAudio(engine.recordingInfo(user, recordedCall), audio, extension);
      return json(res, 201, {});
    }

    const heard = pathname.match(/^\/api\/messages\/([\w-]+)\/heard$/);
    if (method === 'POST' && heard) {
      return json(res, engine.markHeard(user, heard[1]) ? 200 : 404, {});
    }

    const session = pathname.match(/^\/api\/calls\/([\w-]+)\/session$/);
    if (method === 'POST' && session) {
      const details = engine.sessionDetails(user, session[1]);
      if (!details) return json(res, 409, { error: 'This call has ended.' });
      const hangUpLines = details.calledBack ? [] : Object.values(NOT_NOW_GOODBYES);
      let agentToken = null;
      // ElevenLabs: a signed URL for this call, or the fallback when it can't start.
      let signedUrl = null;
      if (details.engine === 'elevenlabs') {
        const manual = engine.store.calls[session[1]]?.assigned === 'manual';
        try {
          if (!elevenlabs.hasKey) throw new Error('ElevenLabs is not set up yet.');
          signedUrl = await elevenlabs.signedUrl();
        } catch (error) {
          if (manual) return json(res, 503, { error: error.message });
          console.warn(`ElevenLabs couldn't start a call, so it fell back to OpenAI: ${error.message}`);
          Object.assign(details, engine.fallBack(user, session[1]));
        }
      }
      if (details.engine === 'elevenlabs') {
        const overrides = elevenOverrides(details);
        recordConfig(user, session[1], { session: { type: 'elevenlabs', llm: elevenLlm, overrides } });
        return json(res, 200, { engine: details.engine, signedUrl, overrides, timeUpNote: TIME_UP_NOTE, maxSeconds: details.maxSeconds, hangUpLines, question: details.question, turnMode: null });
      }
      // GPT-Live: the session is created once the phone sends its WebRTC offer (POST /api/calls/:id/live).
      if (details.engine === 'gpt-live') {
        if (!openai.hasKey) return json(res, 503, { error: 'The voice engine is not set up yet.' });
        const live = liveSession({ ...details, model: liveModel, voice: liveVoice, backendModel: liveBackendModel });
        pendingLive.set(session[1], live);
        recordConfig(user, session[1], { session: live });
        return json(res, 200, { engine: details.engine, timeUpNote: TIME_UP_NOTE, maxSeconds: details.maxSeconds, hangUpLines, question: details.question, turnMode: null });
      }
      if (details.engine === 'deepgram-agent') {
        const manual = engine.store.calls[session[1]]?.assigned === 'manual';
        try {
          if (!deepgram.hasKey) throw new Error('Deepgram is not set up yet.');
          agentToken = await deepgram.mintToken();
        } catch (error) {
          // An admin who picked Deepgram should see why. Anyone else just gets the call, on the fallback.
          if (manual) return json(res, 503, { error: error.message });
          console.warn(`Deepgram couldn't start a call, so it fell back to OpenAI: ${error.message}`);
          Object.assign(details, engine.fallBack(user, session[1]));
        }
      }
      if (details.engine === 'deepgram-agent') {
        const settings = agentSettings({ ...details, thinkModel: deepgramThinkModel, voice: deepgramVoice });
        recordConfig(user, session[1], { session: settings });
        return json(res, 200, {
          engine: details.engine,
          token: agentToken,
          agentUrl: AGENT_URL,
          settings,
          timeUpLine: TIME_UP_LINES[details.settings.formality === 'casual' ? 'casual' : 'formal'],
          maxSeconds: details.maxSeconds,
          hangUpLines,
          question: details.question,
          turnMode: null,
        });
      }
      if (!openai.hasKey) return json(res, 503, { error: 'The voice engine is not set up yet.' });
      const smartTurn = smartTurnRules(details.settings.thinkingTime);
      const { clientSecret, session: minted } = await mintSession(buildSession({ model, voice, ...details }), user.id);
      recordConfig(user, session[1], { session: minted, smartTurn: details.turnMode === 'smartTurn' ? smartTurn : null });
      return json(res, 200, {
        clientSecret,
        sdpUrl: openai.sdpUrl,
        maxSeconds: details.maxSeconds,
        hangUpLines,
        question: details.question,
        engine: details.engine,
        turnMode: details.turnMode,
        smartTurn,
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
  const engine = new CallEngine({
    store,
    sendPush,
    dailyCallLimit: Number(process.env.DAILY_CALL_LIMIT) || null,
    // An engine joins the random mix only on a server with its keys.
    engineReady: (name) =>
      ({
        'deepgram-agent': Boolean(process.env.DEEPGRAM_API_KEY),
        'gpt-live': Boolean(process.env.OPENAI_API_KEY),
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID),
      })[name] ?? true,
  });
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '', baseUrl: process.env.OPENAI_BASE_URL, textModel: process.env.TEXT_MODEL, levelModel: process.env.LEVEL_MODEL });
  const deepgram = createDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY ?? '' });
  const elevenlabs = createElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY ?? '', agentId: process.env.ELEVENLABS_AGENT_ID ?? '' });
  const { server, ensureVoiceMessage } = createApp({
    engine,
    openai,
    elevenlabs,
    deepgram,
    config: {
      buildCommit: process.env.RENDER_GIT_COMMIT,
      deepgramThinkModel: process.env.DEEPGRAM_THINK_MODEL,
      deepgramVoice: process.env.DEEPGRAM_VOICE,
      liveModel: process.env.GPT_LIVE_MODEL,
      liveVoice: process.env.GPT_LIVE_VOICE,
      liveBackendModel: process.env.GPT_LIVE_BACKEND_MODEL,
      elevenLlm: process.env.ELEVENLABS_LLM,
      inviteCodes: {
        admin: process.env.ADMIN_INVITE_CODE ?? '',
        beta: process.env.BETA_INVITE_CODE ?? '',
        yc: process.env.YC_INVITE_CODE ?? '',
        free: process.env.FREE_INVITE_CODE ?? '', // everyone else: Free, until sign-up opens
      },
      vapidPublicKey: VAPID_PUBLIC_KEY,
      exportKey: process.env.EXPORT_KEY ?? '',
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
    if (!process.env.ADMIN_INVITE_CODE && !process.env.BETA_INVITE_CODE && !process.env.YC_INVITE_CODE) {
      console.warn('No invite codes are set, so no one can join. Set ADMIN_INVITE_CODE (and BETA_INVITE_CODE or YC_INVITE_CODE) in .env.');
    }
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
