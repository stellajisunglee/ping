import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallEngine, CANCEL_WINDOW_MS, DELIVERY_GRACE_MS, LimitError, MAX_SESSIONS_PER_CALL, PlanError, RING_MS } from '../server/calls.js';
import { FREE_WORD_LIMIT } from '../server/stack.js';
import { localDay, localParts } from '../server/schedule.js';
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

const DAY_MS = 86_400_000;
const word = (index) => ({ kanji: '', kana: `あ${index}`, romaji: `a${index}`, english: `word ${index}` });

function connectToday(context) {
  const call = context.engine.callBack(context.user);
  assert.equal(context.engine.markConnected(context.user, call.id), true);
}

test('the ring and missed call name the selected contact', async () => {
  const context = setup();
  context.engine.setPlan(context.user, 'platinum');
  const contact = context.engine.createContact(context.user, { name: 'Yuki', topic: 'cooking', voice: 'cedar' });
  context.engine.selectContact(context.user, contact.id);
  await ringNow(context);
  assert.equal(context.pushes[0].payload.contactName, 'Yuki');
  const call = callOf(context.store);
  assert.equal(call.contactId, contact.id);
  context.engine.markDelivered(call.id);
  context.clock.now += RING_MS;
  await context.engine.tick();
  assert.equal(context.pushes.at(-1).payload.contactName, 'Yuki');
  assert.equal(context.engine.voicemail(context.user).contact.name, 'Yuki');
});

test('the voicemail shows only while the last call is one that was missed', async () => {
  const context = setup();
  assert.equal(context.engine.voicemail(context.user), null);
  await ringNow(context);
  const missed = callOf(context.store);
  context.engine.markDelivered(missed.id);
  context.clock.now += RING_MS;
  await context.engine.tick();
  assert.ok(context.engine.voicemail(context.user));

  context.engine.callBack(context.user);
  assert.equal(context.engine.voicemail(context.user), null);
});

test('declining the next call clears the voicemail', async () => {
  const context = setup();
  await ringNow(context);
  const first = callOf(context.store);
  context.engine.markDelivered(first.id);
  context.clock.now += RING_MS;
  await context.engine.tick();
  await ringNow(context);
  context.engine.decline(callOf(context.store).id);
  assert.equal(context.engine.voicemail(context.user), null);
});

test('the streak grows once per day and survives only unbroken days', () => {
  const context = setup();
  connectToday(context);
  connectToday(context);
  assert.deepEqual(pick(context.engine.streak(context.user)), { current: 1, best: 1 });

  context.clock.now += DAY_MS;
  connectToday(context);
  context.clock.now += DAY_MS;
  connectToday(context);
  assert.deepEqual(pick(context.engine.streak(context.user)), { current: 3, best: 3 });

  context.clock.now += 2 * DAY_MS;
  assert.deepEqual(pick(context.engine.streak(context.user)), { current: 0, best: 3 });
  connectToday(context);
  assert.deepEqual(pick(context.engine.streak(context.user)), { current: 1, best: 3 });
});

const pick = ({ current, best }) => ({ current, best });
const practicedIn = (week) => week.map((day) => (day.practiced ? 'x' : '.')).join('');

test("Home's week shows the last 7 days, today last, with the days the user practiced", () => {
  const context = setup();
  connectToday(context);
  context.clock.now += DAY_MS;
  connectToday(context);
  context.clock.now += 2 * DAY_MS;
  connectToday(context);
  const { week } = context.engine.streak(context.user);
  assert.equal(week.length, 7);
  assert.equal(practicedIn(week), '...xx.x');
  assert.deepEqual(week.map((day) => day.today), [false, false, false, false, false, false, true]);
  assert.equal(week[6].weekday, new Date(context.clock.now + 9 * 3_600_000).getUTCDay(), 'the weekday in Tokyo');
  assert.equal(context.user.streak.days.length, 3, 'only day numbers are kept');
});

test('a streak from before practice days were kept is filled in from its count', () => {
  const context = setup();
  connectToday(context);
  const today = context.user.streak.lastDay;
  context.user.streak = { current: 3, best: 5, lastDay: today }; // an older record, with no days
  assert.equal(practicedIn(context.engine.streak(context.user).week), '....xxx');
  context.clock.now += DAY_MS;
  connectToday(context);
  assert.deepEqual(context.user.streak.days, [today - 2, today - 1, today, today + 1]);
});

test("Home's last call says when it was, how long, and how many words it saved", () => {
  const context = setup();
  assert.equal(context.engine.lastCall(context.user), null);
  context.user.words = [{ id: 'old', kana: 'あ', at: context.clock.now - DAY_MS }];
  const call = context.engine.callBack(context.user);
  context.engine.markConnected(context.user, call.id);
  context.user.words.unshift({ id: 'new', kana: 'い', at: context.clock.now + 1000 });
  context.engine.saveTurnMetrics(context.user, call.id, { callSeconds: 95 });
  assert.deepEqual(context.engine.lastCall(context.user), { at: context.clock.now, seconds: 95, newWords: 1 });
});

test('days off in the schedule do not break a streak', () => {
  const context = setup();
  context.engine.updateSettings(context.user, { frequency: 'weekdays' });
  context.clock.now = Date.UTC(2026, 9, 30, 3); // a Friday
  connectToday(context);
  context.clock.now += 2 * DAY_MS; // Sunday, with no call on Saturday
  assert.equal(context.engine.streak(context.user).current, 1);
  context.clock.now += DAY_MS; // Monday
  connectToday(context);
  assert.equal(context.engine.streak(context.user).current, 2);
});

test('a call that never connected does not count', () => {
  const context = setup();
  const { user: stranger } = context.engine.register('Asia/Tokyo');
  const call = context.engine.callBack(context.user);
  assert.equal(context.engine.markConnected(stranger, call.id), false);
  assert.equal(context.engine.streak(context.user).current, 0);
});

test('changing the schedule moves the next call, without a second call today', async () => {
  const context = setup();
  context.engine.updateSettings(context.user, { callStartHour: 18, callEndHour: 19 });
  assert.equal(localParts(context.user.nextCallAt, 'Asia/Tokyo').hour, 18);

  await ringNow(context);
  const firstRingDay = localDay(context.clock.now, 'Asia/Tokyo');
  context.engine.updateSettings(context.user, { callStartHour: 19, callEndHour: 21 });
  assert.notEqual(localDay(context.user.nextCallAt, 'Asia/Tokyo'), firstRingDay);
});

test('a speed change leaves the next call alone', () => {
  const context = setup();
  const before = context.user.nextCallAt;
  context.engine.updateSettings(context.user, { speed: 1.2 });
  assert.equal(context.user.nextCallAt, before);
});

test('a free stack keeps the latest 25 words', () => {
  const context = setup();
  for (let index = 0; index < FREE_WORD_LIMIT + 3; index += 1) assert.equal(context.engine.addWord(context.user, word(index)).added, true);
  assert.equal(context.user.words.length, FREE_WORD_LIMIT);
  assert.equal(context.user.words[0].kana, `あ${FREE_WORD_LIMIT + 2}`);
  assert.ok(!context.user.words.some((saved) => saved.kana === 'あ0'));
});

test('free users cannot remove words, and subscribers have no limit', () => {
  const context = setup();
  const { word: saved } = context.engine.addWord(context.user, word(0));
  assert.throws(() => context.engine.removeWord(context.user, saved.id), PlanError);
  context.engine.setPlan(context.user, 'premium');
  for (let index = 1; index < FREE_WORD_LIMIT + 10; index += 1) context.engine.addWord(context.user, word(index));
  assert.equal(context.user.words.length, FREE_WORD_LIMIT + 10);
  assert.equal(context.engine.removeWord(context.user, saved.id), true);
});

test('cancelling clears subscription words 30 days later, and keeps earlier ones', async () => {
  const context = setup();
  context.engine.addWord(context.user, word(0));
  context.engine.setPlan(context.user, 'premium');
  context.engine.addWord(context.user, word(1));
  context.engine.saveSentence(context.user, { japanese: '元気です。', english: "I'm well." });
  const call = context.engine.callBack(context.user);
  context.engine.saveConversation(context.user, call.id, [{ from: 'you', text: 'はい' }]);

  context.engine.setPlan(context.user, 'free');
  assert.equal(context.user.clearAt, context.clock.now + CANCEL_WINDOW_MS);
  context.clock.now += CANCEL_WINDOW_MS - 1;
  await context.engine.tick();
  assert.equal(context.user.words.length, 2);

  context.clock.now += 1;
  await context.engine.tick();
  assert.deepEqual(context.user.words.map((saved) => saved.kana), ['あ0']);
  assert.deepEqual(context.user.sentences, []);
  assert.deepEqual(context.user.conversations, []);
  assert.equal(context.user.clearAt, null);
});

test('resubscribing within the 30 days keeps everything', async () => {
  const context = setup();
  context.engine.setPlan(context.user, 'premium');
  context.engine.addWord(context.user, word(1));
  context.engine.setPlan(context.user, 'free');
  context.engine.setPlan(context.user, 'platinum');
  assert.equal(context.user.clearAt, null);
  context.clock.now += CANCEL_WINDOW_MS + 1;
  await context.engine.tick();
  assert.equal(context.user.words.length, 1);
});

test('example lookups are limited per day', () => {
  const context = setup();
  context.engine.setPlan(context.user, 'premium');
  const { word: saved } = context.engine.addWord(context.user, word(0));
  for (let index = 0; index < 50; index += 1) assert.equal(context.engine.startLookup(context.user, saved.id).id, saved.id);
  assert.throws(() => context.engine.startLookup(context.user, saved.id), LimitError);
  context.clock.now += DAY_MS;
  assert.ok(context.engine.startLookup(context.user, saved.id));
});

test('an account from before these features still works', () => {
  const store = new Store();
  store.users.old = {
    id: 'old',
    tokenHash: 'x',
    timeZone: 'Asia/Tokyo',
    settings: { speed: 1.1, thinkingTime: 'long', callsEnabled: true },
    subscription: null,
    nextCallAt: null,
    testRingAt: null,
    lastQuestionId: 'genki',
    messages: [{ id: 'm1', callId: 'c1', at: 1, heard: false }],
    usage: { day: null, calls: 0 },
  };
  const engine = new CallEngine({ store, sendPush: async () => ({ gone: false }), now: () => NOON_IN_TOKYO });
  const [user] = Object.values(store.users);
  assert.equal(user.settings.speed, 1.1);
  assert.equal(user.settings.formality, 'formal');
  assert.equal(user.plan, 'free');
  assert.equal(user.role, 'admin');
  assert.equal(user.turnMode, 'silence');
  assert.deepEqual(user.words, []);
  assert.equal(engine.streak(user).current, 0);
  assert.equal(engine.callBack(user).contactId, 'ping');
});

test('saved accounts on the old plan names move to the new ones and keep their contacts', () => {
  const store = new Store();
  const base = { timeZone: 'Asia/Tokyo', settings: {}, messages: [], usage: { day: null, calls: 0 } };
  store.users.plus = { ...base, id: 'plus', plan: 'plus' };
  store.users.pro = { ...base, id: 'pro', plan: 'pro', contactId: 'c1', customContacts: [{ id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', voice: 'cedar', plan: 'pro' }] };
  const engine = new CallEngine({ store, sendPush: async () => ({ gone: false }), now: () => NOON_IN_TOKYO });
  assert.equal(store.users.plus.plan, 'premium');
  assert.equal(store.users.pro.plan, 'platinum');
  const yuki = engine.contacts(store.users.pro).find((contact) => contact.name === 'Yuki');
  assert.deepEqual([yuki.available, yuki.selected, yuki.custom], [true, true, true]);
});

test('a new account keeps the role it signed up with, and an old one stays as it was', () => {
  const store = new Store();
  const engine = new CallEngine({ store, sendPush: async () => ({ gone: false }) });
  const { user: admin } = engine.register('Asia/Tokyo', 'admin');
  const { user: beta } = engine.register('Asia/Tokyo', 'beta');
  new CallEngine({ store, sendPush: async () => ({ gone: false }) });
  assert.equal(admin.role, 'admin');
  assert.equal(beta.role, 'beta');
});
