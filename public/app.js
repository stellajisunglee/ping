import { initContacts } from './contacts.js';
import { charsSaid, createPace } from './reveal.js';
import { $, api, clearWarning, el, enableSwipeBack, go, goBack, initialOf, isAdmin, isPaid, onShow, readToken, refresh, setError, show, showCallingNote, showPlanBadge, state, upload, writeToken } from './lib.js';
import { initSettings, keepRecording, recordCallsOn, showScenarioPanel } from './settings.js';
import { audioUnlocked, startRingtone, unlockAudio } from './ringtone.js';
import { initStack, renderStackTiles } from './stack.js';
import { failedCallNotice, startCall } from './voice.js';
import { summarizeLearning, wordEvents, wordLevels } from './learning-metrics.js';
import { initProgress, renderProgress } from './progress.js';
import { initOnboarding, renderWelcome, showConnecting } from './onboarding.js';
import { deviceKind, isInstalled, needsInstall } from './device.js';
import { initRecents, renderBadge } from './recents.js';

const RING_FALLBACK_MS = 12_000; // the server decides a call was missed. This only covers its message getting lost.
// Calling a contact rings this long first, like a real phone call, before Ping picks up.
const OUTGOING_RING_MS = 3_000;

let ringingCallId = null;
let ringFallback = null;
let ringTone = null;
let activeCall = null;
let activeCallId = null;
let callCountdown = null;
let transcript = new Map();
let pace = createPace(); // how fast the contact speaks on this call, learned as it goes
let revealTimer = null;
const REVEAL_EVERY_MS = 80;

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// On a phone, Ping only runs as the installed app. Android's own install prompt is kept for the Install button.
const device = deviceKind(navigator);
const installed = isInstalled({ standalone: window.navigator.standalone, displayStandalone: matchMedia('(display-mode: standalone)').matches });
const mustInstall = needsInstall(device, installed);
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  if (mustInstall) renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (mustInstall) renderInstall({ done: true });
});

// The install page: an Install button where the browser offers one (Android), otherwise the steps for this phone.
function renderInstall({ done = false } = {}) {
  $('install-button').hidden = done || !installPrompt;
  $('install-steps-ios').hidden = done || device !== 'ios';
  $('install-steps-android').hidden = done || device !== 'android' || Boolean(installPrompt);
  $('install-done').hidden = !done;
  show('install');
}

async function installApp() {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  renderInstall({ done: outcome === 'accepted' });
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function notice(text) {
  const element = $('home-notice');
  element.textContent = text ?? '';
  element.hidden = !text;
}

// Signing up and turning things on

async function subscribeToPush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(state.config.vapidPublicKey) }));
  state.me = await api('/api/push', { method: 'PUT', body: { subscription, timeZone: timeZone() } });
}

async function enable() {
  setError('enable-error', null);
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    setError('enable-error', "This browser can't receive calls. Try Chrome, Edge or Firefox, or Safari from the Home Screen.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setError('enable-error', "Notifications are blocked, so Ping can't call you. Allow them in your browser or phone settings, then try again.");
    return;
  }
  let microphoneWarning = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    microphoneWarning = "Microphone is off. You'll need it to talk on a call, so allow it in your browser or phone settings.";
  }
  try {
    await subscribeToPush();
    goHome();
    notice(microphoneWarning);
  } catch (error) {
    setError('enable-error', error.message);
  }
}

async function join(event) {
  event.preventDefault();
  setError('join-error', null);
  try {
    const result = await api('/api/register', { method: 'POST', body: { inviteCode: $('invite-code').value.trim(), timeZone: timeZone() } });
    writeToken(result.token);
    state.me = result;
    goHome();
  } catch (error) {
    setError('join-error', error.message);
  }
}

// Home

function describeSchedule() {
  const { callsEnabled, frequency, customDays, callStartHour, callEndHour } = state.me.settings;
  if (!callsEnabled) return 'Calls are off';
  const hour = (value) => `${String(value).padStart(2, '0')}:00`;
  const when = { daily: 'every day', 'every-other-day': 'every other day', weekdays: 'on weekdays', weekends: 'on weekends', custom: 'on your chosen days' }[frequency];
  if (frequency === 'custom' && !customDays.length) return 'No call days picked';
  return `Calls ${when}, between ${hour(callStartHour)} and ${hour(callEndHour)}`;
}

// Ping greets the user by the time of day, in Japanese with English underneath for beginners.
const GREETINGS = [
  { from: 5, japanese: 'おはよう！', english: 'Good morning' },
  { from: 11, japanese: 'こんにちは！', english: 'Hello' },
  { from: 18, japanese: 'こんばんは！', english: 'Good evening' },
];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']; // Sunday first, as the server counts them
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function greetingFor(hour) {
  return GREETINGS.findLast((greeting) => hour >= greeting.from) ?? GREETINGS.at(-1);
}

// The contact who calls the user is the one Home's button calls.
const homeContact = () => state.me.contacts.find((contact) => contact.selected) ?? state.me.contacts[0];

function renderWeek(week = []) {
  $('home-week').replaceChildren(
    ...week.map((day) => {
      const status = day.practiced ? 'practiced' : !day.callDay ? 'day off' : day.upcoming ? 'upcoming' : day.today ? 'not yet' : 'missed';
      const mark = el('span', { className: 'week-mark', textContent: day.practiced ? '✓' : day.callDay ? '' : '休' });
      return el(
        'li',
        { className: `week-day ${status.replace(' ', '-')}${day.today ? ' today' : ''}`, ariaLabel: `${day.today ? 'Today' : WEEKDAY_NAMES[day.weekday]}: ${status}` },
        mark,
        el('span', { className: 'week-label', lang: 'ja', ariaHidden: 'true', textContent: WEEKDAYS[day.weekday] }),
      );
    }),
  );
}

function renderLastCall() {
  const { lastCall } = state.me;
  $('home-last-call').hidden = !lastCall;
  if (!lastCall) return;
  const when = new Date(lastCall.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const parts = [`Last call · ${when}`];
  if (lastCall.seconds) parts.push(lastCall.seconds < 60 ? `${lastCall.seconds} sec` : `${Math.round(lastCall.seconds / 60)} min`);
  parts.push(`${lastCall.newWords} new ${lastCall.newWords === 1 ? 'word' : 'words'}`);
  const summary = el('p', { textContent: parts.join(' · ') });
  if (!lastCall.newWords) return $('home-last-call').replaceChildren(summary);
  const seeWords = el('button', { className: 'secondary small', type: 'button', textContent: 'See words' });
  seeWords.dataset.go = 'words';
  $('home-last-call').replaceChildren(summary, seeWords);
}

function renderHome() {
  const { streak } = state.me;
  const greeting = greetingFor(new Date().getHours());
  $('home-greeting-ja').textContent = greeting.japanese;
  $('home-greeting-en').textContent = greeting.english;
  const contact = homeContact();
  $('home-avatar').textContent = initialOf(contact?.name ?? 'Ping');
  $('home-call-button').textContent = `Call ${contact?.name ?? 'Ping'} now`;
  $('home-call-button').disabled = !state.me.calling.canCall;
  showPlanBadge('home-plan');
  $('home-plan').ariaLabel = `Your plan: ${$('home-plan').textContent}`;
  showCallingNote('home-minutes');
  $('streak-current').textContent = streak.current;
  $('streak-best').textContent = streak.best ? `Best: ${streak.best} ${streak.best === 1 ? 'day' : 'days'}` : '';
  renderWeek(streak.week);
  $('home-status').textContent = describeSchedule();
  renderLastCall();
  setError('home-clear', clearWarning());
  renderStackTiles();
  renderProgress();
  renderBadge();
  renderBrowserNote();
  renderPolicyNotice();
}

// When the Privacy Policy changes in a way that affects people, they're told once, on Home.
const POLICY_NOTICES = {
  recording: {
    title: 'Calls are now recorded',
    text: 'To improve Ping, calls are now recorded and transcribed, and the Ping team may listen to them. The Privacy Policy has the details.',
  },
  update: {
    title: 'Privacy Policy updated',
    text: 'Some calls now run on ElevenLabs, another voice AI service, as well as OpenAI and Deepgram, and Ping can call you by name. The Privacy Policy lists who handles your calls.',
  },
};

function renderPolicyNotice() {
  const notice = POLICY_NOTICES[state.me.policyNotice];
  $('policy-notice').hidden = !notice;
  if (!notice) return;
  $('policy-notice-title').textContent = notice.title;
  $('policy-notice-text').textContent = notice.text;
  $('policy-notice-choice').hidden = state.me.policyNotice !== 'recording' || !state.me.recording?.canTurnOff;
}

async function dismissPolicyNotice() {
  $('policy-notice').hidden = true;
  state.me.policyNotice = null;
  await api('/api/policy/seen', { method: 'POST' }).catch((error) => console.warn('Could not save that the notice was seen', error));
}

// Before Home: beta testers and Free users go through the two onboarding pages once; everyone picks a level; and
// right after either, "Connecting to Ping" plays for a few seconds.
let connectingNext = false;
function beforeHome() {
  if (!state.me) return false;
  if (state.me.needsOnboarding) {
    renderWelcome();
    return true;
  }
  if (!state.me.levelChosen) {
    showLevelPicker();
    return true;
  }
  if (connectingNext) {
    connectingNext = false;
    showConnecting(() => go('home'));
    return true;
  }
  return false;
}

// The level picker: page 2 of the onboarding, or on its own for admins, YC reviewers and accounts from before.
function showLevelPicker() {
  const onboarding = Boolean(state.me.needsOnboarding);
  $('level-back').hidden = !onboarding;
  $('level-step').hidden = !onboarding;
  show('level');
}

const showCallsTab = () => beforeHome() || go('calls');

// Everyone picks a JLPT level before they reach Home, including accounts from before there were JLPT levels.
const goHome = () => beforeHome() || go('home');

// The level picker, shown once before Home. Then notifications, if they aren't on yet.
async function chooseLevel(proficiency) {
  setError('level-error', null);
  try {
    // Someone completely new also gets slower speech and more time to answer, which they can change later.
    const change = proficiency === 'new' ? { proficiency, speed: 0.85, thinkingTime: 'long' } : { proficiency };
    const settings = await api('/api/settings', { method: 'PATCH', body: change });
    state.me.settings = settings.settings;
    state.me.levelChosen = true;
    if (state.me.needsOnboarding) state.me = await api('/api/onboarding/done', { method: 'POST' });
    connectingNext = true;
    if (!pushAllowed() && !browserOnly()) return show('enable');
    goHome();
  } catch (error) {
    setError('level-error', error.message);
  }
}

// On a computer, Ping can be used in a plain browser tab without notifications (for admins and testing): the user can
// call Ping, but Ping can't call them. Phones always run the installed app. The choice is kept per browser.
const BROWSER_ONLY_KEY = 'ping-browser-only';
const pushAllowed = () => 'Notification' in window && Notification.permission === 'granted';

function browserOnly() {
  if (device !== 'desktop') return false;
  try {
    return localStorage.getItem(BROWSER_ONLY_KEY) === 'yes';
  } catch {
    return false;
  }
}

function useBrowserOnly(next) {
  try {
    localStorage.setItem(BROWSER_ONLY_KEY, 'yes');
  } catch {}
  next();
}

// Home says Ping can't call them here, and how to change that.
function renderBrowserNote() {
  const callsOff = !pushAllowed();
  $('browser-note').hidden = !callsOff;
  if (!callsOff) return;
  $('browser-note-text').textContent = device === 'desktop' ? "Ping can't call you in this browser until notifications are on, but you can call Ping." : "Ping can't call you until notifications are on, but you can call Ping.";
  $('browser-note-enable').hidden = false;
}

// Ringing

function stopRinging() {
  clearTimeout(ringFallback);
  ringTone?.();
  ringTone = null;
  ringingCallId = null;
}

async function closeNotifications() {
  const registration = await navigator.serviceWorker?.getRegistration();
  // Each re-ring is its own notification, so close every one of this app's call notifications.
  const notifications = (await registration?.getNotifications()) ?? [];
  notifications.filter(({ tag }) => tag?.startsWith('ping-call')).forEach((notification) => notification.close());
}

function showRinging(callId, contactName = 'Ping') {
  if (activeCall || ringingCallId === callId) return;
  ringingCallId = callId;
  $('ringing-name').textContent = contactName;
  $('ringing-avatar').textContent = initialOf(contactName);
  show('ringing');
  ringTone = startRingtone();
  ringFallback = setTimeout(() => {
    stopRinging();
    refresh().then(goHome, goHome);
  }, RING_FALLBACK_MS);
}

async function answer(callId) {
  stopRinging();
  closeNotifications();
  try {
    const { state: callState, contactName, scenarioId } = await api(`/api/calls/${callId}/answer`, { method: 'POST' });
    if (callState === 'answered') return beginCall(callId, contactName, scenarioId);
    await refresh();
    goHome();
    notice(callState === 'missed' ? `You just missed ${contactName}, who left a voice message.` : 'That call has ended.');
  } catch (error) {
    goHome();
    notice(error.message);
  }
}

async function decline() {
  const callId = ringingCallId;
  stopRinging();
  closeNotifications();
  goHome();
  await api(`/api/calls/${callId}/decline`, { method: 'POST' }).catch(() => {});
  await refresh().then(renderHome).catch(() => {});
}

async function missed() {
  stopRinging();
  await refresh().catch(() => {});
  goHome();
}

// On a call

const ENDED_NOTICE = {
  'no-microphone': "They can't hear you because the microphone is off. Allow it in your browser or phone settings, then call back.",
  dropped: 'The call dropped. You can call back from Contacts.',
  failed: "The call couldn't connect. Please try calling back.",
};

function endedNotice(reason) {
  if (reason === 'time-limit') return timeLimitNotice();
  // Only suggest calling back when the user can.
  if (!state.me.calling.canCall && (reason === 'dropped' || reason === 'failed')) return reason === 'dropped' ? 'The call dropped.' : "The call couldn't connect.";
  return ENDED_NOTICE[reason] ?? null;
}

// Calls stop at the plan's longest call.
function timeLimitNotice() {
  return `That was a good chat! Calls on your plan last up to ${state.me.calling.perCallMinutes} minutes.`;
}

function setPressed(id, pressed) {
  $(id).setAttribute('aria-pressed', String(pressed));
}

function setMuted(muted) {
  activeCall?.setMuted(muted);
  setPressed('mute-button', muted);
  $('mute-label').textContent = muted ? 'Unmute' : 'Mute';
}

function callHint(text) {
  $('call-hint').textContent = text ?? '';
  $('call-hint').hidden = !text;
}

async function toggleSpeaker() {
  const on = $('speaker-button').getAttribute('aria-pressed') !== 'true';
  const switched = await activeCall?.setSpeaker(on).catch(() => false);
  if (switched) {
    setPressed('speaker-button', on);
    callHint(null);
  } else {
    callHint("This phone doesn't let apps switch the speaker. Use your phone's own audio controls.");
  }
}

function showSpeedPopup(open) {
  $('call-speed-popup').hidden = !open;
  setPressed('speed-button', open);
  if (!open) return;
  const { speed } = state.me.settings;
  $('call-speed-input').value = speed;
  $('call-speed-output').textContent = `${Number(speed).toFixed(2)}×`;
}

async function changeCallSpeed(speed) {
  try {
    const { settings, turnDetection, smartTurn, agent } = await api('/api/settings', { method: 'PATCH', body: { speed } });
    state.me.settings = settings;
    activeCall?.updateVoice({ settings, turnDetection, smartTurn, agent });
  } catch (error) {
    callHint(error.message);
  }
}

function addTranscriptNode(node) {
  const list = $('call-transcript');
  list.append(node);
  list.scrollTop = list.scrollHeight;
}

function showLine({ id, from, text, delta }) {
  let line = transcript.get(id);
  if (!line) {
    const node = el('p', { className: from === 'you' ? 'line you' : 'line them', lang: 'ja', hidden: true });
    // A contact's line shows only what has been said so far: `shown` characters, once its voice starts.
    line = { from, text: '', node, shown: 0, startedAt: null, stoppedAt: null, finished: false, cut: false };
    transcript.set(id, line);
    addTranscriptNode(node);
  }
  line.text = delta ? line.text + delta : text;
  if (from === 'contact') return revealLine(line);
  line.node.textContent = line.text;
  line.node.hidden = !line.text.trim();
  const list = $('call-transcript');
  list.scrollTop = list.scrollHeight;
}

const speed = () => state.me?.settings?.speed ?? 1;

// How much of a contact's line has been said: all of it once their voice finished, otherwise an
// estimate from how long they've been speaking, up to the moment they were cut off.
function saidSoFar(line) {
  if (line.finished) return line.text.length;
  if (line.startedAt === null) return 0;
  const until = line.stoppedAt ?? performance.now();
  return Math.min(line.text.length, charsSaid(line.text, until - line.startedAt, pace.unitsPerMs(speed())));
}

// Adds the newly said words to the line, each batch fading in.
function revealLine(line) {
  if (line.cut) return;
  const target = saidSoFar(line);
  if (target <= line.shown) return;
  line.node.append(el('span', { className: 'said', textContent: line.text.slice(line.shown, target) }));
  line.shown = target;
  line.node.hidden = !line.text.slice(0, target).trim();
  const list = $('call-transcript');
  list.scrollTop = list.scrollHeight;
}

// What the user actually heard of a line, which is also what a paid plan saves.
const heardText = (line) => (line.from === 'contact' ? line.text.slice(0, line.shown) : line.text);

function revealTick() {
  const revealing = [...transcript.values()].filter((line) => line.from === 'contact' && line.startedAt !== null && !line.finished && !line.cut);
  revealing.forEach(revealLine);
  if (!revealing.length) {
    clearInterval(revealTimer);
    revealTimer = null;
  }
}

// The user cut the contact off: keep only the words they heard, and mark the line as unfinished.
function cutLine(line, audioEndMs) {
  const heard = Math.min(line.text.length, charsSaid(line.text, audioEndMs, pace.unitsPerMs(speed())));
  line.cut = true;
  line.shown = heard;
  const unfinished = heard < line.text.trimEnd().length;
  line.node.replaceChildren(el('span', { textContent: line.text.slice(0, heard).trimEnd() + (unfinished ? '…' : '') }));
  line.node.hidden = !heard;
}

function onContactAudio({ type, itemId, at, audioEndMs }) {
  const line = transcript.get(itemId);
  if (!line) return;
  if (type === 'start') {
    line.startedAt = at;
    revealLine(line);
    revealTimer ??= setInterval(revealTick, REVEAL_EVERY_MS);
  } else if (type === 'end') {
    if (line.startedAt !== null) pace.learn(line.text, at - line.startedAt, speed());
    line.finished = true;
    revealLine(line);
  } else if (type === 'cut' && line.startedAt !== null) {
    // OpenAI says exactly how much was heard a moment later. Until then, stop where the estimate was.
    line.stoppedAt = at;
    cutLine(line, at - line.startedAt);
  } else if (type === 'heard') {
    cutLine(line, audioEndMs);
  }
}

function startCountdown(seconds) {
  const endsAt = Date.now() + seconds * 1000;
  const update = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    $('call-status').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  };
  update();
  callCountdown = setInterval(update, 1000);
}

// Paid plans keep the transcript to personalize later calls, and recorded calls keep it for review.
// What was said on the call, as heard: a line Ping was cut off in ends where it stopped.
const heardLines = () => [...transcript.values()].map((line) => ({ from: line.from, text: heardText(line) })).filter((line) => line.text.trim());

async function saveTranscript(callId, recorded) {
  if (!isPaid() && !recorded) return;
  await api(`/api/calls/${callId}/transcript`, { method: 'POST', body: { lines: heardLines() } }).catch((error) => console.warn('Could not save the conversation', error));
}

// The JLPT word list, loaded the first time a call ends. Without it the word counts are just zero.
let jlptLevels = null;
async function loadWordLevels() {
  jlptLevels ??= fetch('/jlpt-words.json')
    .then((response) => (response.ok ? response.json() : null))
    .then((list) => wordLevels(list))
    .catch(() => new Map());
  return jlptLevels;
}

// Numbers about the learner's Japanese on this call, worked out here from the transcript. Only the numbers are
// sent, on every call that connected, whether or not it was recorded.
async function sendLearning(callId, { stackWords, newWords, lookedUpIds }) {
  const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  const lines = heardLines();
  const learning = summarizeLearning({ lines, stackWords, newWords, levels: await loadWordLevels(), segmenter });
  await api(`/api/calls/${callId}/learning`, { method: 'POST', body: learning }).catch((error) => console.warn('Could not save the learning numbers', error));
  // Each saved word's progress: which came back, which they used, which they asked about again. Word ids only.
  await api(`/api/calls/${callId}/words`, { method: 'POST', body: wordEvents({ lines, stackWords, lookedUpIds }) }).catch((error) => console.warn('Could not save word progress', error));
}

// scenarioId: an admin's controlled test call, which shows its checklist above the transcript.
function beginCall(callId, contactName = 'Ping', scenarioId = null) {
  transcript = new Map();
  pace = createPace();
  clearInterval(revealTimer);
  revealTimer = null;
  activeCallId = callId;
  $('call-transcript').replaceChildren();
  showScenarioPanel(callId, scenarioId);
  $('tap-to-hear').hidden = true;
  $('call-name').textContent = contactName;
  $('call-avatar').textContent = initialOf(contactName);
  $('call-status').textContent = 'Connecting...';
  $('tap-to-hear').textContent = `Tap to hear ${contactName}`;
  callHint(null);
  showSpeedPopup(false);
  setPressed('speaker-button', false);
  setMuted(false);
  show('call');
  let outOfCredit = false;
  let connected = false;
  const stackWords = [...(state.me.words ?? [])]; // the stack as the call starts, to count which saved words get used
  let newWords = 0;
  const lookedUpIds = []; // saved words they asked about again on this call
  // Admins can keep a copy on the phone for demo videos. Accounts with recording on upload it for review.
  const keepOnPhone = recordCallsOn();
  const forReview = Boolean(state.me.recording?.on);
  if (keepOnPhone) keepRecording({ recording: null, waiting: true });
  activeCall = startCall({
    callId,
    api,
    level: state.me.settings.proficiency,
    audio: $('remote-audio'),
    onStatus: (status, maxSeconds) => {
      if (status !== 'connected') return;
      connected = true;
      $('tap-to-hear').hidden = true;
      startCountdown(maxSeconds);
      api(`/api/calls/${callId}/connected`, { method: 'POST' }).catch((error) => console.warn('Could not count the call', error));
    },
    onLine: showLine,
    onContactAudio,
    record: keepOnPhone || forReview,
    onRecording: (recording, problem) => {
      if (keepOnPhone) keepRecording({ recording, problem });
      if (forReview && recording) upload(`/api/calls/${callId}/recording`, recording.blob).catch((error) => console.warn('Could not upload the recording', error));
    },
    // OpenAI credit ran out. Only admins are told that's the reason (failedCallNotice); the call itself is
    // ended by onCantTalk's path below, the same way for everyone.
    onOutOfCredit: () => {
      outOfCredit = true;
    },
    // The contact can't talk: say so on the call screen now. The call ends a few seconds later, as 'unavailable'.
    onCantTalk: () => {
      callHint(failedCallNotice({ admin: isAdmin(), outOfCredit, contactName }));
    },
    onWordAdded: (word, { alreadySaved = false } = {}) => {
      if (!alreadySaved) newWords += 1;
      else if (word?.id) lookedUpIds.push(word.id);
      const note = alreadySaved ? '*already in your stack*' : '*added to stack*';
      addTranscriptNode(el('p', { className: 'line note', textContent: `${word.kanji || word.kana} ${note}` }));
    },
    onSpeaking: (speaking) => $('call-avatar').classList.toggle('speaking', speaking),
    onSettings: (settings) => {
      state.me.settings = settings;
    },
    onNeedsTap: () => {
      $('tap-to-hear').hidden = false;
    },
    onEnded: async (reason) => {
      activeCall = null;
      activeCallId = null;
      clearInterval(callCountdown);
      clearInterval(revealTimer);
      revealTimer = null;
      $('call-avatar').classList.remove('speaking');
      // Tells the server the call is over, so it can't be reconnected, and why, so a call that broke straight away
      // doesn't use up the day's call.
      await api(`/api/calls/${callId}/ended`, { method: 'POST', body: { reason } }).catch((error) => console.warn('Could not end the call', error));
      await saveTranscript(callId, forReview);
      if (connected) await sendLearning(callId, { stackWords, newWords, lookedUpIds });
      await refresh().catch(() => {});
      const couldntTalk = reason === 'unavailable';
      const ended = couldntTalk ? failedCallNotice({ admin: isAdmin(), outOfCredit, contactName }) : endedNotice(reason);
      // A call that connected asks for a quick rating first. One that never connected, or where the contact
      // couldn't talk, has nothing to rate.
      if (connected && !couldntTalk) askForRating(callId, ended);
      else {
        goHome();
        notice(ended);
      }
    },
  });
}

// After a call: two 1-5 taps on one page, sent to the server as numbers only.
const RATING_QUESTIONS = { cutOffs: 'rate-cutoffs', naturalness: 'rate-natural' };
let rating = null; // { callId, endedNotice, cutOffs, naturalness } while the page is open

function askForRating(callId, endedNotice) {
  rating = { callId, endedNotice, cutOffs: null, naturalness: null };
  for (const [field, id] of Object.entries(RATING_QUESTIONS)) {
    $(id).replaceChildren(
      ...[1, 2, 3, 4, 5].map((value) => {
        const button = el('button', { type: 'button', className: 'rating-choice', textContent: String(value) });
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => chooseRating(field, value));
        return button;
      }),
    );
  }
  $('rate-done').disabled = true;
  $('rate-comment').value = '';
  show('rate');
}

function chooseRating(field, value) {
  rating[field] = value;
  for (const button of $(RATING_QUESTIONS[field]).children) button.setAttribute('aria-pressed', String(Number(button.textContent) === value));
  $('rate-done').disabled = !(rating.cutOffs && rating.naturalness);
}

function finishRating(send) {
  if (!rating) return;
  const { callId, endedNotice, cutOffs, naturalness } = rating;
  const comment = $('rate-comment').value.trim() || null;
  rating = null;
  if (send) api(`/api/calls/${callId}/rating`, { method: 'POST', body: { cutOffs, naturalness, comment } }).catch((error) => console.warn('Could not save the rating', error));
  goHome();
  notice(endedNotice);
}

// What the caller hears while the phone rings: Japan's ringback, a low tone for 1 second in every 3.
// Started straight from the tap, because browsers only allow sound that a tap started.
function playRingback() {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) return () => {};
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 400;
  gain.gain.value = 0.06;
  gain.gain.setValueAtTime(0, context.currentTime + 1);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  return () => context.close().catch(() => {});
}

let outgoing = null; // the call the user is making, while it rings

function callContact(contactId) {
  if (activeCall || outgoing) return;
  const contactName = state.me.contacts.find((contact) => contact.id === contactId)?.name ?? 'Ping';
  $('outgoing-name').textContent = contactName;
  $('outgoing-avatar').textContent = initialOf(contactName);
  show('outgoing');
  const stopTone = playRingback();
  const timer = setTimeout(async () => {
    stopTone();
    outgoing = null;
    try {
      const { id, contactName: name, scenarioId } = await api('/api/calls', { method: 'POST', body: { contactId } });
      beginCall(id, name, scenarioId);
    } catch (error) {
      goHome();
      notice(error.message);
    }
  }, OUTGOING_RING_MS);
  outgoing = { timer, stopTone };
}

// Hanging up while it rings: nothing has started yet, so there's nothing to end on the server.
function cancelOutgoing() {
  if (!outgoing) return;
  clearTimeout(outgoing.timer);
  outgoing.stopTone();
  outgoing = null;
  goHome();
}

// Getting going

function bindEvents() {
  // A ringtone can only play through audio that a tap set up, so the first taps prepare it for later calls.
  for (const type of ['touchend', 'click', 'keydown']) {
    document.addEventListener(type, () => audioUnlocked() || unlockAudio(), { capture: true, passive: true });
  }
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-go]');
    if (link) go(link.dataset.go);
    if (event.target.closest('[data-back]')) goBack();
  });
  $('join-form').addEventListener('submit', join);
  $('enable-button').addEventListener('click', enable);
  $('enable-skip').addEventListener('click', () => useBrowserOnly(goHome));
  $('level-back').addEventListener('click', renderWelcome);
  $('install-button').addEventListener('click', installApp);
  // The "just use this browser" link is for computers only; a phone needs notifications to be called.
  $('enable-skip').hidden = device !== 'desktop';
  $('enable-skip').nextElementSibling.hidden = device !== 'desktop';
  $('browser-note-enable').addEventListener('click', () => show('enable'));
  $('level-choices').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-level]');
    if (choice) chooseLevel(choice.dataset.level);
  });
  $('answer-button').addEventListener('click', () => answer(ringingCallId));
  $('outgoing-cancel').addEventListener('click', cancelOutgoing);
  $('policy-notice-ok').addEventListener('click', dismissPolicyNotice);
  $('rate-done').addEventListener('click', () => finishRating(true));
  $('rate-skip').addEventListener('click', () => finishRating(false));
  $('home-call-button').addEventListener('click', () => callContact(homeContact()?.id ?? 'ping'));
  $('decline-button').addEventListener('click', decline);
  $('hangup-button').addEventListener('click', () => activeCall?.hangUp());
  $('mute-button').addEventListener('click', () => setMuted($('mute-button').getAttribute('aria-pressed') !== 'true'));
  $('speaker-button').addEventListener('click', toggleSpeaker);
  $('speed-button').addEventListener('click', () => showSpeedPopup($('call-speed-popup').hidden));
  $('call-speed-close').addEventListener('click', () => showSpeedPopup(false));
  $('call-speed-input').addEventListener('input', (event) => {
    $('call-speed-output').textContent = `${Number(event.target.value).toFixed(2)}×`;
  });
  $('call-speed-input').addEventListener('change', (event) => changeCallSpeed(Number(event.target.value)));
  $('tap-to-hear').addEventListener('click', () => activeCall?.resumeAudio());
  navigator.serviceWorker?.addEventListener('message', ({ data }) => {
    if (data.type === 'ring') showRinging(data.callId, data.contactName);
    else if (data.type === 'missed' && data.callId === ringingCallId) missed();
    else if (data.type === 'answer' && !activeCallId) answer(data.callId);
    // A missed call's notification opens the Calls tab, where the voicemail is.
    else if (data.type === 'show-messages' && !activeCallId) refresh().then(showCallsTab, showCallsTab);
  });
}

async function init() {
  onShow('home', renderHome);
  initStack();
  initContacts({ onCall: callContact });
  initRecents({ onCall: callContact });
  initOnboarding({ onWelcomeDone: showLevelPicker });
  initProgress();
  initSettings();
  bindEvents();
  enableSwipeBack();
  navigator.serviceWorker?.register('/sw.js');
  state.config = await api('/api/config').catch(() => ({}));
  state.token = readToken();

  // A phone in a browser tab adds Ping to its Home Screen first, whether or not it has an account here.
  if (mustInstall) return renderInstall();
  if (!state.token) return show('join');

  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      writeToken(null);
      return show('join');
    }
    throw error;
  }

  if (pushAllowed()) {
    // Browsers can replace a subscription at any time, so send the current one on every open.
    await subscribeToPush().catch((error) => console.warn('Could not refresh the push subscription', error));
  } else if (!browserOnly()) {
    // Onboarding and the level come first; turning on notifications after them.
    if (state.me.needsOnboarding || !state.me.levelChosen) return goHome();
    return show('enable');
  }

  const params = new URLSearchParams(location.search);
  const callId = params.get('call');
  history.replaceState(null, '', '/');
  if (params.get('messages')) showCallsTab();
  else goHome();
  if (callId) answer(callId);
}

init().catch((error) => {
  console.error(error);
  show('join');
  setError('join-error', "Ping couldn't load. Check your connection and try again.");
});
