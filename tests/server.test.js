import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { CallEngine } from '../server/calls.js';
import { silenceMs } from '../server/settings.js';
import { Store } from '../server/store.js';

const SUBSCRIPTION = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };
const INVITE_CODE = 'test-invite';

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
  exampleSentences: async () => [{ japanese: '元気です。', english: "I'm well." }],
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
  ({ server } = createApp({ engine, openai, config: { inviteCode: INVITE_CODE, vapidPublicKey: 'public', model: 'gpt-realtime', voice: 'marin', dataDir: null } }));
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
  const { server: limited } = createApp({ engine, openai, config: { inviteCode: INVITE_CODE, vapidPublicKey: 'public', model: 'm', voice: 'v', dataDir: null } });
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
  const { server: closed } = createApp({ engine, openai, config: { inviteCode: '', vapidPublicKey: 'public', model: 'm', voice: 'v', dataDir: null } });
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

const WORD = { kanji: '元気', kana: 'げんき', romaji: 'genki', english: 'healthy, well' };

test('a word can be added on any plan, but only subscribers can remove it', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  assert.equal(data.added, true);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: WORD })).data.added, false);
  assert.equal((await request('/api/stack/words', { method: 'POST', token, body: { kana: 'hello', romaji: 'x', english: 'y' } })).status, 400);
  assert.equal((await request(`/api/stack/words/${data.word.id}`, { method: 'DELETE', token })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'plus' } });
  const removed = await request(`/api/stack/words/${data.word.id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.words, []);
});

test('example sentences need a subscription, and are only saved on request', async () => {
  const token = await join();
  const { data } = await request('/api/stack/words', { method: 'POST', token, body: WORD });
  const path = `/api/stack/words/${data.word.id}/examples`;
  assert.equal((await request(path, { method: 'POST', token })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'plus' } });
  const { data: examples } = await request(path, { method: 'POST', token });
  assert.equal(examples.sentences.length, 1);
  assert.deepEqual((await request('/api/me', { token })).data.sentences, []);

  const saved = await request('/api/stack/sentences', { method: 'POST', token, body: { ...examples.sentences[0], word: '元気' } });
  assert.equal(saved.data.sentences.length, 1);
  const removed = await request(`/api/stack/sentences/${saved.data.sentences[0].id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
});

test('contacts follow the plan: free has Ping, Mero is coming soon, Higher Tier can create', async () => {
  const token = await join();
  const { data: free } = await request('/api/me', { token });
  assert.deepEqual(free.contacts.map(({ id, available }) => [id, available]), [['ping', true], ['mero', false]]);
  assert.equal((await request('/api/calls', { method: 'POST', token, body: { contactId: 'mero' } })).status, 403);
  assert.equal((await request('/api/contacts', { method: 'POST', token, body: { name: 'Yuki', topic: 'cooking', voice: 'cedar' } })).status, 403);

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'pro' } });
  assert.equal((await request('/api/contact', { method: 'PUT', token, body: { contactId: 'mero' } })).status, 403);
  assert.equal((await request('/api/contacts', { method: 'POST', token, body: { name: '', topic: 'x', voice: 'cedar' } })).status, 400);
  const { data: pro } = await request('/api/contacts', { method: 'POST', token, body: { name: 'Yuki', topic: 'cooking', voice: 'cedar' } });
  const yuki = pro.contacts.find((contact) => contact.name === 'Yuki');
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

  await request('/api/plan', { method: 'PUT', token, body: { plan: 'plus' } });
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
