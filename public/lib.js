// What every screen shares: the signed-in user, talking to the server, and moving between screens.

const TOKEN_KEY = 'ping-token';

// The screens with the bottom navigation, and which tab each one belongs to.
const SCREEN_TABS = {
  home: 'home',
  stack: 'home',
  words: 'home',
  word: 'home',
  sentences: 'home',
  contacts: 'contacts',
  settings: 'settings',
  account: 'settings',
  'manage-calls': 'settings',
  plan: 'settings',
  privacy: 'settings',
  terms: 'settings',
  feedback: 'settings',
};
const SCREENS = [...Object.keys(SCREEN_TABS), 'install', 'join', 'enable', 'ringing', 'call'];
const renderers = {};

export const state = { token: null, config: {}, me: null };

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export const isPaid = () => state.me?.plan === 'plus' || state.me?.plan === 'pro';

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

export function go(name) {
  renderers[name]?.();
  show(name);
}

export function setError(id, text) {
  $(id).textContent = text ?? '';
  $(id).hidden = !text;
}

export const initialOf = (name) => (name === 'Ping' ? 'ピ' : name === 'Mero' ? 'メ' : [...name][0]);

export const formatDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'long', day: 'numeric' });

export const clearWarning = () =>
  state.me.clearAt ? `Your subscription ended. Words, sentences and conversations saved during it will clear on ${formatDate(state.me.clearAt)}. Resubscribe before then to keep them.` : '';
