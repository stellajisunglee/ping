import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { CallEngine } from '../server/calls.js';
import { silenceMs } from '../server/settings.js';
import { Store } from '../server/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const SUBSCRIPTION = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };
const INVITE_CODE = 'test-invite';
const BETA_CODE = 'test-beta';
const YC_CODE = 'YC-Demo';

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
  sentenceWordLookups: 0,
  async sentenceWords() {
    this.sentenceWordLookups += 1;
    return [
      { asWritten: '会議', kanji: '会議', kana: 'かいぎ', romaji: 'kaigi', english: 'meeting' },
      { asWritten: '始まります', kanji: '始まる', kana: 'はじまる', romaji: 'hajimaru', english: 'to start' },
      { asWritten: 'から', kanji: 'から', kana: 'から', romaji: 'kara', english: 'from' },
    ];
  },
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
  ({ server } = createApp({ engine, openai, config: { inviteCodes: { admin: INVITE_CODE, beta: BETA_CODE, yc: YC_CODE }, vapidPublicKey: 'public', model: 'gpt-realtime', voice: 'marin', dataDir: null, recordingsDir: mkdtempSync(joinPath(tmpdir(), 'ping-recordings-')) } }));
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
  assert.equal(minted.at(-1).session.audio.output.speed, 1);
});

test('the invite codes never reach the browser', async () => {
  const { data: config } = await request('/api/config');
  assert.ok(!JSON.stringify(config).includes(INVITE_CODE));
  for (const file of ['/', '/app.js', '/lib.js', '/settings.js', '/contacts.js']) {
    const text = await (await fetch(baseUrl + file)).text();
    assert.ok(![INVITE_CODE, BETA_CODE, YC_CODE].some((code) => text.includes(code)), file);
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
  assert.equal(data.settings.speed, 0.85);
  assert.equal(data.turnDetection.silence_duration_ms, silenceMs('long', 0.85));
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

test('a word can be added and removed on any plan', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  assert.equal(data.added, true);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: WORD })).data.added, false);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: { kana: 'hello', romaji: 'x', english: 'y' } })).status, 400);
  const removed = await request(`/api/stack/words/${data.word.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.words, []);
});

test('example sentences work on any plan, and are only saved on request', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  const path = `/api/stack/words/${data.word.id}/examples`;
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

test("a saved sentence's kanji words are looked up once, and each can be added to Words", async () => {
  const token = await join();
  const saved = await request('/api/stack/sentences', { method: 'POST', token, body: { japanese: '会議は三時から始まります。', romaji: 'kaigi wa sanji kara hajimarimasu.', english: 'The meeting starts at three.', word: '会議' } });
  const path = `/api/stack/sentences/${saved.data.sentences[0].id}/words`;
  const before = openai.sentenceWordLookups;
  const { status, data } = await request(path, { method: 'POST', token });
  assert.equal(status, 200);
  // The word with no kanji is left out, and each keeps how it's written in the sentence.
  assert.deepEqual(data.words.map(({ asWritten, kanji }) => [asWritten, kanji]), [['会議', '会議'], ['始まります', '始まる']]);
  // Kept with the sentence, so opening it again costs nothing.
  assert.deepEqual((await request(path, { method: 'POST', token })).data.words, data.words);
  assert.equal(openai.sentenceWordLookups, before + 1);
  assert.equal((await request('/api/me', { token })).data.sentences[0].kanjiWords.length, 2);

  const { asWritten, ...word } = data.words[1];
  const added = await request('/api/stack/words', { method: 'POST', token, body: word });
  assert.equal(added.data.added, true);
  assert.equal((await request('/api/me', { token })).data.words[0].kanji, '始まる');
  assert.equal((await request('/api/stack/sentences/missing/words', { method: 'POST', token })).status, 404);
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
  assert.equal(admin.plan, 'free');

  assert.equal((await request('/api/plan', { method: 'PUT', token: beta.token, body: { plan: 'platinum' } })).status, 403);
  assert.equal((await request('/api/me', { token: beta.token })).data.plan, 'free');
  assert.equal((await request('/api/test-ring', { method: 'POST', token: beta.token })).status, 403);

  assert.equal((await request('/api/plan', { method: 'PUT', token: admin.token, body: { plan: 'platinum' } })).status, 200);
  await request('/api/push', { method: 'PUT', token: admin.token, body: { subscription: SUBSCRIPTION, timeZone: 'Asia/Tokyo' } });
  assert.equal((await request('/api/test-ring', { method: 'POST', token: admin.token })).status, 202);
});

test('YC reviewers join as beta testers, and admins can see who joined with each code and whether they called', async () => {
  const signUp = (inviteCode) => request('/api/register', { method: 'POST', body: { inviteCode, timeZone: 'America/Los_Angeles' } });
  const { data: reviewer } = await signUp('yc-demo'); // any capitalization works
  assert.equal(reviewer.role, 'beta');
  assert.equal(reviewer.plan, 'premium');
  // Reviewers start with a few example words and sentences; other accounts start empty.
  assert.deepEqual(reviewer.words.map((word) => word.kanji), ['忙しい', '散歩', '美味しい', '週末']);
  assert.equal(reviewer.sentences.length, 3);
  assert.ok(reviewer.sentences.every((sentence) => sentence.romaji && reviewer.words.some((word) => word.kanji === sentence.word)));
  assert.equal((await signUp(BETA_CODE)).data.words.length, 0);
  assert.equal(reviewer.calling.callsPerDay, 3);
  // Still not an admin: no plan switching, test rings or turn-detection switch.
  assert.equal((await request('/api/plan', { method: 'PUT', token: reviewer.token, body: { plan: 'platinum' } })).status, 403);
  assert.equal((await request('/api/test-ring', { method: 'POST', token: reviewer.token })).status, 403);
  assert.equal((await request('/api/turn-mode', { method: 'PUT', token: reviewer.token, body: { turnMode: 'semantic' } })).status, 403);
  await signUp(YC_CODE);
  assert.equal((await request('/api/admin/invites', { token: reviewer.token })).status, 403);

  const { data: call } = await request('/api/calls', { method: 'POST', token: reviewer.token });
  await request(`/api/calls/${call.id}/connected`, { method: 'POST', token: reviewer.token });
  await request(`/api/calls/${call.id}/connected`, { method: 'POST', token: reviewer.token }); // the same call only counts once

  const { data } = await request('/api/admin/invites', { token: await join() });
  const yc = data.invites.find((invite) => invite.code === 'yc');
  assert.equal(yc.accounts, 2);
  assert.equal(yc.accountsThatCalled, 1);
  assert.equal(yc.calls, 1);
  assert.ok(yc.lastCallAt);
  assert.equal(yc.newest.length, 2);
  assert.ok(yc.newest.every((account) => account.joinedAt && !('token' in account) && !('id' in account)));
  assert.deepEqual(data.invites.map((invite) => invite.code), ['admin', 'beta', 'yc']);
  assert.ok(!JSON.stringify(data).includes(YC_CODE), 'the codes themselves are never sent');
});

test("a call's session stops at the plan's limit, and an ended call stays ended", async () => {
  const token = await join();
  await request('/api/plan', { method: 'PUT', token, body: { plan: 'platinum' } });
  const { data: me } = await request('/api/me', { token });
  assert.deepEqual([me.calling.canCall, me.calling.perCallMinutes, me.calling.callsPerDay], [true, 10, 5]);
  assert.deepEqual(me.planLimits.premium, { callsPerDay: 3, perCall: 5, savedItems: 100 });

  const { data: call } = await request('/api/calls', { method: 'POST', token });
  const { data: session } = await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  assert.equal(session.maxSeconds, 600);
  const { data: ended } = await request(`/api/calls/${call.id}/ended`, { method: 'POST', token });
  assert.equal(ended.calling.canCall, true);
  assert.equal((await request(`/api/calls/${call.id}/session`, { method: 'POST', token })).status, 429);
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
  // This call never connected, so it was never assigned a turn mode.
  assert.deepEqual(stored, { callId: call.id, ...METRICS, engine: 'gpt-realtime', turnMode: null, actualTurnMode: null, thinkingTime: 'normal', speed: 1, proficiency: 'beginner' });
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
  assert.equal((await request('/api/call-setup', { method: 'PUT', token: beta.token, body: { manual: true } })).status, 403);
  assert.equal(beta.callSetup, undefined);

  const { token } = await signUp(INVITE_CODE);
  assert.equal((await request('/api/call-setup', { method: 'PUT', token, body: { manual: true } })).data.callSetup.manual, true);
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
  await request('/api/call-setup', { method: 'PUT', token, body: { manual: true } });
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

// Call recordings

const AUDIO = new Uint8Array([0, 1, 2, 3, 4, 5]);
const joinWith = async (inviteCode) => (await request('/api/register', { method: 'POST', body: { inviteCode, timeZone: 'America/Los_Angeles' } })).data;
const uploadAudio = async (token, callId, { type = 'audio/mp4', body = AUDIO } = {}) =>
  (await fetch(`${baseUrl}/api/calls/${callId}/recording`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body })).status;
// A call that has connected, which is when it's decided whether it's recorded.
async function connectedCall(token) {
  const { data: call } = await request('/api/calls', { method: 'POST', token });
  await request(`/api/calls/${call.id}/session`, { method: 'POST', token });
  return call;
}
const RECORDED_LINES = [{ from: 'contact', text: '今日は何をしましたか？' }, { from: 'you', text: 'えーと…ラーメンを食べました' }];

test('calls are recorded for review, audio and transcript, even on the free plan, and only admins can listen', async () => {
  const tester = await joinWith(BETA_CODE);
  assert.deepEqual(tester.recording, { on: true, canTurnOff: false });
  assert.equal(tester.policyNotice, false); // the join screen already says calls are recorded
  const call = await connectedCall(tester.token);
  assert.equal(await uploadAudio(tester.token, call.id), 201);
  const { data } = await request(`/api/calls/${call.id}/transcript`, { method: 'POST', token: tester.token, body: { lines: RECORDED_LINES } });
  assert.deepEqual([data.saved, data.recorded], [false, true]); // not kept as Free-plan memory, but kept for review

  assert.equal((await request('/api/admin/recordings', { token: tester.token })).status, 403);
  assert.equal((await request(`/api/admin/recordings/${call.id}/audio`, { token: tester.token })).status, 403);
  const admin = await join();
  const listed = (await request('/api/admin/recordings', { token: admin })).data.recordings.find((item) => item.callId === call.id);
  assert.deepEqual([listed.joinedWith, listed.audio, listed.lineCount, listed.lines], ['beta', 'm4a', 2, undefined]);
  assert.deepEqual((await request(`/api/admin/recordings/${call.id}`, { token: admin })).data.lines, RECORDED_LINES);
  const audio = await fetch(`${baseUrl}/api/admin/recordings/${call.id}/audio`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), AUDIO);
});

test('YC reviewers can turn recording off, which stops future recordings only, and testers and admins cannot', async () => {
  const reviewer = await joinWith(YC_CODE);
  assert.deepEqual(reviewer.recording, { on: true, canTurnOff: true });
  const earlier = await connectedCall(reviewer.token);
  assert.equal(await uploadAudio(reviewer.token, earlier.id), 201);
  assert.equal((await request('/api/recording', { method: 'PUT', token: reviewer.token, body: { on: 'no' } })).status, 400);
  assert.deepEqual((await request('/api/recording', { method: 'PUT', token: reviewer.token, body: { on: false } })).data.recording, { on: false, canTurnOff: true });

  const later = await connectedCall(reviewer.token);
  assert.equal(await uploadAudio(reviewer.token, later.id), 404);
  assert.equal((await request(`/api/calls/${later.id}/transcript`, { method: 'POST', token: reviewer.token, body: { lines: RECORDED_LINES } })).data.recorded, false);
  const admin = await join();
  const callIds = (await request('/api/admin/recordings', { token: admin })).data.recordings.map((item) => item.callId);
  assert.ok(callIds.includes(earlier.id), 'turning recording off keeps earlier recordings');
  assert.ok(!callIds.includes(later.id));

  for (const token of [admin, (await joinWith(BETA_CODE)).token]) {
    assert.equal((await request('/api/recording', { method: 'PUT', token, body: { on: false } })).status, 403);
    assert.equal((await request('/api/me', { token })).data.recording.on, true);
  }
});

test("uploads must be audio the app records, for the user's own recorded call", async () => {
  const token = await join();
  const call = await connectedCall(token);
  assert.equal(await uploadAudio(token, call.id, { type: 'text/plain' }), 415);
  assert.equal(await uploadAudio(token, call.id, { body: new Uint8Array() }), 400);
  assert.equal(await uploadAudio(await join(), call.id), 404);
  const { data: notConnected } = await request('/api/calls', { method: 'POST', token });
  assert.equal(await uploadAudio(token, notConnected.id), 404);
  assert.equal(await uploadAudio(token, call.id, { type: 'audio/webm;codecs=opus' }), 201);
  const listed = (await request('/api/admin/recordings', { token })).data.recordings.find((item) => item.callId === call.id);
  assert.equal(listed.audio, 'webm');
});

test("deleting an account deletes the account's recordings", async () => {
  const tester = await joinWith(BETA_CODE);
  const call = await connectedCall(tester.token);
  assert.equal(await uploadAudio(tester.token, call.id), 201);
  await request('/api/me', { method: 'DELETE', token: tester.token });
  assert.equal((await request(`/api/admin/recordings/${call.id}`, { token: await join() })).status, 404);
});

test('accounts from before calls were recorded see a one-time notice', async () => {
  const token = await join();
  engine.userForToken(token).policyVersion = 0; // as an older account loads
  assert.equal((await request('/api/me', { token })).data.policyNotice, true);
  assert.equal((await request('/api/policy/seen', { method: 'POST', token })).status, 200);
  assert.equal((await request('/api/me', { token })).data.policyNotice, false);
});

test('after a call, the user can rate cut-offs and naturalness from 1 to 5, as numbers only', async () => {
  const tester = await joinWith(BETA_CODE);
  const { data: notConnected } = await request('/api/calls', { method: 'POST', token: tester.token });
  const rate = (callId, body, token = tester.token) => request(`/api/calls/${callId}/rating`, { method: 'POST', token, body });
  assert.equal((await rate(notConnected.id, { cutOffs: 2, naturalness: 4 })).status, 404); // never connected

  const call = await connectedCall(tester.token);
  await request(`/api/calls/${call.id}/connected`, { method: 'POST', token: tester.token });
  for (const bad of [{ cutOffs: 0, naturalness: 3 }, { cutOffs: 2, naturalness: 6 }, { cutOffs: 2.5, naturalness: 3 }, { cutOffs: '2', naturalness: 3 }, { cutOffs: 2 }]) {
    assert.equal((await rate(call.id, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await rate(call.id, { cutOffs: 2, naturalness: 4 }, await join())).status, 404); // someone else's call
  assert.equal((await rate(call.id, { cutOffs: 2, naturalness: 4, comment: 'words' })).status, 201);
  assert.equal((await rate(call.id, { cutOffs: 1, naturalness: 5 })).status, 201); // a second rating replaces the first

  const { ratings } = engine.userForToken(tester.token);
  assert.equal(ratings.length, 1);
  assert.deepEqual(Object.keys(ratings[0]).sort(), ['at', 'callId', 'cutOffs', 'engine', 'naturalness', 'turnMode']);
  assert.deepEqual([ratings[0].cutOffs, ratings[0].naturalness, ratings[0].engine], [1, 5, 'gpt-realtime']);
  assert.equal(ratings[0].turnMode, engine.store.calls[call.id].turnMode, 'the rating keeps the mode the call was assigned');
  const listed = (await request('/api/admin/recordings', { token: await join() })).data.recordings.find((item) => item.callId === call.id);
  assert.deepEqual(listed.rating, { cutOffs: 1, naturalness: 5 });
});

// Engines and turn modes

test('every caller is randomized across the mix, balanced per person, and each call keeps its assignment', async () => {
  const tester = await joinWith(BETA_CODE);
  const modes = [];
  for (let index = 0; index < 4; index += 1) {
    const call = await connectedCall(tester.token);
    const { data: again } = await request(`/api/calls/${call.id}/session`, { method: 'POST', token: tester.token }); // a reconnect
    const stored = engine.store.calls[call.id];
    assert.equal(stored.assigned, 'random');
    assert.equal(again.turnMode, stored.turnMode, 'a reconnect keeps the same turn mode');
    modes.push(stored.turnMode);
  }
  assert.deepEqual(modes.toSorted(), ['silence', 'silence', 'smartTurn', 'smartTurn'], 'four calls split evenly across the two');
  assert.deepEqual(engine.userForToken(tester.token).comboCounts, { 'gpt-realtime|silence': 2, 'gpt-realtime|smartTurn': 2 });
});

test('an admin can pick the engine and turn mode instead, and only real combinations', async () => {
  const token = await join();
  assert.equal((await request('/api/call-setup', { method: 'PUT', token, body: { engine: 'made-up' } })).status, 400);
  assert.equal((await request('/api/call-setup', { method: 'PUT', token, body: { turnMode: 'psychic' } })).status, 400);
  const { data } = await request('/api/call-setup', { method: 'PUT', token, body: { manual: true, engine: 'gpt-realtime', turnMode: 'semantic' } });
  assert.deepEqual([data.callSetup.manual, data.callSetup.engine, data.callSetup.turnMode], [true, 'gpt-realtime', 'semantic']);
  assert.ok(data.callSetup.randomMix.length >= 2);
  const call = await connectedCall(token);
  assert.deepEqual([engine.store.calls[call.id].turnMode, engine.store.calls[call.id].assigned], ['semantic', 'manual']);
  assert.deepEqual(engine.userForToken(token).comboCounts, {}, 'manual calls do not count toward the random balance');

  await request('/api/call-setup', { method: 'PUT', token, body: { manual: false } });
  const random = await connectedCall(token);
  assert.equal(engine.store.calls[random.id].assigned, 'random');
});

test('the call log shows each call’s engine and turn mode with how it went, for admins only, and is removed with the account', async () => {
  const tester = await joinWith(BETA_CODE);
  const call = await connectedCall(tester.token);
  await request(`/api/calls/${call.id}/connected`, { method: 'POST', token: tester.token });
  const log = console.log;
  console.log = () => {};
  try {
    await request(`/api/calls/${call.id}/metrics`, { method: 'POST', token: tester.token, body: { ...METRICS, smartTurnFallback: 2 } });
    await request(`/api/calls/${call.id}/rating`, { method: 'POST', token: tester.token, body: { cutOffs: 3, naturalness: 4 } });
  } finally {
    console.log = log;
  }
  await request(`/api/calls/${call.id}/ended`, { method: 'POST', token: tester.token });

  assert.equal((await request('/api/admin/calls', { token: tester.token })).status, 403);
  const entry = (await request('/api/admin/calls', { token: await join() })).data.calls.find((item) => item.callId === call.id);
  const assignedMode = engine.store.calls[call.id].turnMode;
  assert.deepEqual(
    [entry.joinedWith, entry.engine, entry.turnMode, entry.assigned, entry.cutOffs, entry.naturalness, entry.replyGapMedianMs, typeof entry.seconds],
    ['beta', 'gpt-realtime', assignedMode, 'random', 3, 4, METRICS.replyGapMedianMs, 'number'],
  );
  assert.equal(entry.recorded, true, 'beta testers are always recorded');
  assert.equal(entry.actualTurnMode, assignedMode === 'smartTurn' ? 'silence' : assignedMode, 'a Smart Turn call that fell back shows silence as what it ended in');
  assert.ok(Object.values(entry).every((value) => value === null || ['number', 'string', 'boolean'].includes(typeof value)));

  await request('/api/me', { method: 'DELETE', token: tester.token });
  assert.ok(!engine.store.callLog.some((item) => item.callId === call.id));
});

test('an admin can pick Deepgram: its session has a call token and agent settings, and its turn mode is blank', async () => {
  const token = await join();
  const pick = await request('/api/call-setup', { method: 'PUT', token, body: { manual: true, engine: 'deepgram-agent' } });
  assert.equal(pick.data.callSetup.engine, 'deepgram-agent');
  assert.deepEqual(pick.data.callSetup.engines['deepgram-agent'].turnModes, []);

  // Without a Deepgram key, the call says so instead of failing silently.
  const first = (await request('/api/calls', { method: 'POST', token })).data;
  const unset = await request(`/api/calls/${first.id}/session`, { method: 'POST', token });
  assert.equal(unset.status, 503);

  const deepgram = { hasKey: true, mintToken: async () => 'jwt-for-the-phone' };
  const { server: withDeepgram } = createApp({ engine, openai, deepgram, config: { inviteCodes: { admin: INVITE_CODE }, vapidPublicKey: 'public', model: 'gpt-realtime', voice: 'marin', dataDir: null, recordingsDir: mkdtempSync(joinPath(tmpdir(), 'ping-recordings-')) } });
  await new Promise((resolve) => withDeepgram.listen(0, resolve));
  const base = `http://127.0.0.1:${withDeepgram.address().port}`;
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { method: options.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    const second = (await call('/api/calls', { method: 'POST' })).data;
    const { status, data } = await call(`/api/calls/${second.id}/session`, { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual([data.engine, data.token, data.agentUrl, data.turnMode], ['deepgram-agent', 'jwt-for-the-phone', 'wss://agent.deepgram.com/v1/agent/converse', null]);
    assert.equal(data.settings.type, 'Settings');
    assert.match(data.timeUpLine, /時間/);
    assert.equal(data.clientSecret, undefined, 'no OpenAI key is minted for a Deepgram call');
    const stored = engine.store.calls[second.id];
    assert.deepEqual([stored.engine, stored.turnMode, stored.assigned], ['deepgram-agent', null, 'manual']);
    const { data: changed } = await call('/api/settings', { method: 'PATCH', body: { thinkingTime: 'long' } });
    assert.equal(changed.agent.listen.provider.eot_threshold, 0.9);
    const logged = engine.store.callLog.findLast((entry) => entry.callId === second.id);
    assert.deepEqual([logged.engine, logged.turnMode], ['deepgram-agent', null]);
  } finally {
    withDeepgram.close();
  }
  await request('/api/call-setup', { method: 'PUT', token, body: { manual: false } });
});

test('the page may connect to Deepgram, and nowhere else new', async () => {
  const response = await fetch(baseUrl + '/');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' https:\/\/api\.openai\.com wss:\/\/agent\.deepgram\.com;/);
});

test("the phone says why a call ended, and a call that dropped straight away doesn't use up a Free user's call", async () => {
  const { token } = await joinWith(BETA_CODE);
  const call = async () => (await request('/api/calls', { method: 'POST', token })).data;
  const start = async (id) => {
    await request(`/api/calls/${id}/session`, { method: 'POST', token });
    await request(`/api/calls/${id}/connected`, { method: 'POST', token });
  };
  // The first call is free, then the day's one call drops straight away.
  const first = await call();
  await start(first.id);
  await request(`/api/calls/${first.id}/ended`, { method: 'POST', token, body: { reason: 'hung-up' } });
  const second = await call();
  await start(second.id);
  const { data } = await request(`/api/calls/${second.id}/ended`, { method: 'POST', token, body: { reason: 'dropped' } });
  assert.deepEqual([data.calling.canCall, data.calling.retryAfterDrop], [true, true]);

  // The retry is used by the next call. Ending it with no reason, as an older app does, gives nothing back.
  const third = await call();
  await start(third.id);
  const { data: after } = await request(`/api/calls/${third.id}/ended`, { method: 'POST', token });
  assert.deepEqual([after.calling.canCall, after.calling.retryAfterDrop], [false, false]);
});
