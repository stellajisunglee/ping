import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadWorker({ deliveredState = 'ringing', windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const fetched = [];
  const opened = [];
  const self = {
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    location: { origin: 'https://ping.test' },
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, ...options });
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (path) => {
        opened.push(path);
      },
    },
  };
  const fetchStub = async (path, options) => {
    fetched.push({ path, method: options?.method });
    return { json: async () => ({ state: deliveredState }) };
  };
  vm.runInNewContext(source, { self, fetch: fetchStub, URL, caches: {}, Promise, console });

  async function fire(type, event) {
    const pending = [];
    listeners[type]({ ...event, waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  }
  const push = (payload) => fire('push', { data: { json: () => payload } });
  const click = (data, action = '') => {
    let closed = false;
    return fire('notificationclick', { action, notification: { data, close: () => (closed = true) } }).then(() => closed);
  };
  return { shown, fetched, opened, push, click };
}

test('a ring shows the notification and confirms delivery', async () => {
  const worker = loadWorker();
  await worker.push({ type: 'ring', callId: 'c1' });
  assert.equal(worker.shown[0].title, 'Mina is calling');
  assert.deepEqual(worker.fetched, [{ path: '/api/calls/c1/delivered', method: 'POST' }]);
});

test('a ring that arrives after the call was missed becomes a missed call', async () => {
  const worker = loadWorker({ deliveredState: 'missed' });
  await worker.push({ type: 'ring', callId: 'c1' });
  assert.equal(worker.shown.at(-1).title, 'Missed call from Mina');
  assert.equal(worker.shown.at(-1).tag, worker.shown[0].tag);
});

test('a missed call replaces the ring notification', async () => {
  const worker = loadWorker();
  await worker.push({ type: 'ring', callId: 'c1' });
  await worker.push({ type: 'missed', callId: 'c1' });
  assert.equal(worker.shown[1].tag, worker.shown[0].tag);
  assert.equal(worker.shown[1].data.type, 'missed');
});

test('tapping a ring answers and opens the call', async () => {
  const worker = loadWorker();
  const closed = await worker.click({ type: 'ring', callId: 'c1' });
  assert.equal(closed, true);
  assert.deepEqual(worker.fetched, [{ path: '/api/calls/c1/answer', method: 'POST' }]);
  assert.deepEqual(worker.opened, ['/?call=c1']);
});

test('tapping a ring reuses an open app', async () => {
  const messages = [];
  let focused = false;
  const client = {
    focus: async () => {
      focused = true;
    },
    postMessage: (message) => messages.push(message),
  };
  const worker = loadWorker({ windows: [client] });
  await worker.click({ type: 'ring', callId: 'c1' });
  assert.equal(focused, true);
  assert.equal(messages[0].type, 'answer');
  assert.deepEqual(worker.opened, []);
});

test('the decline button declines without opening the app', async () => {
  const worker = loadWorker();
  await worker.click({ type: 'ring', callId: 'c1' }, 'decline');
  assert.deepEqual(worker.fetched, [{ path: '/api/calls/c1/decline', method: 'POST' }]);
  assert.deepEqual(worker.opened, []);
});

test('tapping a missed call opens the voice messages', async () => {
  const worker = loadWorker();
  await worker.click({ type: 'missed', callId: 'c1' });
  assert.deepEqual(worker.opened, ['/?messages=1']);
  assert.deepEqual(worker.fetched, []);
});
