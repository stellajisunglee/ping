import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallEngine, DELIVERY_GRACE_MS, LimitError, MAX_SESSIONS_PER_CALL, RING_MS } from '../server/calls.js';
import { Store } from '../server/store.js';

const SUBSCRIPTION = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };
const NOON_IN_TOKYO = Date.UTC(2026, 9, 31, 3);

function setup({ pushResult = { gone: false }, store = new Store(), dailyCallLimit } = {}) {
  const clock = { now: NOON_IN_TOKYO };
  const pushes = [];
  const engine = new CallEngine({
    store,
    dailyCallLimit,
    now: () => clock.now,
    random: () => 0.5,
    sendPush: async (subscription, payload, options) => {
      pushes.push({ subscription, payload, options });
      return pushResult;
    },
  });
  const { user, token } = engine.register('Asia/Tokyo');
  engine.setSubscription(user, SUBSCRIPTION);
  return { clock, pushes, engine, user, token, store };
}

async function ringNow({ clock, engine, user }) {
  clock.now = user.nextCallAt;
  await engine.tick();
}

const callOf = (store) => Object.values(store.calls).at(-1);

test('a due user gets exactly one ring', async () => {
  const context = setup();
  await ringNow(context);
  await context.engine.tick();
  assert.equal(context.pushes.length, 1);
  assert.equal(context.pushes[0].payload.type, 'ring');
  assert.equal(callOf(context.store).state, 'ringing');
});

test('the next call moves to tomorrow once this one rings', async () => {
  const context = setup();
  const firstCallAt = context.user.nextCallAt;
  await ringNow(context);
  assert.ok(context.user.nextCallAt - firstCallAt > 3600_000);
});

test('no answer within 10 seconds of delivery means missed, with a voice message', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.markDelivered(call.id);

  context.clock.now += RING_MS - 1;
  await context.engine.tick();
  assert.equal(call.state, 'ringing');

  context.clock.now += 1;
  await context.engine.tick();
  assert.equal(call.state, 'missed');
  assert.equal(context.pushes.at(-1).payload.type, 'missed');
  assert.equal(context.user.messages.length, 1);
  assert.equal(context.user.messages[0].heard, false);
});

test('the 10 seconds start at delivery, not when the push was sent', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.clock.now += RING_MS + 5_000;
  await context.engine.tick();
  assert.equal(call.state, 'ringing');

  context.engine.markDelivered(call.id);
  context.clock.now += RING_MS - 1;
  await context.engine.tick();
  assert.equal(call.state, 'ringing');
});

test('a second delivery confirmation does not extend the ring', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.markDelivered(call.id);
  const deadline = call.ringDeadline;
  context.clock.now += 5_000;
  context.engine.markDelivered(call.id);
  assert.equal(call.ringDeadline, deadline);
});

test('a push that never arrives counts as missed after the grace period', async () => {
  const context = setup();
  await ringNow(context);
  context.clock.now += DELIVERY_GRACE_MS;
  await context.engine.tick();
  assert.equal(callOf(context.store).state, 'missed');
});

test('answering in time connects, and no voice message is left', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.markDelivered(call.id);
  context.clock.now += RING_MS - 1;
  assert.equal(context.engine.answer(call.id).state, 'answered');

  context.clock.now += 60_000;
  await context.engine.tick();
  assert.equal(call.state, 'answered');
  assert.equal(context.user.messages.length, 0);
  assert.equal(context.pushes.length, 1);
});

test('answering twice is harmless', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.answer(call.id);
  assert.equal(context.engine.answer(call.id).state, 'answered');
});

test('answering too late stays missed and gets no voice session', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.markDelivered(call.id);
  context.clock.now += RING_MS;
  await context.engine.tick();
  assert.equal(context.engine.answer(call.id).state, 'missed');
  assert.equal(context.engine.sessionDetails(context.user, call.id), null);
});

test('declining leaves no voice message', async () => {
  const context = setup();
  await ringNow(context);
  const call = callOf(context.store);
  context.engine.decline(call.id);
  context.clock.now += 60_000;
  await context.engine.tick();
  assert.equal(call.state, 'declined');
  assert.equal(context.user.messages.length, 0);
});

test('a call that is due long after its time is rescheduled, not rung', async () => {
  const context = setup();
  context.clock.now = context.user.nextCallAt + 6 * 3600_000;
  await context.engine.tick();
  assert.equal(context.pushes.length, 0);
  assert.ok(context.user.nextCallAt > context.clock.now);
});

test('users who turned off calls are not rung', async () => {
  const context = setup();
  context.engine.updateSettings(context.user, { callsEnabled: false });
  await ringNow(context);
  assert.equal(context.pushes.length, 0);
});

test('a dead subscription is dropped so it stops being retried', async () => {
  const context = setup({ pushResult: { gone: true } });
  await ringNow(context);
  assert.equal(context.user.subscription, null);
  assert.equal(callOf(context.store).state, 'undelivered');
});

test('the same question does not come twice in a row', async () => {
  const context = setup();
  for (let index = 0; index < 8; index += 1) {
    const before = context.user.lastQuestionId;
    context.user.usage = { day: null, calls: 0 };
    assert.notEqual(context.engine.callBack(context.user).questionId, before);
  }
});

test('with a daily limit set, calls stop at the limit and reset the next day', () => {
  const context = setup({ dailyCallLimit: 6 });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(context.engine.callBack(context.user).state, 'answered');
  }
  assert.throws(() => context.engine.callBack(context.user), LimitError);
  assert.throws(() => context.engine.requestTestRing(context.user), LimitError);

  context.clock.now += 24 * 3600_000;
  assert.equal(context.engine.callBack(context.user).state, 'answered');
});

test('with no daily limit set, calls and test rings keep working', () => {
  const context = setup();
  for (let index = 0; index < 50; index += 1) {
    assert.equal(context.engine.callBack(context.user).state, 'answered');
    context.engine.requestTestRing(context.user);
  }
});

test('voice sessions are limited per call, and belong only to their owner', () => {
  const context = setup();
  const call = context.engine.callBack(context.user);
  const { user: stranger } = context.engine.register('Asia/Tokyo');
  assert.equal(context.engine.sessionDetails(stranger, call.id), null);

  for (let index = 0; index < MAX_SESSIONS_PER_CALL; index += 1) {
    assert.equal(context.engine.sessionDetails(context.user, call.id).calledBack, true);
  }
  assert.throws(() => context.engine.sessionDetails(context.user, call.id), LimitError);
});

test('tokens identify users and are not stored in the clear', () => {
  const context = setup();
  assert.equal(context.engine.userForToken(context.token), context.user);
  assert.equal(context.engine.userForToken('nope'), null);
  assert.ok(!JSON.stringify(context.store.users).includes(context.token));
});

test('deleting a user removes their calls too', async () => {
  const context = setup();
  await ringNow(context);
  context.engine.deleteUser(context.user);
  assert.deepEqual(context.store.users, {});
  assert.deepEqual(context.store.calls, {});
});

test('a ringing call survives a restart and is still missed on time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ping-'));
  try {
    const file = join(dir, 'state.json');
    const context = setup({ store: new Store(file) });
    await ringNow(context);
    context.engine.markDelivered(callOf(context.store).id);

    const restarted = new Store(file);
    const pushes = [];
    const engine = new CallEngine({
      store: restarted,
      now: () => context.clock.now + RING_MS,
      sendPush: async (subscription, payload) => {
        pushes.push(payload);
        return { gone: false };
      },
    });
    await engine.tick();
    assert.equal(callOf(restarted).state, 'missed');
    assert.equal(pushes[0].type, 'missed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
