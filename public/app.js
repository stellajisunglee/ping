import { initContacts } from './contacts.js';
import { charsSaid, createPace } from './reveal.js';
import { $, api, clearWarning, el, enableSwipeBack, go, goBack, initialOf, isAdmin, isPaid, onShow, readToken, refresh, setError, show, showCallingNote, state, writeToken } from './lib.js';
import { initSettings } from './settings.js';
import { initStack, renderStackTiles } from './stack.js';
import { startCall } from './voice.js';

const RING_FALLBACK_MS = 12_000; // the server decides a call was missed. This only covers its message getting lost.
const RING_TONE_EVERY_MS = 3_000;
const VIBRATION = [400, 200, 400, 200, 400];
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

function isIosBrowserTab() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return ios && !installed;
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
    go('home');
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
    show('enable');
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

function renderVoicemail() {
  const { voicemail } = state.me;
  $('voicemail-section').hidden = !voicemail;
  if (!voicemail) return;

  const when = el('p', {
    className: 'muted',
    textContent: `Missed call from ${voicemail.contactName}, ${new Date(voicemail.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
  });
  const japanese = el('p', { lang: 'ja', textContent: voicemail.japanese });
  const english = el('p', { className: 'muted', textContent: voicemail.english });
  const player = el('audio', { controls: true, preload: 'none', src: voicemail.audioUrl });
  const card = el('div', { className: voicemail.heard ? 'card message' : 'card message unheard' }, when, japanese, english, player);
  player.addEventListener('play', () => {
    player.playbackRate = state.me.settings.speed;
    if (!voicemail.heard) {
      voicemail.heard = true;
      card.className = 'card message';
      api(`/api/messages/${voicemail.id}/heard`, { method: 'POST' }).catch(() => {});
    }
  });
  // Without a recording the words above still deliver the message.
  player.addEventListener('error', () => player.remove());

  const callBack = el('button', { className: 'secondary', type: 'button', textContent: 'Call back', disabled: !state.me.calling.canCall });
  callBack.addEventListener('click', () => callContact(voicemail.contactId));
  card.append(callBack);
  $('voicemail').replaceChildren(card);
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
      const status = day.practiced ? 'practiced' : day.callDay ? 'missed' : 'day off';
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
  showCallingNote('home-minutes');
  $('streak-current').textContent = streak.current;
  $('streak-best').textContent = streak.best ? `Best: ${streak.best} ${streak.best === 1 ? 'day' : 'days'}` : '';
  renderWeek(streak.week);
  $('home-status').textContent = describeSchedule();
  renderLastCall();
  setError('home-clear', clearWarning());
  renderStackTiles();
  renderVoicemail();
}

const goHome = () => go('home');

// Ringing

function playRingTone() {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const context = AudioContextClass ? new AudioContextClass() : null;
  const ringOnce = () => {
    navigator.vibrate?.(VIBRATION);
    if (!context) return;
    for (const [frequency, start] of [[880, 0], [660, 0.25], [880, 0.6], [660, 0.85]]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + start);
      oscillator.stop(context.currentTime + start + 0.2);
    }
  };
  ringOnce();
  const interval = setInterval(ringOnce, RING_TONE_EVERY_MS);
  ringTone = () => {
    clearInterval(interval);
    navigator.vibrate?.(0);
    context?.close();
  };
}

function stopRinging() {
  clearTimeout(ringFallback);
  ringTone?.();
  ringTone = null;
  ringingCallId = null;
}

async function closeNotifications() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const notifications = (await registration?.getNotifications({ tag: 'ping-call' })) ?? [];
  notifications.forEach((notification) => notification.close());
}

function showRinging(callId, contactName = 'Ping') {
  if (activeCall || ringingCallId === callId) return;
  ringingCallId = callId;
  $('ringing-name').textContent = contactName;
  $('ringing-avatar').textContent = initialOf(contactName);
  show('ringing');
  playRingTone();
  ringFallback = setTimeout(() => {
    stopRinging();
    refresh().then(goHome, goHome);
  }, RING_FALLBACK_MS);
}

async function answer(callId) {
  stopRinging();
  closeNotifications();
  try {
    const { state: callState, contactName } = await api(`/api/calls/${callId}/answer`, { method: 'POST' });
    if (callState === 'answered') return beginCall(callId, contactName);
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

// Calls stop at the plan's longest call, or sooner when a call the user made runs out of the month's minutes.
function timeLimitNotice() {
  const { calling } = state.me;
  if (calling.monthlyMinutes !== null && !calling.canCall) return calling.reason;
  return `That was a good chat! Calls on your plan last up to ${calling.perCallMinutes} minutes.`;
}
// Only admins are told and the call hangs up. For everyone else the call behaves as it did before.
const OUT_OF_CREDIT_NOTICE = "Admin: OpenAI is out of credit, so Ping can't talk. Add credit at platform.openai.com/settings/organization/billing, then call again.";

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
    const { settings, turnDetection, smartTurn } = await api('/api/settings', { method: 'PATCH', body: { speed } });
    state.me.settings = settings;
    activeCall?.updateVoice({ settings, turnDetection, smartTurn });
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

async function saveTranscript(callId) {
  if (!isPaid()) return;
  const lines = [...transcript.values()].map((line) => ({ from: line.from, text: heardText(line) })).filter((line) => line.text.trim());
  await api(`/api/calls/${callId}/transcript`, { method: 'POST', body: { lines } }).catch((error) => console.warn('Could not save the conversation', error));
}

function beginCall(callId, contactName = 'Ping') {
  transcript = new Map();
  pace = createPace();
  clearInterval(revealTimer);
  revealTimer = null;
  activeCallId = callId;
  $('call-transcript').replaceChildren();
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
  activeCall = startCall({
    callId,
    api,
    audio: $('remote-audio'),
    onStatus: (status, maxSeconds) => {
      if (status !== 'connected') return;
      $('tap-to-hear').hidden = true;
      startCountdown(maxSeconds);
      api(`/api/calls/${callId}/connected`, { method: 'POST' }).catch((error) => console.warn('Could not count the call', error));
    },
    onLine: showLine,
    onContactAudio,
    onOutOfCredit: () => {
      if (!isAdmin()) return;
      outOfCredit = true;
      activeCall?.hangUp();
    },
    onWordAdded: (word, { alreadySaved = false } = {}) => {
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
      // Gives back the minutes the call didn't use.
      await api(`/api/calls/${callId}/ended`, { method: 'POST' }).catch((error) => console.warn('Could not end the call', error));
      await saveTranscript(callId);
      await refresh().catch(() => {});
      goHome();
      notice(outOfCredit ? OUT_OF_CREDIT_NOTICE : endedNotice(reason));
    },
  });
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
      const { id, contactName: name } = await api('/api/calls', { method: 'POST', body: { contactId } });
      beginCall(id, name);
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
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-go]');
    if (link) go(link.dataset.go);
    if (event.target.closest('[data-back]')) goBack();
  });
  $('join-form').addEventListener('submit', join);
  $('enable-button').addEventListener('click', enable);
  $('answer-button').addEventListener('click', () => answer(ringingCallId));
  $('outgoing-cancel').addEventListener('click', cancelOutgoing);
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
    else if (data.type === 'show-messages' && !activeCallId) refresh().then(goHome, goHome);
  });
}

async function init() {
  onShow('home', renderHome);
  initStack();
  initContacts({ onCall: callContact });
  initSettings();
  bindEvents();
  enableSwipeBack();
  navigator.serviceWorker?.register('/sw.js');
  state.config = await api('/api/config').catch(() => ({}));
  state.token = readToken();

  if (!state.token) return show(isIosBrowserTab() ? 'install' : 'join');

  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      writeToken(null);
      return show(isIosBrowserTab() ? 'install' : 'join');
    }
    throw error;
  }

  const pushAllowed = 'Notification' in window && Notification.permission === 'granted';
  if (!pushAllowed) return show('enable');
  // Browsers can replace a subscription at any time, so send the current one on every open.
  await subscribeToPush().catch((error) => console.warn('Could not refresh the push subscription', error));

  const params = new URLSearchParams(location.search);
  const callId = params.get('call');
  history.replaceState(null, '', '/');
  goHome();
  if (callId) answer(callId);
}

init().catch((error) => {
  console.error(error);
  show('join');
  setError('join-error', "Ping couldn't load. Check your connection and try again.");
});
