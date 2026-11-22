// The life of a call: scheduled, ringing, then answered, declined or missed.
// All timing runs off tick(), so a restart picks up where it left off.
// Also owns each user's record: plan, contacts, streak, stack and saved conversations.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canCall, cleanContact, contactList, findContact, isPaid, MAX_CUSTOM_CONTACTS, PING, planLimits, PLANS, selectedContact } from './contacts.js';
import { recordCallDay, streakToShow } from './progress.js';
import { hourWeights, localDay, localDayNumber, localParts, nextCallTime } from './schedule.js';
import { applySettings, DEFAULT_SETTINGS, LEGACY_LEVELS, PROFICIENCY_LEVELS } from './settings.js';
import { addSentence, addStarterStack, addWord, applyDowngrade, cleanSentence, cleanSentenceWords, cleanWord } from './stack.js';
import { pickQuestion, questionById, TURN_MODES } from './tutor.js';
import { comboKey, ENGINES, FALLBACK_COMBO, pickCombo, RANDOM_MIX, validCombo } from './experiment.js';
import { CHECK_RESULTS, scenarioById, SCENARIOS, TOPIC_MODES } from './scenarios.js';

export const RING_MS = 10_000;
export const DELIVERY_GRACE_MS = 30_000; // how long a ring waits for the phone to confirm it arrived
export const MAX_SESSIONS_PER_CALL = 3;
export const CANCEL_WINDOW_MS = 30 * 86_400_000;
export const MAX_LOOKUPS_PER_DAY = 50;
// A call that breaks within this long of connecting doesn't use up a call, so the user can try again.
// Only a break counts, never the user or the contact ending it, and only a few times a day.
export const RETRY_WITHIN_SECONDS = 30;
export const MAX_RETRIES_PER_DAY = 2;
const BROKEN_CALL_REASONS = new Set(['dropped', 'failed', 'unavailable']);

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
const KEEP_RATINGS = 200;
const KEEP_PROGRESS = 1000; // calls in a learner's progress history, and level estimates, outside admin and beta accounts
const KEEP_HISTORY = 200; // calls in the Calls tab, outside admin and beta accounts
const RECENT_CALLS = 100; // how many the Calls tab shows
const HABIT_DAYS = 28; // the window the habit numbers look back over
const DAY_MS = 86_400_000;
// A speaking level is shown once this many calls have been graded, as the middle of the latest this many.
export const LEVEL_SAMPLE = 5;
const JLPT_ORDER = ['N5', 'N4', 'N3', 'N2', 'N1'];
const KEEP_CALL_LOG = 5000;
const MIN_SECONDS_TO_CONNECT = 10;
const SCHEDULE_FIELDS = ['frequency', 'customDays', 'callStartHour', 'callEndHour'];
const RENAMED_PLANS = { plus: 'premium', pro: 'platinum' };

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class LimitError extends Error {}
export class PlanError extends Error {}

// The Privacy Policy's version. 2: calls are recorded. 3: Deepgram joins OpenAI as a voice service.
// Accounts that saw an older version get a one-time notice on Home about what changed since.
export const POLICY_VERSION = 4; // 2: calls recorded, 3: Deepgram named, 4: post-call comments, testers' data kept, learning numbers and level estimates
const RECORDING_POLICY = 2;
export const policyNoticeFor = (seen = 0) => (seen >= POLICY_VERSION ? null : seen < RECORDING_POLICY ? 'recording' : 'update');
// Admins and beta testers record every call as part of testing. YC reviewers and everyone else
// can turn recording off in Manage Account, which stops future recordings only.
export const recordingLocked = (user) => user.role === 'admin' || user.joinedWith === 'beta';
export const recordsCalls = (user) => recordingLocked(user) || !user.recordingOff;
// Admin and beta tester accounts are for building Ping, so nothing of theirs expires or is trimmed: calls, ratings,
// comments and their call log entries stay until an admin deletes the call or the account is deleted.
export const keepsEverything = (user) => user?.role === 'admin' || user?.joinedWith === 'beta';

// A call's rating is two whole numbers from 1 to 5, or nothing.
export function cleanRating(body) {
  const scale = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
  return scale(body?.cutOffs) && scale(body?.naturalness) ? { cutOffs: body.cutOffs, naturalness: body.naturalness } : null;
}

// The optional comment under the ratings: what felt natural or unnatural. Plain text, trimmed and capped, or null.
export const MAX_COMMENT_LENGTH = 1000;
export const cleanComment = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_COMMENT_LENGTH) : null);

// A transcript as the phone sends it, kept to who said what: 'you' or 'contact'.
export const cleanTranscript = (lines) =>
  (Array.isArray(lines) ? lines : [])
    .filter((line) => (line?.from === 'you' || line?.from === 'contact') && typeof line.text === 'string' && line.text.trim())
    .map(({ from, text }) => ({ from, text: text.trim().slice(0, MAX_LINE_LENGTH) }));

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
  turnMode: 'silence', // an admin's own pick, used only when callSetupManual is on
  engine: 'gpt-realtime', // likewise
  callSetupManual: false, // admins only: pick the engine and turn mode instead of being randomized
  topicMode: 'randomized', // admins only: 'controlled' starts every call with scenarioId's opening question
  scenarioId: null,
  comboCounts: {}, // calls randomized to each engine and turn mode, so the next goes to the least used
  joinedWith: null, // which invite code: admin, beta or yc
  joinedAt: null,
  connectedCalls: 0, // kept on the account, since calls themselves are removed after 7 days
  lastCallAt: null,
  missedCallToReturn: false, // they missed or declined a call and haven't called back yet, which doesn't use a call
  recordingOff: false, // turned off in Manage Account, where the account allows it
  ratings: [], // the 1-5 taps after each call: how often Ping cut them off, and how natural it felt
  policyVersion: 0, // the Privacy Policy version they've seen. 0: joined before calls were recorded
  levelChosen: false, // whether they've picked their JLPT level. Everyone picks one before they first reach Home
  progress: [], // one entry per call: speaking time, English share, Japanese characters, estimated level (numbers and levels only)
  levelEstimates: [], // the model's speaking-level estimate for each graded call, newest first, with its one-line reason
  callHistory: [], // the Calls tab: each call to or from a contact, with how it went. Kept after the call record is removed
});

// Accounts saved before JLPT levels keep their old level's place on the scale until they pick one.
function withJlptLevel(settings) {
  const proficiency = LEGACY_LEVELS[settings.proficiency] ?? (PROFICIENCY_LEVELS.includes(settings.proficiency) ? settings.proficiency : DEFAULT_SETTINGS.proficiency);
  return { ...settings, proficiency };
}

export class CallEngine {
  // No dailyCallLimit means unlimited calls, which is for prototyping only. See "Before beta launch" in the README.
  // engineReady says whether an engine can run here (Deepgram needs its key). Engines that can't are left out of the random mix.
  constructor({ store, sendPush, now = Date.now, random = Math.random, dailyCallLimit = null, engineReady = () => true }) {
    this.dailyCallLimit = dailyCallLimit;
    this.engineReady = engineReady;
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
        settings: withJlptLevel({ ...DEFAULT_SETTINGS, ...user.settings }),
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
      policyVersion: POLICY_VERSION, // the join screen tells them what the policy says
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
    if (PROFICIENCY_LEVELS.includes(change.proficiency)) user.levelChosen = true;
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
    this.store.callLog = this.store.callLog.filter((entry) => entry.userId !== user.id);
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
      else if (now - call.createdAt > KEEP_CALLS_MS && !keepsEverything(this.store.users[call.userId])) delete this.store.calls[call.id];
    }
    for (const user of Object.values(this.store.users)) {
      if (user.clearAt && now >= user.clearAt) {
        applyDowngrade(user, { limit: planLimits(user.plan).savedItems, keepConversations: isPaid(user.plan) });
        this.store.save();
      }
      if (user.testRingAt && now >= user.testRingAt) {
        user.testRingAt = null;
        jobs.push(this.#ring(user, { test: true }));
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

  async #ring(user, { test = false } = {}) {
    if (this.#activeCall(user)) return;
    const now = this.now();
    const contact = selectedContact(user);
    const call = {
      id: randomUUID(),
      userId: user.id,
      contactId: contact.id,
      ...this.#pickTopic(user),
      direction: 'incoming',
      state: 'ringing',
      createdAt: now,
      ringDeadline: now + DELIVERY_GRACE_MS,
      deliveredAt: null,
      sessions: 0,
      ...(test ? { test: true } : {}), // an admin's "ring my phone", left out of the habit numbers
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
      // How long the phone rang before they picked up, from when the ring reached it.
      this.#history(call, { outcome: 'answered', pickupSeconds: Math.max(0, Math.round((this.now() - (call.deliveredAt ?? call.createdAt)) / 1000)) });
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
      this.#history(call, { outcome: 'declined' });
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
    this.#history(call, { outcome: 'missed' });
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
    // A first call, returning a missed call, or trying again after a call broke come first, since none uses one of the day's calls.
    if (calling.callBackMissed) user.missedCallToReturn = false;
    else if (calling.retryAfterDrop) user.usage.retryAfterDrop = false;
    else if (!calling.firstCall) user.usage.ownCalls += 1;
    const topic = this.#pickTopic(user);
    user.lastCallOutcome = 'answered';
    const now = this.now();
    const call = {
      id: randomUUID(),
      userId: user.id,
      contactId: contact.id,
      ...topic,
      direction: 'outgoing',
      state: 'answered',
      createdAt: now,
      ringDeadline: now,
      deliveredAt: now,
      sessions: 0,
      maxSeconds: planLimits(user.plan).perCall * 60,
    };
    this.store.calls[call.id] = call;
    this.#history(call, { outcome: 'calling' });
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
    call.recorded ??= recordsCalls(user); // decided once, when the call first connects
    if (!call.engine) this.#assignCombo(call, user); // likewise, and logged with the above
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
      engine: call.engine,
      turnMode: call.turnMode,
      maxSeconds: secondsLeft,
    };
  }

  // The phone reports the call ended, so it can't be reconnected, and why: 'dropped', 'failed', 'hung-up' and so on.
  endCall(user, callId, reason = null) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return false;
    this.#retryIfBroken(user, call, reason);
    if (!call.startedAt || call.endedAt) return true;
    call.endedAt = this.now();
    // Kept in the log, since the call itself is removed after 7 days. Missing means the phone never said.
    this.#log(call, { seconds: Math.round((call.endedAt - (call.connectedAt ?? call.startedAt)) / 1000), endReason: call.endReason });
    if (call.connectedAt) this.#history(call, { seconds: Math.round((call.endedAt - call.connectedAt) / 1000) });
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
    const retryAfterDrop = Boolean(this.#usageToday(user).retryAfterDrop);
    const unlimited = unlimitedCalls(user);
    const canCall = Boolean(unlimited) || firstCall || callBackMissed || retryAfterDrop || callsLeft > 0;
    return { perCallMinutes: perCall, callsPerDay, callsLeft, keptForPing, callBackMissed, retryAfterDrop, firstCall, unlimited, canCall, reason: canCall ? null : this.#limitReason(user, keptForPing) };
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

  // A call that broke within RETRY_WITHIN_SECONDS of connecting, or before it connected at all, gives the user one
  // more call that doesn't count, up to MAX_RETRIES_PER_DAY times a day. The connected time is the server's own,
  // and only the call's first end report counts, so ending a call and then reporting it as dropped earns nothing.
  // The phone's safety-net count (DAILY_CALL_LIMIT) still counts every call.
  #retryIfBroken(user, call, reason) {
    const firstReport = call.endReason === undefined;
    call.endReason ??= reason ?? 'unknown';
    if (!firstReport || !BROKEN_CALL_REASONS.has(reason) || unlimitedCalls(user)) return;
    const connectedSeconds = call.connectedAt ? ((call.endedAt ?? this.now()) - call.connectedAt) / 1000 : 0;
    if (connectedSeconds >= RETRY_WITHIN_SECONDS) return;
    const usage = this.#usageToday(user);
    if ((usage.retriesGiven ?? 0) >= MAX_RETRIES_PER_DAY) return;
    usage.retriesGiven = (usage.retriesGiven ?? 0) + 1;
    usage.retryAfterDrop = true;
    this.store.save();
  }

  // During a downgrade's grace period nothing is dropped, so the old plan's stack stays whole until it ends.
  #savedLimit(user) {
    return user.clearAt ? null : planLimits(user.plan).savedItems;
  }

  // Admins only: pick the engine and turn mode for their own calls, or go back to being randomized.
  setCallSetup(user, { manual, engine = user.engine, turnMode = user.turnMode }) {
    if (!ENGINES[engine]) return false;
    const usesTurnModes = ENGINES[engine].turnModes.length > 0;
    if (!validCombo({ engine, turnMode: usesTurnModes ? turnMode : null })) return false;
    if (typeof manual === 'boolean') user.callSetupManual = manual;
    user.engine = engine;
    if (usesTurnModes) user.turnMode = turnMode;
    this.store.save();
    return true;
  }

  // Admins only: start every call with a test scenario's opening question, or go back to random questions.
  // Separate from the engine and turn mode, so one scenario can be run on each of them.
  setTopicSetup(user, { topicMode = user.topicMode, scenarioId = user.scenarioId ?? SCENARIOS[0].id }) {
    if (!TOPIC_MODES.includes(topicMode) || !scenarioById(scenarioId)) return false;
    user.topicMode = topicMode;
    user.scenarioId = scenarioId;
    this.store.save();
    return true;
  }

  // An admin's pass, fail or unclear for one checkpoint of the scenario their call ran, or null to clear it.
  // Kept apart from the ratings, one record per checkpoint, so manual test scores never mix with how users rate calls.
  saveScenarioCheck(user, callId, { checkpointId, result }) {
    const call = this.store.calls[callId];
    const scenario = scenarioById(call?.scenarioId);
    if (!call || call.userId !== user.id || user.role !== 'admin' || !scenario) return null;
    if (!scenario.checkpoints.some((checkpoint) => checkpoint.id === checkpointId) || !(result === null || CHECK_RESULTS.includes(result))) return false;
    const checks = this.store.scenarioChecks.filter((check) => !(check.callId === callId && check.checkpointId === checkpointId));
    if (result) checks.push({ callId, scenarioId: scenario.id, checkpointId, result, at: this.now() });
    this.store.scenarioChecks = checks; // admins' own test results, so never trimmed
    this.store.save();
    return true;
  }

  // A randomly assigned engine couldn't start this call, so it runs on the fallback instead, and the log says so.
  fallBack(user, callId) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return null;
    // What it was assigned first, so the log can still tell a fallback from a call assigned the fallback's combination.
    const original = { fallbackFromEngine: call.engine, fallbackFromTurnMode: call.turnMode ?? null, fallbackFromAssigned: call.assigned ?? null };
    call.engine = FALLBACK_COMBO.engine;
    call.turnMode = FALLBACK_COMBO.turnMode;
    call.assigned = 'fallback';
    this.#log(call, { engine: call.engine, turnMode: call.turnMode, assigned: call.assigned, ...original });
    this.store.save();
    return { engine: call.engine, turnMode: call.turnMode };
  }

  // What the call actually ran on (build, prompt version, models, voices and turn detection), from its first
  // session that started. A reconnect keeps it, so a setting changed mid-call doesn't rewrite it.
  recordConfig(user, callId, config) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || call.configRecorded) return false;
    call.configRecorded = true;
    this.#log(call, config);
    this.store.save();
    return true;
  }

  // The turn mode of the user's call in progress, for settings changed mid-call.
  liveTurnMode(user) {
    const call = Object.values(this.store.calls).find((candidate) => candidate.userId === user.id && candidate.startedAt && !candidate.endedAt);
    return call?.turnMode ?? null;
  }

  // Newest first. Numbers and ids only, for the admin call log.
  callLog(limit = 300) {
    return this.store.callLog.slice(-limit).reverse();
  }

  // Every comment left after a call, newest first, for admins. Join them to the call log by callId.
  callComments(limit = 1000) {
    return Object.values(this.store.users)
      .flatMap((user) => user.ratings.filter((record) => record.comment).map(({ callId, at, comment }) => ({ callId, at, comment })))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  // Admins' checklist results for controlled test calls, newest first. Join them to the call log by callId.
  scenarioChecks(limit = 1000) {
    return this.store.scenarioChecks.slice(-limit).reverse();
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
    this.#history(call, { outcome: 'connected' });
    user.streak = recordCallDay(user.streak, localDayNumber(this.now(), user.timeZone), user.settings);
    this.store.save();
    return true;
  }

  // Saves a call's turn-taking numbers with the settings they were measured under, and returns the record.
  saveTurnMetrics(user, callId, metrics) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return null;
    const { thinkingTime, speed, proficiency } = user.settings;
    // Smart Turn can fall back to silence mid-call, so the mode it actually ended in is kept too. A phone too old
    // to report that leaves it unknown.
    const smartTurnUnknown = call.turnMode === 'smartTurn' && metrics.smartTurnFallback === null;
    const actualTurnMode = smartTurnUnknown ? null : call.turnMode === 'smartTurn' && metrics.smartTurnFallback ? 'silence' : (call.turnMode ?? null);
    call.turnMetrics = { callId, ...metrics, engine: call.engine ?? 'gpt-realtime', turnMode: call.turnMode ?? null, actualTurnMode, thinkingTime, speed, proficiency };
    // Every number the phone sent goes in the call log, which outlives the call record, plus two worked out from them.
    const spoke = (metrics.userSpeechMs ?? 0) + (metrics.agentSpeechMs ?? 0);
    this.#log(call, {
      actualTurnMode,
      ...metrics,
      userCallSharePercent: metrics.userSpeechMs === null || !spoke ? null : Math.round((metrics.userSpeechMs / spoke) * 100),
      avgTurnMs: metrics.userSpeechMs === null || !metrics.userTurns ? null : Math.round(metrics.userSpeechMs / metrics.userTurns),
    });
    this.#recordProgress(user, call, { userSpeechMs: metrics.userSpeechMs });
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
    this.countLookup(user, "That's all the example sentences for today. Try again tomorrow.");
    return word;
  }

  // Example sentences and a sentence's words share the day's lookups.
  countLookup(user, message = "That's all the lookups for today. Try again tomorrow.") {
    const day = localDay(this.now(), user.timeZone);
    if (user.lookups.day !== day) user.lookups = { day, count: 0 };
    if (user.lookups.count >= MAX_LOOKUPS_PER_DAY) throw new LimitError(message);
    user.lookups.count += 1;
    this.store.save();
  }

  // A saved sentence and its words with kanji, if they've been worked out already (they're kept with the sentence).
  sentenceWords(user, sentenceId) {
    const sentence = user.sentences.find((candidate) => candidate.id === sentenceId);
    if (!sentence) return null;
    return { sentence, words: sentence.kanjiWords ?? null };
  }

  keepSentenceWords(user, sentenceId, list) {
    const sentence = user.sentences.find((candidate) => candidate.id === sentenceId);
    const words = cleanSentenceWords(list);
    if (sentence) {
      sentence.kanjiWords = words;
      this.store.save();
    }
    return words;
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

  // The learning numbers the phone worked out from the call's transcript (public/learning-metrics.js).
  saveLearning(user, callId, learning) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || !call.connectedAt) return null;
    call.learning = learning;
    this.#log(call, learning);
    this.#recordProgress(user, call, { englishTurnPercent: learning.englishTurnPercent, japaneseChars: learning.japaneseChars });
    this.store.save();
    return learning;
  }

  // The model's estimate of the learner's speaking level from a recorded call (OpenAI's gradeLevel).
  // The reason is kept with the account; the call log keeps only the levels and confidence.
  saveLevelEstimate(user, callId, estimate) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return null;
    const record = { callId, at: this.now(), ...estimate };
    const estimates = [record, ...user.levelEstimates.filter((saved) => saved.callId !== callId)];
    user.levelEstimates = keepsEverything(user) ? estimates : estimates.slice(0, KEEP_PROGRESS);
    this.#log(call, { estimatedLevel: estimate.level, estimatedVocabulary: estimate.vocabulary, estimatedGrammar: estimate.grammar, levelConfidence: estimate.confidence });
    this.#recordProgress(user, call, { estimatedLevel: estimate.level });
    this.store.save();
    return record;
  }

  // What the learner sees under My Stack: minutes of Japanese they've spoken on calls, adding up over time, and,
  // after enough graded calls, the level their speaking sounds like (the middle of their last few estimates).
  progress(user) {
    let total = 0;
    const points = [...user.progress]
      .sort((a, b) => a.at - b.at)
      .filter((entry) => entry.japaneseMs !== null && entry.japaneseMs !== undefined)
      .map((entry) => {
        total += entry.japaneseMs;
        return { at: entry.at, minutes: Math.round((total / 60_000) * 10) / 10 };
      });
    const recent = user.levelEstimates.slice(0, LEVEL_SAMPLE).map((estimate) => JLPT_ORDER.indexOf(estimate.level));
    const speakingLevel = recent.length >= LEVEL_SAMPLE ? JLPT_ORDER[[...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)]] : null;
    return { points, totalMinutes: points.at(-1)?.minutes ?? 0, speakingLevel, gradedCalls: user.levelEstimates.length, callsUntilLevel: Math.max(0, LEVEL_SAMPLE - user.levelEstimates.length) };
  }

  // One entry per call in the learner's own progress history, filled in as the timing, learning numbers and level
  // arrive. Japanese speaking time is their speaking time, less the share of their lines that were mostly English.
  #recordProgress(user, call, change) {
    let entry = user.progress.find((saved) => saved.callId === call.id);
    if (!entry) {
      entry = { callId: call.id, at: call.connectedAt ?? call.startedAt ?? this.now(), direction: call.direction, selfLevel: user.settings.proficiency, userSpeechMs: null, englishTurnPercent: null, japaneseChars: null, japaneseMs: null, estimatedLevel: null };
      user.progress.push(entry);
      if (!keepsEverything(user) && user.progress.length > KEEP_PROGRESS) user.progress.splice(0, user.progress.length - KEEP_PROGRESS);
    }
    Object.assign(entry, change);
    if (entry.userSpeechMs !== null && entry.englishTurnPercent !== null) entry.japaneseMs = Math.round((entry.userSpeechMs * (100 - entry.englishTurnPercent)) / 100);
  }

  // Whether Japanese is fitting into the learner's day, over the last HABIT_DAYS: how often they answer Ping's calls
  // and how fast, who starts calls, how many days they practice, which hours work, and the north star: minutes of
  // Japanese a week from Ping's calls they answered, which they didn't have to plan. Admin test rings are left out.
  habit(user) {
    const now = this.now();
    const since = now - HABIT_DAYS * DAY_MS;
    const recent = user.callHistory.filter((entry) => entry.at >= since && !entry.test);
    const pingCalls = recent.filter((entry) => entry.direction === 'incoming' && ['answered', 'connected', 'missed', 'declined'].includes(entry.outcome));
    const answered = pingCalls.filter((entry) => entry.outcome === 'answered' || entry.outcome === 'connected');
    const pickups = answered.map((entry) => entry.pickupSeconds).filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
    const connected = recent.filter((entry) => entry.outcome === 'connected');
    const practiceDays = new Set(connected.map((entry) => localDayNumber(entry.at, user.timeZone))).size;
    const hours = {};
    for (const entry of pingCalls) {
      const hour = entry.localHour ?? localParts(entry.at, user.timeZone).hour;
      hours[hour] ??= { rang: 0, answered: 0 };
      hours[hour].rang += 1;
      if (answered.includes(entry)) hours[hour].answered += 1;
    }
    const lastWeek = new Set(connected.filter((entry) => entry.direction === 'incoming' && entry.at >= now - 7 * DAY_MS).map((entry) => entry.callId));
    const unplannedMs = user.progress.filter((entry) => lastWeek.has(entry.callId)).reduce((total, entry) => total + (entry.japaneseMs ?? 0), 0);
    return {
      days: HABIT_DAYS,
      pingCalls: pingCalls.length,
      answerRatePercent: pingCalls.length ? Math.round((answered.length / pingCalls.length) * 100) : null,
      pickupMedianSeconds: pickups.length ? pickups[Math.floor((pickups.length - 1) / 2)] : null,
      callsStartedByPing: recent.filter((entry) => entry.direction === 'incoming').length,
      callsStartedByLearner: recent.filter((entry) => entry.direction === 'outgoing').length,
      // Per week of the window they've had the account, so a learner who joined last week isn't averaged over four.
      practiceDaysPerWeek: Math.round((practiceDays / (Math.max(7, Math.min(HABIT_DAYS, (now - (user.joinedAt ?? since)) / DAY_MS)) / 7)) * 10) / 10,
      answeredHours: hours,
      unplannedMinutesThisWeek: Math.round((unplannedMs / 60_000) * 10) / 10,
    };
  }

  // Everything kept, for the data export: accounts without their sign-in token or push subscription, the call log,
  // recent call records, checklist results and feedback.
  exportData() {
    const users = Object.values(this.store.users).map(({ tokenHash, subscription, ...user }) => ({ ...user, hasSubscription: Boolean(subscription) }));
    return { users, calls: Object.values(this.store.calls), callLog: this.store.callLog, scenarioChecks: this.store.scenarioChecks, feedback: this.store.feedback };
  }

  // The Calls tab, newest first: calls the contact made (answered, missed or declined) and calls the user made
  // (connected or not), each with the contact's name as it is now.
  recentCalls(user) {
    return user.callHistory
      .slice(-RECENT_CALLS)
      .reverse()
      .map((entry) => ({ ...entry, contactName: this.#contactName(user, entry.contactId) }));
  }

  // One call for the Calls tab's details: the call, what the learner did on it, and its transcript if the
  // account keeps them (paid plans).
  callDetails(user, callId) {
    const entry = user.callHistory.find((saved) => saved.callId === callId);
    if (!entry) return null;
    const progress = user.progress.find((saved) => saved.callId === callId) ?? null;
    const conversation = user.conversations.find((saved) => saved.callId === callId);
    return {
      call: { ...entry, contactName: this.#contactName(user, entry.contactId) },
      japaneseMinutes: progress?.japaneseMs == null ? null : Math.round((progress.japaneseMs / 60_000) * 10) / 10,
      japaneseChars: progress?.japaneseChars ?? null,
      newWords: this.store.calls[callId]?.learning?.newWords ?? null,
      lines: conversation?.lines ?? [],
    };
  }

  #contactName(user, contactId) {
    return findContact(user, contactId)?.name ?? (contactId === PING.id ? PING.name : 'Former contact');
  }

  // Adds to the call's entry in the Calls tab history, creating it the first time.
  #history(call, change) {
    const user = this.store.users[call.userId];
    if (!user) return;
    let entry = user.callHistory.find((saved) => saved.callId === call.id);
    if (!entry) {
      const at = call.createdAt ?? this.now();
      entry = {
        callId: call.id,
        contactId: call.contactId,
        direction: call.direction, // incoming: Ping (or a contact) started it; outgoing: the learner did
        at,
        localHour: localParts(at, user.timeZone).hour, // which hours get answered
        selfLevel: user.settings.proficiency, // the JLPT level the learner had chosen when the call started
        ...(call.test ? { test: true } : {}),
        outcome: null,
        seconds: null,
        pickupSeconds: null,
      };
      user.callHistory.push(entry);
      if (!keepsEverything(user) && user.callHistory.length > KEEP_HISTORY) user.callHistory.splice(0, user.callHistory.length - KEEP_HISTORY);
    }
    Object.assign(entry, change);
  }

  // The two 1-5 taps after a call, and the optional comment, kept with the account since calls are removed after
  // 7 days. The call log only says whether there was a comment: its text stays with the account (and the recording).
  saveRating(user, callId, rating, comment = null) {
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id || !call.connectedAt) return null;
    const record = { callId, at: this.now(), engine: call.engine ?? 'gpt-realtime', turnMode: call.turnMode ?? null, cutOffs: rating.cutOffs, naturalness: rating.naturalness, comment };
    call.rating = { cutOffs: rating.cutOffs, naturalness: rating.naturalness };
    this.#log(call, { cutOffs: rating.cutOffs, naturalness: rating.naturalness, commented: Boolean(comment) });
    const ratings = [record, ...user.ratings.filter((saved) => saved.callId !== callId)];
    user.ratings = keepsEverything(user) ? ratings : ratings.slice(0, KEEP_RATINGS);
    this.store.save();
    return record;
  }

  // Returns false when the account can't turn recording off.
  setRecording(user, on) {
    if (recordingLocked(user)) return false;
    user.recordingOff = !on;
    this.store.save();
    return true;
  }

  acknowledgePolicy(user) {
    user.policyVersion = POLICY_VERSION;
    this.store.save();
  }

  // The user's call, if it's one being recorded, or null. Only these calls' audio and transcripts are kept.
  recordedCall(user, callId) {
    const call = this.store.calls[callId];
    return call && call.userId === user.id && call.recorded ? call : null;
  }

  // What's saved alongside a recording, so it still makes sense after the call is removed from the store.
  recordingInfo(user, call) {
    return {
      userId: user.id,
      callId: call.id,
      joinedWith: user.joinedWith,
      plan: user.plan,
      contactName: this.#contactOf(call, user).name,
      direction: call.direction,
      engine: call.engine ?? 'gpt-realtime',
      turnMode: call.turnMode ?? null,
      at: call.connectedAt ?? call.startedAt ?? call.createdAt,
      seconds: call.startedAt && call.endedAt ? Math.round((call.endedAt - call.startedAt) / 1000) : null,
    };
  }

  // Only subscribers' conversations are kept, to personalize their future calls.
  saveConversation(user, callId, lines) {
    if (!isPaid(user.plan) || !Array.isArray(lines)) return false;
    const call = this.store.calls[callId];
    if (!call || call.userId !== user.id) return false;
    const cleanLines = cleanTranscript(lines).slice(-MAX_TRANSCRIPT_LINES);
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
        .map((user) => ({ joinedAt: user.joinedAt, calls: user.connectedCalls, lastCallAt: user.lastCallAt, words: user.words.length, level: user.settings.proficiency, habit: this.habit(user) }))
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

  // A call's opening question. An admin testing a scenario gets its question every time, leaving the random
  // questions as they were. Everyone else, and admins on randomized topics, gets one at random, never the last one.
  #pickTopic(user) {
    const scenario = user.role === 'admin' && user.topicMode === 'controlled' ? scenarioById(user.scenarioId) : null;
    if (scenario) return { questionId: scenario.questionId, topicMode: 'controlled', scenarioId: scenario.id };
    const question = pickQuestion(user.lastQuestionId, this.random);
    user.lastQuestionId = question.id;
    return { questionId: question.id, topicMode: 'randomized', scenarioId: null };
  }

  #assignCombo(call, user) {
    const manual = user.role === 'admin' && user.callSetupManual;
    const mix = RANDOM_MIX.filter((option) => this.engineReady(option.engine));
    const combo = manual ? { engine: user.engine, turnMode: ENGINES[user.engine]?.turnModes.length ? user.turnMode : null } : pickCombo(user.comboCounts, this.random, mix);
    call.engine = combo.engine;
    call.turnMode = combo.turnMode ?? null;
    call.assigned = manual ? 'manual' : 'random';
    if (!manual) user.comboCounts[comboKey(combo)] = (user.comboCounts[comboKey(combo)] ?? 0) + 1;
    // The settings as the call starts. Ids and setting values only: never a custom contact's name or topic.
    const { proficiency, formality, thinkingTime, speed } = user.settings;
    const topic = { topicMode: call.topicMode ?? 'randomized', scenarioId: call.scenarioId ?? null };
    // proficiency is the learner's own choice of JLPT level (the level picker, Manage Account, or asking Ping on a call),
    // as the call started: compare it with estimatedLevel.
    this.#log(call, { contactId: call.contactId ?? null, questionId: call.questionId ?? null, ...topic, proficiency, formality, thinkingTime, speed });
  }

  // Past KEEP_CALL_LOG entries, the oldest go first, except admin and beta testers' entries, which stay.
  #trimCallLog() {
    let over = this.store.callLog.length - KEEP_CALL_LOG;
    if (over <= 0) return;
    this.store.callLog = this.store.callLog.filter((entry) => {
      if (over <= 0 || keepsEverything(this.store.users[entry.userId])) return true;
      over -= 1;
      return false;
    });
  }

  // An admin deletes everything kept about one call: the call, its call log entry, rating, comment and
  // checklist results. The recording is deleted by the server. Returns false if nothing was kept.
  deleteCallData(callId) {
    const call = this.store.calls[callId];
    const inLog = this.store.callLog.some((entry) => entry.callId === callId);
    const owner = this.store.users[call?.userId ?? this.store.callLog.find((entry) => entry.callId === callId)?.userId];
    if (!call && !inLog) return false;
    delete this.store.calls[callId];
    this.store.callLog = this.store.callLog.filter((entry) => entry.callId !== callId);
    this.store.scenarioChecks = this.store.scenarioChecks.filter((check) => check.callId !== callId);
    if (owner) {
      owner.ratings = owner.ratings.filter((record) => record.callId !== callId);
      owner.progress = owner.progress.filter((entry) => entry.callId !== callId);
      owner.levelEstimates = owner.levelEstimates.filter((record) => record.callId !== callId);
      owner.callHistory = owner.callHistory.filter((entry) => entry.callId !== callId);
    }
    this.store.save();
    return true;
  }

  // Adds to the call's entry in the call log, creating it the first time.
  #log(call, change) {
    let entry = this.store.callLog.findLast((candidate) => candidate.callId === call.id);
    if (!entry) {
      const user = this.store.users[call.userId];
      entry = { callId: call.id, userId: call.userId, joinedWith: user?.joinedWith ?? null, at: call.startedAt ?? this.now(), direction: call.direction, engine: call.engine ?? 'gpt-realtime', turnMode: call.turnMode ?? null, assigned: call.assigned ?? null, recorded: Boolean(call.recorded) };
      this.store.callLog.push(entry);
      this.#trimCallLog();
    }
    Object.assign(entry, change);
  }

  #activeCall(user) {
    return Object.values(this.store.calls).find((call) => call.userId === user.id && call.state === 'ringing');
  }

  #rangToday(user) {
    return user.lastRingDay === localDay(this.now(), user.timeZone);
  }

  #schedule(user, { skipToday = false } = {}) {
    // Ping's call leans toward the hours of their window they tend to answer in (hourWeights in schedule.js).
    const weights = hourWeights(this.habit(user).answeredHours);
    user.nextCallAt = nextCallTime({ now: this.now(), timeZone: user.timeZone, skipToday, random: this.random, settings: user.settings, hourWeights: weights });
  }

  // DAILY_CALL_LIMIT is a safety net on top of the plan's calls, counting every call the user makes.
  // Admins and YC reviewers aren't held to it.
  #countCall(user) {
    this.#usageToday(user);
    if (this.dailyCallLimit && !unlimitedCalls(user) && user.usage.calls >= this.dailyCallLimit) throw new LimitError("That's all the calls for today. Ping will call you again soon!");
    user.usage.calls += 1;
  }
}
