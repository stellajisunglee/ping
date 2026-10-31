// The life of a call: scheduled, ringing, then answered, declined or missed.
// All timing runs off tick(), so a restart picks up where it left off.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { localDay, localParts, nextCallTime } from './schedule.js';
import { applySettings, DEFAULT_SETTINGS } from './settings.js';
import { pickQuestion, questionById } from './tutor.js';

export const RING_MS = 10_000;
export const DELIVERY_GRACE_MS = 30_000; // how long a ring waits for the phone to confirm it arrived
export const MAX_SESSIONS_PER_CALL = 3;
const LATE_CALL_LIMIT_MS = 5 * 60_000; // past this a due call is rescheduled, so downtime can't ring someone at 3am
const TEST_RING_DELAY_MS = 5_000;
const KEEP_CALLS_MS = 7 * 86_400_000;
const KEEP_MESSAGES = 5;

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class LimitError extends Error {}

export class CallEngine {
  // No dailyCallLimit means unlimited calls, which is for prototyping only. See "Before beta launch" in the README.
  constructor({ store, sendPush, now = Date.now, random = Math.random, dailyCallLimit = null }) {
    this.dailyCallLimit = dailyCallLimit;
    this.store = store;
    this.sendPush = sendPush;
    this.now = now;
    this.random = random;
  }

  register(timeZone) {
    const token = randomBytes(32).toString('base64url');
    const user = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      timeZone,
      settings: { ...DEFAULT_SETTINGS },
      subscription: null,
      nextCallAt: null,
      testRingAt: null,
      lastQuestionId: null,
      messages: [],
      usage: { day: null, calls: 0 },
    };
    this.store.users[user.id] = user;
    this.store.save();
    return { user, token };
  }

  userForToken(token) {
    if (!token) return null;
    const hash = hashToken(token);
    return Object.values(this.store.users).find((user) => user.tokenHash === hash) ?? null;
  }

  setSubscription(user, subscription, timeZone) {
    user.subscription = subscription;
    if (timeZone) user.timeZone = timeZone;
    if (!user.nextCallAt || user.nextCallAt <= this.now()) this.#schedule(user);
    this.store.save();
  }

  updateSettings(user, change) {
    user.settings = applySettings(user.settings, change);
    if (user.settings.callsEnabled && (!user.nextCallAt || user.nextCallAt <= this.now())) this.#schedule(user);
    this.store.save();
    return user.settings;
  }

  deleteUser(user) {
    for (const call of Object.values(this.store.calls)) {
      if (call.userId === user.id) delete this.store.calls[call.id];
    }
    delete this.store.users[user.id];
    this.store.save();
  }

  requestTestRing(user) {
    if (!user.subscription) throw new LimitError('Turn on notifications first.');
    this.#countCall(user);
    user.testRingAt = this.now() + TEST_RING_DELAY_MS;
    this.store.save();
  }

  async tick() {
    const now = this.now();
    const jobs = [];
    for (const call of Object.values(this.store.calls)) {
      if (call.state === 'ringing' && now >= call.ringDeadline) jobs.push(this.#miss(call));
      else if (now - call.createdAt > KEEP_CALLS_MS) delete this.store.calls[call.id];
    }
    for (const user of Object.values(this.store.users)) {
      if (user.testRingAt && now >= user.testRingAt) {
        user.testRingAt = null;
        jobs.push(this.#ring(user));
      } else if (user.nextCallAt && now >= user.nextCallAt && user.subscription && user.settings.callsEnabled) {
        const onTime = now - user.nextCallAt <= LATE_CALL_LIMIT_MS;
        this.#schedule(user, { skipToday: onTime });
        if (onTime) jobs.push(this.#ring(user));
        else this.store.save();
      }
    }
    await Promise.all(jobs);
  }

  async #ring(user) {
    if (this.#activeCall(user)) return;
    const now = this.now();
    const question = pickQuestion(user.lastQuestionId, this.random);
    user.lastQuestionId = question.id;
    const call = {
      id: randomUUID(),
      userId: user.id,
      questionId: question.id,
      direction: 'incoming',
      state: 'ringing',
      createdAt: now,
      ringDeadline: now + DELIVERY_GRACE_MS,
      deliveredAt: null,
      sessions: 0,
    };
    this.store.calls[call.id] = call;
    this.store.save();
    const { gone } = await this.sendPush(user.subscription, { type: 'ring', callId: call.id }, { ttl: DELIVERY_GRACE_MS / 1000 });
    if (gone) {
      user.subscription = null;
      call.state = 'undelivered';
      this.store.save();
    }
  }

  // The service worker confirms the ring reached the phone, which starts the 10 seconds.
  markDelivered(callId) {
    const call = this.store.calls[callId];
    if (!call) return null;
    if (call.state === 'ringing' && !call.deliveredAt) {
      call.deliveredAt = this.now();
      call.ringDeadline = call.deliveredAt + RING_MS;
      this.store.save();
    }
    return call;
  }

  answer(callId) {
    const call = this.store.calls[callId];
    if (!call) return null;
    if (call.state === 'ringing') {
      call.state = 'answered';
      this.store.save();
    }
    return call;
  }

  decline(callId) {
    const call = this.store.calls[callId];
    if (!call) return null;
    if (call.state === 'ringing') {
      call.state = 'declined';
      this.store.save();
    }
    return call;
  }

  async #miss(call) {
    call.state = 'missed';
    const user = this.store.users[call.userId];
    if (!user) return;
    const message = { id: randomUUID(), callId: call.id, at: this.now(), heard: false };
    user.messages = [message, ...user.messages].slice(0, KEEP_MESSAGES);
    this.store.save();
    if (!user.subscription) return;
    const { gone } = await this.sendPush(user.subscription, { type: 'missed', callId: call.id }, { ttl: 86_400 });
    if (gone) {
      user.subscription = null;
      this.store.save();
    }
  }

  // The user calling Mina back, from a voice message or the call button.
  callBack(user) {
    this.#countCall(user);
    const question = pickQuestion(user.lastQuestionId, this.random);
    user.lastQuestionId = question.id;
    const now = this.now();
    const call = {
      id: randomUUID(),
      userId: user.id,
      questionId: question.id,
      direction: 'outgoing',
      state: 'answered',
      createdAt: now,
      ringDeadline: now,
      deliveredAt: now,
      sessions: 0,
    };
    this.store.calls[call.id] = call;
    this.store.save();
    return call;
  }

  // What the voice engine needs to start this call. Each one costs money, so they're counted.
  sessionDetails(user, callId) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || call.state !== 'answered') return null;
    if (call.sessions >= MAX_SESSIONS_PER_CALL) throw new LimitError('This call has ended. Please call Mina back.');
    call.sessions += 1;
    this.store.save();
    return {
      question: questionById(call.questionId),
      settings: user.settings,
      localHour: localParts(this.now(), user.timeZone).hour,
      calledBack: call.direction === 'outgoing',
    };
  }

  markHeard(user, messageId) {
    const message = user.messages.find((candidate) => candidate.id === messageId);
    if (!message) return false;
    message.heard = true;
    this.store.save();
    return true;
  }

  #activeCall(user) {
    return Object.values(this.store.calls).find((call) => call.userId === user.id && call.state === 'ringing');
  }

  #schedule(user, { skipToday = false } = {}) {
    user.nextCallAt = nextCallTime({ now: this.now(), timeZone: user.timeZone, skipToday, random: this.random });
  }

  #countCall(user) {
    const day = localDay(this.now(), user.timeZone);
    if (user.usage.day !== day) user.usage = { day, calls: 0 };
    if (this.dailyCallLimit && user.usage.calls >= this.dailyCallLimit) throw new LimitError("That's all the calls for today. Mina will call you tomorrow!");
    user.usage.calls += 1;
  }
}
