import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { CallEngine } from '../server/calls.js';
import { silenceMs } from '../server/settings.js';
import { Store } from '../server/store.js';

const SUBSCRIPTION = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };
const INVITE_CODE = 'test-invite';
const BETA_CODE = 'test-beta';

let baseUrl;
let server;
let engine;
const minted = [];
const openai = {
  hasKey: true,
  sdpUrl: 'https://voice.example/calls',
  mintClientSecret: async (session, userId) => {
    minted.push({ session, userId });
    return 'ek_test';
  },
  speak: async () => Buffer.from('audio'),
  exampleSentences: async () => [{ japanese: '元気です。', romaji: 'genki desu.', english: "I'm well." }],
};

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
}

const join = async () => (await request('/api/register', { method: 'POST', body: { inviteCode: INVITE_CODE, timeZone: 'Asia/Tokyo' } })).data.token;

before(async () => {
  engine = new CallEngine({ store: new Store(), sendPush: async () => ({ gone: false }) });
  ({ server } = createApp({ engine, openai, config: { inviteCodes: { admin: INVITE_CODE, beta: BETA_CODE }, vapidPublicKey: 'public', model: 'gpt-realtime', voice: 'marin', dataDir: null } }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('joining needs the right invite code and a real time zone', async () => {
  assert.equal((await request('/api/register', { method: 'POST', body: { inviteCode: 'wrong', timeZone: 'Asia/Tokyo' } })).status, 403);
  assert.equal((await request('/api/register', { method: 'POST', body: { inviteCode: INVITE_CODE, timeZone: 'Mars/Base' } })).status, 400);
  assert.ok(await join());
});

test('repeated wrong invite codes are blocked, without counting good ones', async () => {
  const { server: limited } = createApp({ engine, openai, config: { inviteCodes: { admin: INVITE_CODE, beta: BETA_CODE }, vapidPublicKey: 'public', model: 'm', voice: 'v', dataDir: null } });
  await new Promise((resolve) => limited.listen(0, resolve));
  const attempt = async (inviteCode) => {
    const response = await fetch(`http://127.0.0.1:${limited.address().port}/api/register`, {
      method: 'POST',
      body: JSON.stringify({ inviteCode, timeZone: 'Asia/Tokyo' }),
    });
    return response.status;
  };
  for (let index = 0; index < 15; index += 1) assert.equal(await attempt(INVITE_CODE), 201);
  for (let index = 0; index < 10; index += 1) assert.equal(await attempt('wrong'), 403);
  assert.equal(await attempt('wrong'), 429);
  assert.equal(await attempt(INVITE_CODE), 429);
  limited.close();
});

test('sign-ups are closed when no invite code is configured', async () => {
  const { server: closed } = createApp({ engine, openai, config: { inviteCodes: { admin: '', beta: '' }, vapidPublicKey: 'public', model: 'm', voice: 'v', dataDir: null } });
  await new Promise((resolve) => closed.listen(0, resolve));
  const response = await fetch(`http://127.0.0.1:${closed.address().port}/api/register`, {
    method: 'POST',
    body: JSON.stringify({ inviteCode: '', timeZone: 'Asia/Tokyo' }),
  });
  closed.close();
  assert.equal(response.status, 503);
});

test('user routes need a valid token', async () => {
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await request('/api/calls', { method: 'POST', token: 'nope' })).status, 401);
});

test('the OpenAI key route never returns the server key, only a short-lived one', async () => {
  const token = await join();
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  const { status, data } = await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  assert.equal(status, 200);
  assert.equal(data.clientSecret, 'ek_test');
  assert.equal(data.sdpUrl, openai.sdpUrl);
  assert.equal(minted.at(-1).session.audio.output.speed, 0.9);
});

test('the invite codes never reach the browser', async () => {
  const { data: config } = await request('/api/config');
  assert.ok(!JSON.stringify(config).includes(INVITE_CODE));
  for (const file of ['/', '/app.js', '/lib.js', '/settings.js', '/contacts.js']) {
    const text = await (await fetch(baseUrl + file)).text();
    assert.ok(!text.includes('minabystella_admin_only') && !text.includes('beta-01'), file);
  }
});

test('someone else cannot start a voice session on your call', async () => {
  const [owner, stranger] = [await join(), await join()];
  const { data: call } = await request('/api/calls', { method: 'POST', token: owner });
  assert.equal((await request(`/api/calls/${call.id}/session`, { method: 'POST', token: stranger })).status, 409);
});

test('settings changes return what the live call needs', async () => {
  const token = await join();
  const { data } = await request('/api/settings', { method: 'PATCH', token, body: { speedChange: 'slower', thinkingTime: 'long' } });
  assert.equal(data.settings.speed, 0.75);
  assert.equal(data.turnDetection.silence_duration_ms, silenceMs('long', 0.75));
});

test('push subscriptions are validated', async () => {
  const token = await join();
  assert.equal((await request('/api/push', { method: 'PUT', token, body: { subscription: { endpoint: 'http://insecure' } } })).status, 400);
  const { status, data } = await request('/api/push', { method: 'PUT', token, body: { subscription: SUBSCRIPTION, timeZone: 'Asia/Tokyo' } });
  assert.equal(status, 200);
  assert.equal(data.hasSubscription, true);
});

test('the service worker routes work for a real call and fail for an unknown one', async () => {
  const token = await join();
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  assert.equal((await request(`/api/calls/${call.id}/answer`, { method: 'POST' })).data.state, 'answered');
  assert.equal((await request('/api/calls/not-a-call/answer', { method: 'POST' })).status, 404);
});

test('a broken JSON body gets a 400, not a crash', async () => {
  const token = await join();
  const response = await fetch(`${baseUrl}/api/settings`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: '{nope' });
  assert.equal(response.status, 400);
});

test('deleting an account ends access', async () => {
  const token = await join();
  assert.equal((await request('/api/me', { method: 'DELETE', token })).status, 200);
  assert.equal((await request('/api/me', { token })).status, 401);
});

test('static files are served with a strict content policy, and nothing outside public', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/api\.openai\.com/);
  assert.equal((await fetch(`${baseUrl}/sw.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/%2e%2e/server/index.js`)).status, 404);
});

test('pages are cross-origin isolated and allow WebAssembly, so Smart Turn can use several threads', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
});

test("Smart Turn's files are served compressed, with the right types, and kept by the browser for good", async () => {
  const runtime = await fetch(`${baseUrl}/vendor/onnxruntime-web-1.30.0/ort-wasm-simd-threaded.wasm`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(runtime.status, 200);
  assert.equal(runtime.headers.get('content-type'), 'application/wasm');
  assert.equal(runtime.headers.get('content-encoding'), 'br');
  assert.match(runtime.headers.get('cache-control'), /immutable/);
  const bytes = new Uint8Array(await runtime.arrayBuffer()); // fetch undoes the compression
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'a WebAssembly file');

  const model = await fetch(`${baseUrl}/models/silero-vad-2026-10.onnx`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(model.headers.get('content-encoding'), null);
  assert.equal(Number(model.headers.get('content-length')), (await model.arrayBuffer()).byteLength);
  assert.equal((await fetch(`${baseUrl}/vendor/onnxruntime-web-1.30.0/ort.wasm.min.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${baseUrl}/models/LICENSE-smart-turn`)).status, 404, 'files without a known type stay private');
});

const WORD = { kanji: '元気', kana: 'げんき', romaji: 'genki', english: 'healthy, well' };

test('a word can be added on any plan, but only subscribers can remove it', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  assert.equal(data.added, true);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: WORD })).data.added, false);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: { kana: 'hello', romaji: 'x', english: 'y' } })).status, 400);
  assert.equal((await request(`/api/stack/words/${data.word.id}`, { method: 'DELETE', token })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'premium' } });
  const removed = await request(`/api/stack/words/${data.word.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.words, []);
});

test('example sentences need a subscription, and are only saved on request', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  const path = `/api/stack/words/${data.word.id}/examples`;
  assert.equal((await request(path, { method: 'POST', token })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'premium' } });
  const { data: examples } = await request(path, { method: 'POST', token });
  assert.equal(examples.sentences.length, 1);
  assert.deepEqual((await request('/api/me', { token })).data.sentences, []);

  const { romaji, ...withoutRomaji } = examples.sentences[0];
  assert.equal(romaji, 'genki desu.');
  assert.equal((await request('/api/stack/sentences', { method: 'POST', token, body: { ...withoutRomaji, word: '元気' } })).status, 400);

  const saved = await request('/api/stack/sentences', { method: 'POST', token, body: { ...examples.sentences[0], word: '元気' } });
  assert.equal(saved.data.sentences.length, 1);
  assert.equal(saved.data.sentences[0].romaji, 'genki desu.');
  const removed = await request(`/api/stack/sentences/${saved.data.sentences[0].id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
});

test('Ping is the only built-in contact while Mero is hidden, and only Platinum can create more', async () => {
  const token = await join();
  const { data: free } = await request('/api/me', { token });
  assert.deepEqual(free.contacts.map(({ id, available }) => [id, available]), [['ping', true]]);
  assert.equal((await request('/api/calls', { method: 'POST', token, body: { contactId: 'mero' } })).status, 403);
  assert.equal((await request('/api/contact', { method: 'PUT', token, body: { contactId: 'mero' } })).status, 404);
  const yukiDetails = { name: 'Yuki', topic: 'cooking', voice: 'cedar' };
  assert.equal((await request('/api/contacts', { method: 'POST', token, body: yukiDetails })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'premium' } });
  assert.equal((await request('/api/contacts', { method: 'POST', token, body: yukiDetails })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'platinum' } });
  assert.equal((await request('/api/contacts', { method: 'POST', token, body: { name: '', topic: 'x', voice: 'cedar' } })).status, 400);
  const { data: platinum } = await request('/api/contacts', { method: 'POST', token, body: yukiDetails });
  const yuki = platinum.contacts.find((contact) => contact.name === 'Yuki');
  assert.equal((await request('/api/contact', { method: 'PUT', token, body: { contactId: yuki.id } })).data.contacts.find((contact) => contact.selected).id, yuki.id);

  const { data: call } = await request('/api/calls', { method: 'POST', token, body: { contactId: yuki.id } });
  assert.equal(call.contactName, 'Yuki');
  await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  assert.equal(minted.at(-1).session.audio.output.voice, 'cedar');

  const { data: downgraded } = await request('/api/plan', { method: 'PUT', token, body: { plan: 'free' } });
  assert.equal(downgraded.contacts.find((contact) => contact.selected).id, 'ping');
  assert.ok(downgraded.clearAt);
  assert.equal((await request('/api/calls', { method: 'POST', token, body: { contactId: yuki.id } })).status, 403);
});

test('the invite code decides the role, and beta testers cannot switch plans or test-ring', async () => {
  const signUp = (inviteCode) => request('/api/register', { method: 'POST', body: { inviteCode, timeZone: 'Asia/Tokyo' } });
  const { data: admin } = await signUp(INVITE_CODE);
  const { data: beta } = await signUp(BETA_CODE);
  assert.equal(admin.role, 'admin');
  assert.equal(beta.role, 'beta');
  assert.equal(beta.plan, 'free');

  assert.equal((await request('/api/plan', { method: 'PUT', token: beta.token, body: { plan: 'platinum' } })).status, 403);
  assert.equal((await request('/api/me', { token: beta.token })).data.plan, 'free');
  assert.equal((await request('/api/test-ring', { method: 'POST', token: beta.token })).status, 403);

  assert.equal((await request('/api/plan', { method: 'PUT', token: admin.token, body: { plan: 'platinum' } })).status, 200);
  await request('/api/push', { method: 'PUT', token: admin.token, body: { subscription: SUBSCRIPTION, timeZone: 'Asia/Tokyo' } });
  assert.equal((await request('/api/test-ring', { method: 'POST', token: admin.token })).status, 202);
});

test('a connected call counts toward the streak', async () => {
  const token = await join();
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  const { data } = await request(`/api/calls/${call.id}/connected`, { method: 'POST', token });
  assert.equal(data.streak.current, 1);
  assert.equal(data.streak.best, 1);
});

test('conversations are only kept on a paid plan, and shape later calls', async () => {
  const token = await join();
  const lines = [{ from: 'contact', text: '今日は何をしましたか？' }, { from: 'you', text: 'ラーメンを食べました' }];
  const first = (await request('/api/calls', { method: 'POST', token })).data;
  assert.equal((await request(`/api/calls/${first.id}/transcript`, { method: 'POST', token, body: { lines } })).data.saved, false);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'premium' } });
  const second = (await request('/api/calls', { method: 'POST', token })).data;
  assert.equal((await request(`/api/calls/${second.id}/transcript`, { method: 'POST', token, body: { lines } })).data.saved, true);
  const third = (await request('/api/calls', { method: 'POST', token })).data;
  await request(`/api/calls/${third.id}/session`, { method: 'POST', token });
  assert.match(minted.at(-1).session.instructions, /ラーメンを食べました/);
});

test('a transcript problem does not stop the call', async () => {
  const realMint = openai.mintClientSecret;
  const warn = console.warn;
  console.warn = () => {};
  const sessions = [];
  openai.mintClientSecret = async (session) => {
    sessions.push(session);
    if (session.audio.input.transcription) throw new Error('bad transcription model');
    return 'ek_retry';
  };
  try {
    const token = await join();
    const { data: call } = await request('/api/calls', { method: 'POST', token });
    const { status, data } = await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
    assert.equal(status, 200);
    assert.equal(data.clientSecret, 'ek_retry');
    assert.equal(sessions.length, 2);
    assert.ok(sessions[1].audio.input.turn_detection);
  } finally {
    openai.mintClientSecret = realMint;
    console.warn = warn;
  }
});

test('feedback is kept without saying who sent it', async () => {
  const token = await join();
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal((await request('/api/feedback', { method: 'POST', token, body: { text: '  ' } })).status, 400);
    assert.equal((await request('/api/feedback', { method: 'POST', token, body: { text: 'Love it' } })).status, 201);
  } finally {
    console.log = log;
  }
  assert.deepEqual(Object.keys(engine.store.feedback[0]).sort(), ['at', 'text']);
  assert.equal(engine.store.feedback[0].text, 'Love it');
});

test('plans are checked', async () => {
  const token = await join();
  assert.equal((await request('/api/plan', { method: 'PUT', token, body: { plan: 'free-forever' } })).status, 400);
});

const METRICS = {
  replyLatencyMedianMs: 640,
  replyLatencyP90Ms: 910,
  replyLatencyCount: 4,
  suspectedCutoffs: 1,
  bargeIns: 0,
  ignoredAizuchi: 0,
  userTurns: 5,
  agentTurns: 6,
  callSeconds: 95,
  turnEndWaitMedianMs: 1290,
  turnEndWaitP90Ms: 1400,
  replyGapMedianMs: 1900,
  replyGapP90Ms: 2300,
  smartTurnEnds: 0,
  backupEnds: 0,
  smartTurnMedianMs: null,
  smartTurnP90Ms: null,
  modelLoadMs: null,
  smartTurnFallback: 0,
  audioRestarts: 0,
};

test('turn metrics are stored on the call with their settings, and logged once', async () => {
  const token = await join();
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    assert.equal((await request(`/api/calls/${call.id}/metrics`, { method: 'POST', token, body: METRICS })).status, 201);
  } finally {
    console.log = log;
  }
  const stored = engine.store.calls[call.id].turnMetrics;
  assert.deepEqual(stored, { callId: call.id, ...METRICS, turnMode: 'silence', thinkingTime: 'normal', speed: 0.9, proficiency: 'beginner' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^turn-metrics \{/);
  assert.deepEqual(JSON.parse(lines[0].slice('turn-metrics '.length)), stored);
});

test('turn metrics must be the known numbers, for the user\'s own call', async () => {
  const [owner, stranger] = [await join(), await join()];
  const { data: call } = await request('/api/calls', { method: 'POST', token: owner });
  const path = `/api/calls/${call.id}/metrics`;
  for (const body of [{ ...METRICS, transcript: 'こんにちは' }, { ...METRICS, bargeIns: 'two' }, { ...METRICS, userTurns: -1 }, {}]) {
    assert.equal((await request(path, { method: 'POST', token: owner, body })).status, 400, JSON.stringify(body));
  }
  assert.equal(engine.store.calls[call.id].turnMetrics, undefined);
  assert.equal((await request(path, { method: 'POST', token: stranger, body: METRICS })).status, 404);
  assert.equal((await request('/api/calls/not-a-call/metrics', { method: 'POST', token: owner, body: METRICS })).status, 404);
  assert.equal((await request(path, { method: 'POST', body: METRICS })).status, 401);
});

test('only admins can change the turn mode, and it reaches the call, mid-call changes and metrics', async () => {
  const signUp = async (inviteCode) => (await request('/api/register', { method: 'POST', body: { inviteCode, timeZone: 'Asia/Tokyo' } })).data;
  const beta = await signUp(BETA_CODE);
  assert.equal(beta.turnMode, 'silence');
  assert.equal((await request('/api/turn-mode', { method: 'PUT', token: beta.token, body: { turnMode: 'semantic' } })).status, 403);
  assert.equal((await request('/api/me', { token: beta.token })).data.turnMode, 'silence');

  const { token } = await signUp(INVITE_CODE);
  assert.equal((await request('/api/turn-mode', { method: 'PUT', token, body: { turnMode: 'psychic' } })).status, 400);
  const { status, data } = await request('/api/turn-mode', { method: 'PUT', token, body: { turnMode: 'semantic' } });
  assert.equal(status, 200);
  assert.equal(data.turnMode, 'semantic');

  const { data: call } = await request('/api/calls', { method: 'POST', token });
  await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  assert.deepEqual(minted.at(-1).session.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: true });

  const { data: changed } = await request('/api/settings', { method: 'PATCH', token, body: { thinkingTime: 'short' } });
  assert.equal(changed.turnDetection.type, 'semantic_vad');
  assert.equal(changed.turnDetection.eagerness, 'medium');

  const log = console.log;
  console.log = () => {};
  try {
    await request(`/api/calls/${call.id}/metrics`, { method: 'POST', token, body: METRICS });
  } finally {
    console.log = log;
  }
  assert.equal(engine.store.calls[call.id].turnMetrics.turnMode, 'semantic');
});

test('a Smart Turn call starts in silence mode, and the phone is told to take over', async () => {
  const { token } = (await request('/api/register', { method: 'POST', body: { inviteCode: INVITE_CODE, timeZone: 'Asia/Tokyo' } })).data;
  assert.equal((await request('/api/turn-mode', { method: 'PUT', token, body: { turnMode: 'smartTurn' } })).data.turnMode, 'smartTurn');
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  const { data: session } = await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  assert.equal(session.turnMode, 'smartTurn');
  assert.equal(minted.at(-1).session.audio.input.turn_detection.type, 'server_vad');
  assert.deepEqual(session.smartTurn, { doneAt: 0.5, backupMs: 2500 }, 'normal time to answer, as Smart Turn was benchmarked');
  const { data: changed } = await request('/api/settings', { method: 'PATCH', token, body: { thinkingTime: 'long' } });
  assert.equal(changed.turnDetection.type, 'server_vad', 'the silence settings to switch back to');
  assert.deepEqual(changed.smartTurn, { doneAt: 0.7, backupMs: 4000 }, 'a long time to answer makes Smart Turn more patient too');
});
