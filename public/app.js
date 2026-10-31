import { startCall } from './voice.js';

const TOKEN_KEY = 'ping-token';
const RING_FALLBACK_MS = 12_000; // the server decides a call was missed. This only covers its message getting lost.
const RING_TONE_EVERY_MS = 3_000;

const $ = (id) => document.getElementById(id);
const SCREENS = ['install', 'join', 'enable', 'home', 'ringing', 'call'];

let token = null;
let config = {};
let me = null;
let ringingCallId = null;
let ringFallback = null;
let ringTone = null;
let activeCall = null;
let captionText = '';

function show(name) {
  for (const screen of SCREENS) $(`screen-${screen}`).hidden = screen !== name;
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the user just signs in again next time.
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

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
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.vapidPublicKey) }));
  me = await api('/api/push', { method: 'PUT', body: { subscription, timeZone: timeZone() } });
}

async function enable() {
  const errorElement = $('enable-error');
  errorElement.hidden = true;
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    errorElement.textContent = "This browser can't receive calls. Try Chrome, Edge or Firefox, or Safari from the Home Screen.";
    errorElement.hidden = false;
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    errorElement.textContent = "Notifications are blocked, so Mina can't call you. Allow them in your browser or phone settings, then try again.";
    errorElement.hidden = false;
    return;
  }
  let microphoneWarning = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    microphoneWarning = "Microphone is off. You'll need it to talk to Mina, so allow it in your browser or phone settings.";
  }
  try {
    await subscribeToPush();
    showHome();
    notice(microphoneWarning);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function join(event) {
  event.preventDefault();
  const errorElement = $('join-error');
  errorElement.hidden = true;
  try {
    const result = await api('/api/register', { method: 'POST', body: { inviteCode: $('invite-code').value.trim(), timeZone: timeZone() } });
    token = result.token;
    writeToken(token);
    me = result;
    show('enable');
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

// Home

function renderSettings() {
  const { speed, thinkingTime, callsEnabled } = me.settings;
  $('speed-input').value = speed;
  $('speed-output').textContent = `${Number(speed).toFixed(2)}×`;
  $('thinking-input').value = thinkingTime;
  $('calls-input').checked = callsEnabled;
  $('home-status').textContent = callsEnabled ? 'Calls once a day, sometime between 10:00 and 20:00' : 'Daily calls are off';
}

function renderMessages() {
  const list = $('messages-list');
  list.replaceChildren();
  $('messages-section').hidden = me.messages.length === 0;
  for (const message of me.messages) {
    const item = document.createElement('li');
    item.className = message.heard ? 'message' : 'message unheard';

    const when = document.createElement('p');
    when.className = 'muted';
    when.textContent = `Missed call, ${new Date(message.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

    const japanese = document.createElement('p');
    japanese.lang = 'ja';
    japanese.textContent = me.voiceMessage.japanese;

    const english = document.createElement('p');
    english.className = 'muted';
    english.textContent = me.voiceMessage.english;

    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.src = '/voice-message.mp3';
    player.addEventListener('play', () => {
      player.playbackRate = me.settings.speed;
      if (!message.heard) {
        message.heard = true;
        item.className = 'message';
        api(`/api/messages/${message.id}/heard`, { method: 'POST' }).catch(() => {});
      }
    });
    // Without a recording the words above still deliver the message.
    player.addEventListener('error', () => player.remove());

    const callBack = document.createElement('button');
    callBack.className = 'secondary';
    callBack.type = 'button';
    callBack.textContent = 'Call back';
    callBack.addEventListener('click', callMina);

    item.append(when, japanese, english, player, callBack);
    list.append(item);
  }
}

function showHome() {
  renderSettings();
  renderMessages();
  show('home');
}

async function refresh() {
  me = await api('/api/me');
}

async function changeSetting(change) {
  const { settings } = await api('/api/settings', { method: 'PATCH', body: change });
  me.settings = settings;
  renderSettings();
}

async function deleteAccount() {
  if (!confirm('Delete your account? Mina will stop calling and your voice messages will be removed.')) return;
  await api('/api/me', { method: 'DELETE' });
  const registration = await navigator.serviceWorker?.ready;
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  token = null;
  writeToken(null);
  me = null;
  show('join');
}

// Ringing

function playRingTone() {
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const ringOnce = () => {
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
    context.close();
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
  const notifications = (await registration?.getNotifications({ tag: 'mina-call' })) ?? [];
  notifications.forEach((notification) => notification.close());
}

function showRinging(callId) {
  if (activeCall || ringingCallId === callId) return;
  ringingCallId = callId;
  show('ringing');
  playRingTone();
  ringFallback = setTimeout(() => {
    stopRinging();
    refresh().then(showHome, showHome);
  }, RING_FALLBACK_MS);
}

async function answer(callId) {
  stopRinging();
  closeNotifications();
  try {
    const { state } = await api(`/api/calls/${callId}/answer`, { method: 'POST' });
    if (state === 'answered') return beginCall(callId);
    await refresh();
    showHome();
    if (state === 'missed') notice('You just missed Mina. She left a voice message below.');
    else notice('That call has ended.');
  } catch (error) {
    showHome();
    notice(error.message);
  }
}

async function decline() {
  const callId = ringingCallId;
  stopRinging();
  closeNotifications();
  showHome();
  await api(`/api/calls/${callId}/decline`, { method: 'POST' }).catch(() => {});
}

async function missed() {
  stopRinging();
  await refresh().catch(() => {});
  showHome();
  notice('You missed Mina. She left a voice message below.');
}

// On a call

const CALL_STATUS = { connecting: 'Connecting...', connected: 'On a call' };

const ENDED_NOTICE = {
  'no-microphone': "Mina can't hear you because the microphone is off. Allow it in your browser or phone settings, then call back.",
  dropped: 'The call dropped. You can call Mina back.',
  failed: "The call couldn't connect. Please try calling back.",
  'time-limit': 'That was a good chat! Calls end after a few minutes.',
};

function setMuted(muted) {
  activeCall?.setMuted(muted);
  const button = $('mute-button');
  button.setAttribute('aria-pressed', String(muted));
  button.textContent = muted ? 'Unmute' : 'Mute';
}

function beginCall(callId) {
  captionText = '';
  $('call-caption').textContent = '';
  $('tap-to-hear').hidden = true;
  setMuted(false);
  show('call');
  activeCall = startCall({
    callId,
    api,
    audio: $('remote-audio'),
    onStatus: (status) => {
      $('call-status').textContent = CALL_STATUS[status];
      if (status === 'connected') $('tap-to-hear').hidden = true;
    },
    onCaption: (text, append = false) => {
      captionText = append ? captionText + text : text;
      $('call-caption').textContent = captionText;
    },
    onSpeaking: (speaking) => $('call-avatar').classList.toggle('speaking', speaking),
    onSettings: (settings) => {
      me.settings = settings;
      renderSettings();
    },
    onNeedsTap: () => {
      $('tap-to-hear').hidden = false;
    },
    onEnded: (reason) => {
      activeCall = null;
      $('call-avatar').classList.remove('speaking');
      refresh()
        .catch(() => {})
        .finally(() => {
          showHome();
          notice(ENDED_NOTICE[reason] ?? null);
        });
    },
  });
}

async function callMina() {
  notice(null);
  try {
    const { id } = await api('/api/calls', { method: 'POST' });
    beginCall(id);
  } catch (error) {
    notice(error.message);
  }
}

async function testRing() {
  try {
    await api('/api/test-ring', { method: 'POST' });
    notice('Ringing in 5 seconds. Lock your phone or close the app if you want to see the notification.');
  } catch (error) {
    notice(error.message);
  }
}

// Getting going

function bindEvents() {
  $('join-form').addEventListener('submit', join);
  $('enable-button').addEventListener('click', enable);
  $('call-button').addEventListener('click', callMina);
  $('test-ring-button').addEventListener('click', testRing);
  $('delete-button').addEventListener('click', () => deleteAccount().catch((error) => notice(error.message)));
  $('answer-button').addEventListener('click', () => answer(ringingCallId));
  $('decline-button').addEventListener('click', decline);
  $('hangup-button').addEventListener('click', () => activeCall?.hangUp());
  $('mute-button').addEventListener('click', () => setMuted($('mute-button').getAttribute('aria-pressed') !== 'true'));
  $('tap-to-hear').addEventListener('click', () => activeCall?.resumeAudio());
  $('speed-input').addEventListener('input', (event) => {
    $('speed-output').textContent = `${Number(event.target.value).toFixed(2)}×`;
  });
  $('speed-input').addEventListener('change', (event) => changeSetting({ speed: Number(event.target.value) }).catch((error) => notice(error.message)));
  $('thinking-input').addEventListener('change', (event) => changeSetting({ thinkingTime: event.target.value }).catch((error) => notice(error.message)));
  $('calls-input').addEventListener('change', (event) => changeSetting({ callsEnabled: event.target.checked }).catch((error) => notice(error.message)));
  navigator.serviceWorker?.addEventListener('message', ({ data }) => {
    if (data.type === 'ring') showRinging(data.callId);
    else if (data.type === 'missed' && data.callId === ringingCallId) missed();
    else if (data.type === 'answer' && !activeCall) answer(data.callId);
    else if (data.type === 'show-messages' && !activeCall) refresh().then(showHome, showHome);
  });
}

async function init() {
  bindEvents();
  navigator.serviceWorker?.register('/sw.js');
  config = await api('/api/config').catch(() => ({}));
  token = readToken();

  if (!token) return show(isIosBrowserTab() ? 'install' : 'join');

  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      token = null;
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
  showHome();
  if (callId) answer(callId);
}

init().catch((error) => {
  console.error(error);
  show('join');
  $('join-error').textContent = "Ping couldn't load. Check your connection and try again.";
  $('join-error').hidden = false;
});
