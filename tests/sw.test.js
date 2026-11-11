import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadWorker({ deliveredState = 'ringing', windows = [], ringClosedAfter = null } = {}) {
  const state = { ringClosedAfter };
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
        // A notification with the same tag replaces the one showing.
        shown.filter((notification) => notification.tag === options.tag).forEach((notification) => (notification.open = false));
        const notification = { title, ...options, open: true };
        notification.close = () => (notification.open = false);
        shown.push(notification);
      },
      // Answering or declining in the app closes the call's notifications, here after a set number of rings.
      getNotifications: async () => {
        if (state.ringClosedAfter !== null && shown.length >= state.ringClosedAfter) shown.forEach((notification) => (notification.open = false));
        return shown.filter((notification) => notification.open);
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
  vm.runInNewContext(source, { self, fetch: fetchStub, URL, caches: {}, Promise, console, setTimeout: (run) => run() });

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
  await worker.push({ type: 'ring', callId: 'c1', contactName: 'Ping' });
  assert.equal(worker.shown[0].title, 'Ping is calling');
  assert.deepEqual(worker.fetched, [{ path: '/api/calls/c1/delivered', method: 'POST' }]);
});

const showing = (worker) => worker.shown.filter((notification) => notification.open);

test('a ring that arrives after the call was missed becomes a missed call', async () => {
  const worker = loadWorker({ deliveredState: 'missed' });
  await worker.push({ type: 'ring', callId: 'c1', contactName: 'Yuki' });
  assert.deepEqual(showing(worker).map(({ title }) => title), ['Missed call from Yuki']);
});

test('a missed call replaces the ring notification', async () => {
  const worker = loadWorker();
  await worker.push({ type: 'ring', callId: 'c1' });
  await worker.push({ type: 'missed', callId: 'c1' });
  assert.deepEqual(showing(worker).map(({ data }) => data.type), ['missed']);
});

test('the phone keeps ringing during the 10 seconds, each ring a new notification so it makes a sound', async () => {
  const worker = loadWorker();
  await worker.push({ type: 'ring', callId: 'c1', contactName: 'Ping' });
  assert.equal(worker.shown.length, 4);
  assert.ok(worker.shown.every((ring) => ring.data.type === 'ring' && ring.tag.startsWith('ping-call')));
  assert.equal(new Set(worker.shown.map(({ tag }) => tag)).size, 4);
  // Only the newest ring is left showing.
  assert.deepEqual(showing(worker), [worker.shown.at(-1)]);
});

test('ringing stops once the call is answered or declined', async () => {
  const worker = loadWorker({ ringClosedAfter: 2 });
  await worker.push({ type: 'ring', callId: 'c1', contactName: 'Ping' });
  assert.equal(worker.shown.length, 2);
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
