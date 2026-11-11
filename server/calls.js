// The life of a call: scheduled, ringing, then answered, declined or missed.
// All timing runs off tick(), so a restart picks up where it left off.
// Also owns each user's record: plan, contacts, streak, stack and saved conversations.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canCall, cleanContact, contactList, findContact, isPaid, MAX_CUSTOM_CONTACTS, PING, planLimits, PLANS, selectedContact } from './contacts.js';
import { recordCallDay, streakToShow } from './progress.js';
import { localDay, localDayNumber, localParts, nextCallTime } from './schedule.js';
import { applySettings, DEFAULT_SETTINGS } from './settings.js';
import { addSentence, addStarterStack, addWord, applyDowngrade, cleanSentence, cleanWord } from './stack.js';
import { pickQuestion, questionById, TURN_MODES } from './tutor.js';

export const RING_MS = 10_000;
export const DELIVERY_GRACE_MS = 30_000; // how long a ring waits for the phone to confirm it arrived
export const MAX_SESSIONS_PER_CALL = 3;
export const CANCEL_WINDOW_MS = 30 * 86_400_000;
export const MAX_LOOKUPS_PER_DAY = 50;

// Who can call as often as they like: admins testing the app, and YC reviewers trying it.
// 'admin' or 'yc', so the app can say why, or null.
export const unlimitedCalls = (user) => (user.role === 'admin' ? 'admin' : user.joinedWith === 'yc' ? 'yc' : null);

const LATE_CALL_LIMIT_MS = 5 * 60_000; // past this a due call is rescheduled, so downtime can't ring someone at 3am
const TEST_RING_DELAY_MS = 10_000; // time to start a screen recording or lock the phone
const KEEP_CALLS_MS = 7 * 86_400_000;
const KEEP_MESSAGES = 5;
const KEEP_CONVERSATIONS = 20;
const CONVERSATIONS_TO_REMEMBER = 3;
const MAX_MEMORY_LENGTH = 800;
const MAX_TRANSCRIPT_LINES = 80;
const MAX_LINE_LENGTH = 500;
const KEEP_FEEDBACK = 1000;
const MAX_ACCOUNTS_IN_REPORT = 20;
const MIN_SECONDS_TO_CONNECT = 10;
const SCHEDULE_FIELDS = ['frequency', 'customDays', 'callStartHour', 'callEndHour'];
const RENAMED_PLANS = { plus: 'premium', pro: 'platinum' };

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class LimitError extends Error {}
export class PlanError extends Error {}

const newUserFields = () => ({
  plan: 'free',
  clearAt: null, // when a downgrade takes effect: the stack shrinks to the new plan's limit
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
  joinedWith: null, // which invite code: admin, beta or yc
  joinedAt: null,
  connectedCalls: 0, // kept on the account, since calls themselves are removed after 7 days
  lastCallAt: null,
  missedCallToReturn: false, // they missed or declined a call and haven't called back yet, which doesn't use a call
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
        joinedWith: user.joinedWith ?? user.role ?? 'admin',
        plan: RENAMED_PLANS[user.plan] ?? user.plan ?? 'free',
        settings: { ...DEFAULT_SETTINGS, ...user.settings },
        missedCallToReturn: user.missedCallToReturn ?? (user.lastMissedAt ?? 0) > (user.lastCallAt ?? 0),
        usage: { ownCalls: 0, ...user.usage },
      });
      delete user.minutes; // from when plans had monthly minutes
      delete user.lastMissedAt;
      for (const contact of user.customContacts) contact.plan = 'platinum';
    }
  }

  // joinedWith is the invite code's name, which can differ from the role: YC reviewers are beta testers.
  // plan is the plan an invite code starts on: Free unless the code says otherwise.
  // starterStack gives the account a few example words and sentences to look at.
  register(timeZone, role = 'beta', joinedWith = role, plan = 'free', starterStack = false) {
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
      usage: { day: null, calls: 0, ownCalls: 0 }, // today's calls: all the user made, and those that used up the plan's calls
      ...newUserFields(),
      plan: PLANS.includes(plan) ? plan : 'free',
      joinedWith,
      joinedAt: this.now(),
    };
    if (starterStack) addStarterStack(user, { now: this.now(), newId: randomUUID, limit: planLimits(user.plan).savedItems });
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
        applyDowngrade(user, { limit: planLimits(user.plan).savedItems, keepConversations: isPaid(user.plan) });
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
      // Ping's scheduled call always comes, since one of the day's calls is kept for it, and stops at the plan's longest call.
      maxSeconds: planLimits(user.plan).perCall * 60,
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
      const user = this.store.users[call.userId];
      if (user) user.missedCallToReturn = true;
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
    user.missedCallToReturn = true;
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
    const calling = this.calling(user);
    if (!calling.canCall) throw new LimitError(calling.reason);
    this.#countCall(user);
    // A first call or returning a missed call comes first, since neither uses one of the day's calls.
    if (calling.callBackMissed) user.missedCallToReturn = false;
    else if (!calling.firstCall) user.usage.ownCalls += 1;
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
      maxSeconds: planLimits(user.plan).perCall * 60,
    };
    this.store.calls[call.id] = call;
    this.store.save();
    return call;
  }

  // What the voice engine needs to start this call. Each one costs money, so they're counted.
  sessionDetails(user, callId) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || call.state !== 'answered') return null;
    if (call.endedAt || call.sessions >= MAX_SESSIONS_PER_CALL) throw new LimitError('This call has ended.');
    // The time limit runs from the call's first connection, so reconnecting doesn't restart it.
    call.maxSeconds ??= planLimits(user.plan).perCall * 60; // calls from before there were plan limits
    const secondsLeft = call.maxSeconds - (call.startedAt ? Math.floor((this.now() - call.startedAt) / 1000) : 0);
    if (secondsLeft < MIN_SECONDS_TO_CONNECT) throw new LimitError('This call has reached its time limit.');
    call.startedAt ??= this.now();
    call.sessions += 1;
    call.turnMode = user.turnMode; // kept with the call, so its metrics report the mode it really used
    this.store.save();
    const contact = this.#contactOf(call, user);
    const local = localParts(this.now(), user.timeZone);
    return {
      question: questionById(call.questionId),
      settings: user.settings,
      localHour: local.hour,
      localDate: { year: local.year, month: local.month, day: local.day },
      calledBack: call.direction === 'outgoing',
      contact,
      memories: this.#memories(user, contact),
      turnMode: user.turnMode,
      maxSeconds: secondsLeft,
    };
  }

  // The phone reports the call ended, so it can't be reconnected.
  endCall(user, callId) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return false;
    if (!call.startedAt || call.endedAt) return true;
    call.endedAt = this.now();
    this.store.save();
    return true;
  }

  // Whether the user can call a contact right now, and the plan's limits behind it.
  // Admins and YC reviewers can call as often as they like; each call still has the plan's length.
  calling(user) {
    const { callsPerDay, perCall } = planLimits(user.plan);
    const keptForPing = this.#pingCallsToday(user);
    const callsLeft = Math.max(0, callsPerDay - (keptForPing ? 1 : 0) - this.#usageToday(user).ownCalls);
    const callBackMissed = user.missedCallToReturn;
    const firstCall = !user.lastCallAt; // a new account can try a call before Ping's first one
    const unlimited = unlimitedCalls(user);
    const canCall = Boolean(unlimited) || firstCall || callBackMissed || callsLeft > 0;
    return { perCallMinutes: perCall, callsPerDay, callsLeft, keptForPing, callBackMissed, firstCall, unlimited, canCall, reason: canCall ? null : this.#limitReason(user, keptForPing) };
  }

  #limitReason(user, keptForPing) {
    if (user.plan === 'free' && keptForPing) return 'On the Free plan, Ping calls you once a day. If you miss the call, you can call back.';
    const pingStillCalling = keptForPing && !this.#rangToday(user);
    return `You've made all your calls for today.${pingStillCalling ? ' Ping will still call you today, and you' : ' You'} can call again tomorrow.`;
  }

  // Whether Ping's scheduled call came today or is still coming, so one of the day's calls is kept for it.
  #pingCallsToday(user) {
    if (this.#rangToday(user)) return true;
    if (!user.subscription || !user.settings.callsEnabled || !user.nextCallAt) return false;
    return localDay(user.nextCallAt, user.timeZone) === localDay(this.now(), user.timeZone);
  }

  #usageToday(user) {
    const day = localDay(this.now(), user.timeZone);
    if (user.usage.day !== day) user.usage = { day, calls: 0, ownCalls: 0 };
    return user.usage;
  }

  // During a downgrade's grace period nothing is dropped, so the old plan's stack stays whole until it ends.
  #savedLimit(user) {
    return user.clearAt ? null : planLimits(user.plan).savedItems;
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
    if (!call.connectedAt) {
      user.connectedCalls += 1;
      user.lastCallAt = this.now();
    }
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
    // A downgrade keeps the old plan's stack and conversations for a grace period, and an upgrade cancels a pending one.
    const change = PLANS.indexOf(plan) - PLANS.indexOf(user.plan);
    user.plan = plan;
    if (change < 0) user.clearAt = this.now() + CANCEL_WINDOW_MS;
    else if (change > 0) user.clearAt = null;
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
    if (!word) return { added: false, invalid: true, error: 'Give the word in hiragana or katakana as kana, with its romaji and a short English meaning.' };
    const saved = addWord(user, word, { id: randomUUID(), now: this.now(), limit: this.#savedLimit(user) });
    if (!saved) {
      // Already in the stack, so the call can say so instead of looking like nothing happened.
      const existing = user.words.find((other) => other.kana === word.kana && other.kanji === word.kanji);
      return { added: false, alreadySaved: true, word: existing };
    }
    this.store.save();
    return { added: true, word: saved };
  }

  removeWord(user, wordId) {
    const before = user.words.length;
    user.words = user.words.filter((word) => word.id !== wordId);
    if (user.words.length === before) return false;
    this.store.save();
    return true;
  }

  // Each lookup costs money, so there's a daily limit.
  startLookup(user, wordId) {
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
    const sentence = cleanSentence(input);
    if (!sentence) return null;
    const saved = addSentence(user, sentence, { id: randomUUID(), now: this.now(), limit: this.#savedLimit(user) });
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

  // For admins: how many accounts joined with each invite code, and whether they've used the app.
  // Each account is one phone or browser, since joining is what creates the account.
  inviteReport(codes) {
    return codes.map((code) => {
      const users = Object.values(this.store.users).filter((user) => user.joinedWith === code);
      const accounts = users
        .map((user) => ({ joinedAt: user.joinedAt, calls: user.connectedCalls, lastCallAt: user.lastCallAt, words: user.words.length }))
        .sort((a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0));
      return {
        code,
        accounts: accounts.length,
        accountsThatCalled: accounts.filter((account) => account.calls > 0).length,
        calls: accounts.reduce((total, account) => total + account.calls, 0),
        lastJoinedAt: accounts[0]?.joinedAt ?? null,
        lastCallAt: Math.max(0, ...accounts.map((account) => account.lastCallAt ?? 0)) || null,
        newest: accounts.slice(0, MAX_ACCOUNTS_IN_REPORT),
      };
    });
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

  // DAILY_CALL_LIMIT is a safety net on top of the plan's calls, counting every call the user makes.
  // Admins and YC reviewers aren't held to it.
  #countCall(user) {
    this.#usageToday(user);
    if (this.dailyCallLimit && !unlimitedCalls(user) && user.usage.calls >= this.dailyCallLimit) throw new LimitError("That's all the calls for today. Ping will call you again soon!");
    user.usage.calls += 1;
  }
}
