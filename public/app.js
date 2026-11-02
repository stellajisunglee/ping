import { initContacts } from './contacts.js';
import { $, api, clearWarning, el, go, initialOf, isPaid, onShow, readToken, refresh, setError, show, state, writeToken } from './lib.js';
import { initSettings } from './settings.js';
import { initStack } from './stack.js';
import { startCall } from './voice.js';

const RING_FALLBACK_MS = 12_000; // the server decides a call was missed. This only covers its message getting lost.
const RING_TONE_EVERY_MS = 3_000;
const VIBRATION = [400, 200, 400, 200, 400];

let ringingCallId = null;
let ringFallback = null;
let ringTone = null;
let activeCall = null;
let activeCallId = null;
let callCountdown = null;
let transcript = new Map();

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

  const callBack = el('button', { className: 'secondary', type: 'button', textContent: 'Call back' });
  callBack.addEventListener('click', () => callContact(voicemail.contactId));
  card.append(callBack);
  $('voicemail').replaceChildren(card);
}

function renderHome() {
  const { streak } = state.me;
  $('streak-current').textContent = streak.current;
  $('streak-best').textContent = streak.best;
  $('home-status').textContent = describeSchedule();
  setError('home-clear', clearWarning());
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
  'time-limit': 'That was a good chat! Calls end after 3 minutes.',
};

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
    const { settings, turnDetection } = await api('/api/settings', { method: 'PATCH', body: { speed } });
    state.me.settings = settings;
    activeCall?.updateVoice({ settings, turnDetection });
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
    line = { from, text: '', node };
    transcript.set(id, line);
    addTranscriptNode(node);
  }
  line.text = delta ? line.text + delta : text;
  line.node.textContent = line.text;
  line.node.hidden = !line.text.trim();
  const list = $('call-transcript');
  list.scrollTop = list.scrollHeight;
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
  const lines = [...transcript.values()].map(({ from, text }) => ({ from, text })).filter((line) => line.text.trim());
  await api(`/api/calls/${callId}/transcript`, { method: 'POST', body: { lines } }).catch((error) => console.warn('Could not save the conversation', error));
}

function beginCall(callId, contactName = 'Ping') {
  transcript = new Map();
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
    onWordAdded: (word) => {
      addTranscriptNode(el('p', { className: 'line note', textContent: `${word.kanji || word.kana} *added to stack*` }));
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
      $('call-avatar').classList.remove('speaking');
      await saveTranscript(callId);
      await refresh().catch(() => {});
      goHome();
      notice(ENDED_NOTICE[reason] ?? null);
    },
  });
}

async function callContact(contactId) {
  try {
    const { id, contactName } = await api('/api/calls', { method: 'POST', body: { contactId } });
    beginCall(id, contactName);
  } catch (error) {
    goHome();
    notice(error.message);
  }
}

// Getting going

function bindEvents() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-go]');
    if (link) go(link.dataset.go);
  });
  $('join-form').addEventListener('submit', join);
  $('enable-button').addEventListener('click', enable);
  $('answer-button').addEventListener('click', () => answer(ringingCallId));
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
