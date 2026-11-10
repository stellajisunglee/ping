// What every screen shares: the signed-in user, talking to the server, and moving between screens.

const TOKEN_KEY = 'ping-token';

// The screens with the bottom navigation, and which tab each one belongs to.
const SCREEN_TABS = {
  home: 'home',
  words: 'home',
  word: 'home',
  sentences: 'home',
  contacts: 'contacts',
  'contact-new': 'contacts',
  settings: 'settings',
  account: 'settings',
  'manage-calls': 'settings',
  plan: 'settings',
  privacy: 'settings',
  terms: 'settings',
  feedback: 'settings',
};
const SCREENS = [...Object.keys(SCREEN_TABS), 'install', 'join', 'enable', 'ringing', 'outgoing', 'call'];
const renderers = {};
const TAB_ROOTS = ['home', 'contacts', 'settings'];
const BACK_SWIPE_DISTANCE = 70;

let trail = [];
let currentScreen = null;

export const state = { token: null, config: {}, me: null };

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export const isPaid = () => state.me?.plan === 'premium' || state.me?.plan === 'platinum';
export const isAdmin = () => state.me?.role === 'admin';

const PLAN_LABELS = { free: 'Free', premium: 'Premium', platinum: 'Platinum' };

// Fills in a badge with the user's plan.
export function showPlanBadge(id) {
  const plan = state.me?.plan ?? 'free';
  $(id).textContent = PLAN_LABELS[plan] ?? plan;
  $(id).classList.toggle('free', plan === 'free');
}

// One line on whether the user can call now, and their minutes. Null when there's nothing to say.
export function callingNote() {
  const calling = state.me?.calling;
  if (!calling) return null;
  if (calling.monthlyMinutes === null) return calling.canCall ? null : calling.reason;
  if (!calling.canCall) return calling.reason;
  return `${calling.minutesLeft} of ${calling.monthlyMinutes} minutes left this month. Calls last up to ${calling.perCallMinutes} minutes.`;
}

export function showCallingNote(id) {
  const note = callingNote();
  $(id).textContent = note ?? '';
  $(id).hidden = !note;
}

export function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(value) {
  state.token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the user just signs in again next time.
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const { token } = state;
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

export async function refresh() {
  state.me = await api('/api/me');
}

export function show(name) {
  currentScreen = name;
  for (const screen of SCREENS) $(`screen-${screen}`).hidden = screen !== name;
  const tab = SCREEN_TABS[name];
  $('hero').hidden = !tab;
  for (const link of $('hero').querySelectorAll('[data-go]')) {
    if (link.dataset.go === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

export function onShow(name, render) {
  renderers[name] = render;
}

// Remembers the way here, so going back returns to the page the user actually came from.
export function go(name) {
  const earlier = trail.indexOf(name);
  if (TAB_ROOTS.includes(name)) trail = [name];
  else if (earlier >= 0) trail = trail.slice(0, earlier + 1);
  else trail = [...trail, name];
  renderers[name]?.();
  show(name);
}

export function goBack() {
  if (trail.length > 1) go(trail.at(-2));
}

// Swiping left to right goes back, except during calls and sign-up.
export function enableSwipeBack() {
  let start = null;
  document.addEventListener(
    'touchstart',
    (event) => {
      const onSlider = event.target.closest?.('input[type="range"]');
      start = event.touches.length === 1 && !onSlider ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    },
    { passive: true },
  );
  document.addEventListener(
    'touchend',
    (event) => {
      if (!start || !SCREEN_TABS[currentScreen]) return;
      const across = event.changedTouches[0].clientX - start.x;
      const down = Math.abs(event.changedTouches[0].clientY - start.y);
      start = null;
      if (across >= BACK_SWIPE_DISTANCE && across > down * 2) goBack();
    },
    { passive: true },
  );
}

export function setError(id, text) {
  $(id).textContent = text ?? '';
  $(id).hidden = !text;
}

export const initialOf = (name) => (name === 'Ping' ? 'ピ' : name === 'Mero' ? 'メ' : [...name][0]);

export const formatDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'long', day: 'numeric' });

export const clearWarning = () =>
  state.me.clearAt ? `Your subscription ended. Words, sentences and conversations saved during it will clear on ${formatDate(state.me.clearAt)}. Resubscribe before then to keep them.` : '';
