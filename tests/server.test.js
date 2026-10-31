import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { CallEngine } from '../server/calls.js';
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
  assert.equal(data.turnDetection.silence_duration_ms, 2500);
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
