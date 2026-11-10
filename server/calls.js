// The life of a call: scheduled, ringing, then answered, declined or missed.
// All timing runs off tick(), so a restart picks up where it left off.
// Also owns each user's record: plan, contacts, streak, stack and saved conversations.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canCall, cleanContact, contactList, findContact, isPaid, MAX_CUSTOM_CONTACTS, PING, PLANS, selectedContact } from './contacts.js';
import { recordCallDay, streakToShow } from './progress.js';
import { localDay, localDayNumber, localParts, nextCallTime } from './schedule.js';
import { applySettings, DEFAULT_SETTINGS } from './settings.js';
import { addSentence, addWord, cleanSentence, cleanWord, clearSubscriptionData } from './stack.js';
import { pickQuestion, questionById, TURN_MODES } from './tutor.js';

export const RING_MS = 10_000;
export const DELIVERY_GRACE_MS = 30_000; // how long a ring waits for the phone to confirm it arrived
export const MAX_SESSIONS_PER_CALL = 3;
export const CANCEL_WINDOW_MS = 30 * 86_400_000;
export const MAX_LOOKUPS_PER_DAY = 50;
const LATE_CALL_LIMIT_MS = 5 * 60_000; // past this a due call is rescheduled, so downtime can't ring someone at 3am
const TEST_RING_DELAY_MS = 5_000;
const KEEP_CALLS_MS = 7 * 86_400_000;
const KEEP_MESSAGES = 5;
const KEEP_CONVERSATIONS = 20;
const CONVERSATIONS_TO_REMEMBER = 3;
const MAX_MEMORY_LENGTH = 800;
const MAX_TRANSCRIPT_LINES = 80;
const MAX_LINE_LENGTH = 500;
const KEEP_FEEDBACK = 1000;
const SCHEDULE_FIELDS = ['frequency', 'customDays', 'callStartHour', 'callEndHour'];
const RENAMED_PLANS = { plus: 'premium', pro: 'platinum' };

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class LimitError extends Error {}
export class PlanError extends Error {}

const newUserFields = () => ({
  plan: 'free',
  clearAt: null, // when a cancelled subscription's words, sentences and conversations are removed
  contactId: PING.id,
  customContacts: [],
  words: [],
  sentences: [],
  conversations: [],
  streak: { current: 0, best: 0, lastDay: null },
  lastCallOutcome: null,
  lastRingDay: null,
  lookups: { day: null, count: 0 },
  turnMode: 'silence', // only an admin can change it, to compare turn detectors
});

export class CallEngine {
  // No dailyCallLimit means unlimited calls, which is for prototyping only. See "Before beta launch" in the README.
  constructor({ store, sendPush, now = Date.now, random = Math.random, dailyCallLimit = null }) {
    this.dailyCallLimit = dailyCallLimit;
    this.store = store;
    this.sendPush = sendPush;
    this.now = now;
    this.random = random;
    // Accounts saved by an older version pick up any fields they're missing.
    for (const user of Object.values(store.users)) {
      Object.assign(user, {
        ...newUserFields(),
        ...user,
        role: user.role ?? 'admin', // accounts from before there were two invite codes
        plan: RENAMED_PLANS[user.plan] ?? user.plan ?? 'free',
        settings: { ...DEFAULT_SETTINGS, ...user.settings },
      });
      for (const contact of user.customContacts) contact.plan = 'platinum';
    }
  }

  register(timeZone, role = 'beta') {
    const token = randomBytes(32).toString('base64url');
    const user = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      role,
      timeZone,
      settings: { ...DEFAULT_SETTINGS },
      subscription: null,
      nextCallAt: null,
      testRingAt: null,
      lastQuestionId: null,
      messages: [],
      usage: { day: null, calls: 0 },
      ...newUserFields(),
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
    if (!user.nextCallAt || user.nextCallAt <= this.now()) this.#schedule(user, { skipToday: this.#rangToday(user) });
    this.store.save();
  }

  updateSettings(user, change) {
    const before = user.settings;
    user.settings = applySettings(before, change);
    const scheduleChanged = SCHEDULE_FIELDS.some((field) => String(before[field]) !== String(user.settings[field]));
    if (user.settings.callsEnabled && (scheduleChanged || !user.nextCallAt || user.nextCallAt <= this.now())) {
      this.#schedule(user, { skipToday: this.#rangToday(user) });
    }
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
      if (user.clearAt && now >= user.clearAt) {
        clearSubscriptionData(user);
        this.store.save();
      }
      if (user.testRingAt && now >= user.testRingAt) {
        user.testRingAt = null;
        jobs.push(this.#ring(user));
      } else if (user.nextCallAt && now >= user.nextCallAt && user.subscription && user.settings.callsEnabled) {
        const onTime = now - user.nextCallAt <= LATE_CALL_LIMIT_MS;
        if (onTime) user.lastRingDay = localDay(now, user.timeZone);
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
    const contact = selectedContact(user);
    const question = pickQuestion(user.lastQuestionId, this.random);
    user.lastQuestionId = question.id;
    const call = {
      id: randomUUID(),
      userId: user.id,
      contactId: contact.id,
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
    const { gone } = await this.sendPush(user.subscription, { type: 'ring', callId: call.id, contactName: contact.name }, { ttl: DELIVERY_GRACE_MS / 1000 });
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
      this.#recordOutcome(call, 'answered');
      this.store.save();
    }
    return call;
  }

  decline(callId) {
    const call = this.store.calls[callId];
    if (!call) return null;
    if (call.state === 'ringing') {
      call.state = 'declined';
      this.#recordOutcome(call, 'declined');
      this.store.save();
    }
    return call;
  }

  async #miss(call) {
    call.state = 'missed';
    const user = this.store.users[call.userId];
    if (!user) return;
    const contact = this.#contactOf(call, user);
    const message = { id: randomUUID(), callId: call.id, contactId: contact.id, at: this.now(), heard: false };
    user.messages = [message, ...user.messages].slice(0, KEEP_MESSAGES);
    user.lastCallOutcome = 'missed';
    this.store.save();
    if (!user.subscription) return;
    const { gone } = await this.sendPush(user.subscription, { type: 'missed', callId: call.id, contactName: contact.name }, { ttl: 86_400 });
    if (gone) {
      user.subscription = null;
      this.store.save();
    }
  }

  // The user calling a contact, from a voice message or the Contacts tab.
  callBack(user, contactId = null) {
    const contact = contactId ? findContact(user, contactId) : selectedContact(user);
    if (!contact) throw new PlanError('That contact is no longer available.');
    if (!canCall(user, contact)) throw new PlanError(`Upgrade your plan to call ${contact.name}.`);
    this.#countCall(user);
    const question = pickQuestion(user.lastQuestionId, this.random);
    user.lastQuestionId = question.id;
    user.lastCallOutcome = 'answered';
    const now = this.now();
    const call = {
      id: randomUUID(),
      userId: user.id,
      contactId: contact.id,
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
    if (call.sessions >= MAX_SESSIONS_PER_CALL) throw new LimitError('This call has ended. Please call back.');
    call.sessions += 1;
    call.turnMode = user.turnMode; // kept with the call, so its metrics report the mode it really used
    this.store.save();
    const contact = this.#contactOf(call, user);
    return {
      question: questionById(call.questionId),
      settings: user.settings,
      localHour: localParts(this.now(), user.timeZone).hour,
      calledBack: call.direction === 'outgoing',
      contact,
      memories: this.#memories(user, contact),
      turnMode: user.turnMode,
    };
  }

  setTurnMode(user, turnMode) {
    if (!TURN_MODES.includes(turnMode)) return false;
    user.turnMode = turnMode;
    this.store.save();
    return true;
  }

  // The call connected, so today counts toward the streak.
  markConnected(user, callId) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || call.state !== 'answered') return false;
    call.connectedAt = this.now();
    user.streak = recordCallDay(user.streak, localDayNumber(this.now(), user.timeZone), user.settings);
    this.store.save();
    return true;
  }

  // Saves a call's turn-taking numbers with the settings they were measured under, and returns the record.
  saveTurnMetrics(user, callId, metrics) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return null;
    const { thinkingTime, speed, proficiency } = user.settings;
    call.turnMetrics = { callId, ...metrics, turnMode: call.turnMode ?? user.turnMode, thinkingTime, speed, proficiency };
    this.store.save();
    return call.turnMetrics;
  }

  // Home's summary of the latest call that connected in the last 7 days: when, how long, and how many words
  // it saved. Words are only saved during calls, so every word since it started came from it.
  lastCall(user) {
    const calls = Object.values(this.store.calls).filter((call) => call.userId === user.id && call.connectedAt);
    if (!calls.length) return null;
    const last = calls.reduce((latest, call) => (call.connectedAt > latest.connectedAt ? call : latest));
    return {
      at: last.connectedAt,
      seconds: last.turnMetrics?.callSeconds ?? null,
      newWords: user.words.filter((word) => word.at >= last.connectedAt).length,
    };
  }

  streak(user) {
    return streakToShow(user.streak, localDayNumber(this.now(), user.timeZone), user.settings);
  }

  markHeard(user, messageId) {
    const message = user.messages.find((candidate) => candidate.id === messageId);
    if (!message) return false;
    message.heard = true;
    this.store.save();
    return true;
  }

  // The voicemail only shows while the most recent call is one the user missed.
  voicemail(user) {
    const [message] = user.messages;
    if (user.lastCallOutcome !== 'missed' || !message) return null;
    return { message, contact: findContact(user, message.contactId) ?? PING };
  }

  contactNameOf(call) {
    const user = this.store.users[call.userId];
    return user ? this.#contactOf(call, user).name : PING.name;
  }

  // Only admins can reach this for now, through a test switch. Real payments would call it after checkout.
  setPlan(user, plan) {
    if (!PLANS.includes(plan)) return false;
    const cancelled = isPaid(user.plan) && !isPaid(plan);
    user.plan = plan;
    if (cancelled) user.clearAt = this.now() + CANCEL_WINDOW_MS;
    else if (isPaid(plan)) user.clearAt = null;
    user.contactId = selectedContact(user).id;
    this.store.save();
    return true;
  }

  selectContact(user, contactId) {
    const contact = findContact(user, contactId);
    if (!contact) return false;
    if (!canCall(user, contact)) throw new PlanError('Upgrade your plan to choose this contact.');
    user.contactId = contact.id;
    this.store.save();
    return true;
  }

  createContact(user, input) {
    if (user.plan !== 'platinum') throw new PlanError('Creating your own contact is part of the Platinum plan.');
    if (user.customContacts.length >= MAX_CUSTOM_CONTACTS) throw new LimitError(`You can have up to ${MAX_CUSTOM_CONTACTS} of your own contacts.`);
    const details = cleanContact(input);
    if (!details) return null;
    const contact = { id: randomUUID(), ...details };
    user.customContacts = [...user.customContacts, contact];
    this.store.save();
    return contact;
  }

  deleteContact(user, contactId) {
    const before = user.customContacts.length;
    user.customContacts = user.customContacts.filter((contact) => contact.id !== contactId);
    if (user.customContacts.length === before) return false;
    user.contactId = selectedContact(user).id;
    this.store.save();
    return true;
  }

  contactById(contactId) {
    if (contactId === PING.id) return PING;
    for (const user of Object.values(this.store.users)) {
      const contact = user.customContacts.find((candidate) => candidate.id === contactId);
      if (contact) return contact;
    }
    return null;
  }

  // Never throws, because the voice model is what's calling this and it only needs to hear whether it worked.
  addWord(user, input) {
    const word = cleanWord(input);
    if (!word) return { added: false, invalid: true };
    const saved = addWord(user, word, { id: randomUUID(), now: this.now(), paid: isPaid(user.plan) });
    if (saved) this.store.save();
    return { added: Boolean(saved), word: saved };
  }

  removeWord(user, wordId) {
    if (!isPaid(user.plan)) throw new PlanError('Removing words is part of a subscription.');
    const before = user.words.length;
    user.words = user.words.filter((word) => word.id !== wordId);
    if (user.words.length === before) return false;
    this.store.save();
    return true;
  }

  // Each lookup costs money, so a plan check and a daily limit come first.
  startLookup(user, wordId) {
    if (!isPaid(user.plan)) throw new PlanError('Example sentences are part of a subscription.');
    const word = user.words.find((candidate) => candidate.id === wordId);
    if (!word) return null;
    const day = localDay(this.now(), user.timeZone);
    if (user.lookups.day !== day) user.lookups = { day, count: 0 };
    if (user.lookups.count >= MAX_LOOKUPS_PER_DAY) throw new LimitError("That's all the example sentences for today. Try again tomorrow.");
    user.lookups.count += 1;
    this.store.save();
    return word;
  }

  saveSentence(user, input) {
    if (!isPaid(user.plan)) throw new PlanError('Saving sentences is part of a subscription.');
    const sentence = cleanSentence(input);
    if (!sentence) return null;
    const saved = addSentence(user, sentence, { id: randomUUID(), now: this.now() });
    this.store.save();
    return saved;
  }

  removeSentence(user, sentenceId) {
    const before = user.sentences.length;
    user.sentences = user.sentences.filter((sentence) => sentence.id !== sentenceId);
    if (user.sentences.length === before) return false;
    this.store.save();
    return true;
  }

  // Only subscribers' conversations are kept, to personalize their future calls.
  saveConversation(user, callId, lines) {
    if (!isPaid(user.plan) || !Array.isArray(lines)) return false;
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return false;
    const cleanLines = lines
      .filter((line) => (line?.from === 'you' || line?.from === 'contact') && typeof line.text === 'string' && line.text.trim())
      .slice(-MAX_TRANSCRIPT_LINES)
      .map(({ from, text }) => ({ from, text: text.trim().slice(0, MAX_LINE_LENGTH) }));
    if (!cleanLines.some((line) => line.from === 'you')) return false;
    const conversation = { callId, contactId: call.contactId, at: this.now(), lines: cleanLines };
    user.conversations = [conversation, ...user.conversations.filter((saved) => saved.callId !== callId)].slice(0, KEEP_CONVERSATIONS);
    this.store.save();
    return true;
  }

  addFeedback(text) {
    this.store.feedback = [{ at: this.now(), text }, ...this.store.feedback].slice(0, KEEP_FEEDBACK);
    this.store.save();
  }

  contacts(user) {
    return contactList(user);
  }

  #memories(user, contact) {
    if (!isPaid(user.plan)) return [];
    return user.conversations
      .filter((conversation) => conversation.contactId === contact.id)
      .slice(0, CONVERSATIONS_TO_REMEMBER)
      .map((conversation) =>
        conversation.lines
          .filter((line) => line.from === 'you')
          .map((line) => line.text)
          .join(' ')
          .slice(0, MAX_MEMORY_LENGTH),
      );
  }

  #contactOf(call, user) {
    return findContact(user, call.contactId) ?? PING;
  }

  #recordOutcome(call, outcome) {
    const user = this.store.users[call.userId];
    if (user) user.lastCallOutcome = outcome;
  }

  #activeCall(user) {
    return Object.values(this.store.calls).find((call) => call.userId === user.id && call.state === 'ringing');
  }

  #rangToday(user) {
    return user.lastRingDay === localDay(this.now(), user.timeZone);
  }

  #schedule(user, { skipToday = false } = {}) {
    user.nextCallAt = nextCallTime({ now: this.now(), timeZone: user.timeZone, skipToday, random: this.random, settings: user.settings });
  }

  #countCall(user) {
    const day = localDay(this.now(), user.timeZone);
    if (user.usage.day !== day) user.usage = { day, calls: 0 };
    if (this.dailyCallLimit && user.usage.calls >= this.dailyCallLimit) throw new LimitError("That's all the calls for today. Ping will call you again soon!");
    user.usage.calls += 1;
  }
}
