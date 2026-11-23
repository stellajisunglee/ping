// The first pages a beta tester or Free user sees: their name (and how Ping says it), when Ping should call, and
// their plan; then their level (app.js). Then everyone sees "Connecting to Ping" for a few seconds before Home.
// Also the name fields in Manage Account, and the upgrade page, which is a placeholder until payments exist.

import { $, api, el, show, state } from './lib.js';

export const CONNECTING_MS = 5000;
const READING_DELAY_MS = 700; // wait for typing to pause before suggesting how to say the name

const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`;
const hourOptions = (minimum, maximum) => Array.from({ length: maximum - minimum + 1 }, (_, index) => el('option', { value: minimum + index, textContent: hourLabel(minimum + index) }));

// Ping's voice saying "<name>さん、こんにちは！", so they can check how their name will sound.
async function hearName(reading, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const response = await fetch('/api/name/hear', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reading }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Couldn't play it right now.");
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    await audio.play();
  } catch (error) {
    button.textContent = error.message.length < 40 ? error.message : "Couldn't play it";
    setTimeout(() => (button.textContent = original), 2500);
    return;
  } finally {
    button.disabled = false;
  }
  button.textContent = original;
}

// A name box with its reading underneath: the reading is suggested once they stop typing, unless they've changed it.
function nameFields({ nameInput, readingInput, readingRow, hearButton }) {
  let edited = Boolean(readingInput.value);
  let timer = null;
  let asked = '';
  readingRow.hidden = !readingInput.value;
  readingInput.addEventListener('input', () => (edited = true));
  const suggest = async () => {
    const name = nameInput.value.trim();
    if (!name || edited || name === asked) return;
    asked = name;
    readingRow.hidden = false;
    readingInput.placeholder = 'Working out how to say it…';
    try {
      const { reading } = await api('/api/name/reading', { method: 'POST', body: { name } });
      if (!edited && nameInput.value.trim() === name) readingInput.value = reading ?? '';
    } catch {
      // Without a suggestion, they can still type it themselves.
    }
    readingInput.placeholder = 'In katakana, like ステラ';
  };
  nameInput.addEventListener('input', () => {
    clearTimeout(timer);
    if (!edited) readingInput.value = '';
    timer = setTimeout(suggest, READING_DELAY_MS);
  });
  nameInput.addEventListener('change', suggest);
  hearButton.addEventListener('click', () => {
    if (readingInput.value.trim()) hearName(readingInput.value.trim(), hearButton);
  });
  return { reset: () => (edited = Boolean(readingInput.value)) };
}

// The plan they're on: beta testers are on Platinum; everyone else on Free, with a way to see the upgrade page.
function planCard() {
  const { plan, calling } = state.me;
  const minutes = `Up to ${calling.perCallMinutes} minutes per call`;
  if (calling.unlimited === 'beta') {
    return [
      el('p', {}, el('strong', { textContent: 'Platinum' }), el('span', { className: 'muted', textContent: ' · free for beta testers' })),
      el('ul', {}, el('li', { textContent: minutes }), el('li', { textContent: calling.dailyCap ? `Up to ${calling.dailyCap} calls a day` : 'Call as often as you like' })),
    ];
  }
  const upgrade = el('button', { type: 'button', className: 'secondary small', textContent: 'Upgrade' });
  upgrade.addEventListener('click', () => {
    renderUpgrade();
    show('upgrade');
  });
  const name = plan === 'free' ? 'Free' : plan[0].toUpperCase() + plan.slice(1);
  return [
    el('p', {}, el('strong', { textContent: name })),
    el('ul', {}, el('li', { textContent: minutes }), el('li', { textContent: `${calling.callsPerDay} call${calling.callsPerDay === 1 ? '' : 's'} a day: Ping's call, or calling back if you miss it` })),
    upgrade,
  ];
}

let welcomeName = null;

export function renderWelcome() {
  const { settings } = state.me;
  $('name-input').value = state.me.name ?? '';
  $('reading-input').value = state.me.nameReading ?? '';
  welcomeName?.reset();
  $('reading-row').hidden = !$('reading-input').value;
  $('welcome-start').value = settings.callStartHour;
  $('welcome-end').value = settings.callEndHour;
  $('welcome-plan').replaceChildren(...planCard());
  $('welcome-error').hidden = true;
  show('welcome');
}

async function saveWelcome(event, next) {
  event.preventDefault();
  $('welcome-error').hidden = true;
  const start = Number($('welcome-start').value);
  const end = Number($('welcome-end').value);
  if (start >= end) {
    $('welcome-error').textContent = 'The last hour has to be after the first.';
    $('welcome-error').hidden = false;
    return;
  }
  try {
    state.me = await api('/api/profile', { method: 'PUT', body: { name: $('name-input').value, nameReading: $('reading-input').value.trim() || null } });
    const { settings } = await api('/api/settings', { method: 'PATCH', body: { callStartHour: start, callEndHour: end } });
    state.me.settings = settings;
    next();
  } catch (error) {
    $('welcome-error').textContent = error.message;
    $('welcome-error').hidden = false;
  }
}

// The upgrade page: what Premium and Platinum add. A placeholder until payments are set up.
function renderUpgrade() {
  const limits = state.me.planLimits;
  const card = (name, plan, extras) =>
    el(
      'div',
      { className: 'card' },
      el('strong', { textContent: name }),
      el('ul', {}, el('li', { textContent: `Up to ${limits[plan].perCall} minutes per call` }), el('li', { textContent: `${limits[plan].callsPerDay} calls a day` }), ...extras.map((extra) => el('li', { textContent: extra }))),
    );
  $('upgrade-plans').replaceChildren(
    card('Premium', 'premium', [`Keeps your latest ${limits.premium.savedItems} words and sentences`, 'Ping remembers your recent conversations']),
    card('Platinum', 'platinum', ['Keeps every word and sentence', 'Create your own contacts to talk with']),
  );
}

// "Connecting to Ping": a few seconds of moving voice waves, then Home.
function wavePath(width, height, wavelength, amplitude) {
  const middle = height / 2;
  let path = `M0 ${middle}`;
  for (let x = 0; x < width; x += wavelength) path += ` Q${x + wavelength / 4} ${middle - amplitude} ${x + wavelength / 2} ${middle} T${x + wavelength} ${middle}`;
  return path;
}

export function showConnecting(done) {
  const waves = [
    { wavelength: 200, amplitude: 46, seconds: 3.2, opacity: 0.35 },
    { wavelength: 160, amplitude: 30, seconds: 2.4, opacity: 0.3 },
    { wavelength: 260, amplitude: 60, seconds: 4.1, opacity: 0.22 },
    { wavelength: 120, amplitude: 20, seconds: 1.9, opacity: 0.4 },
  ];
  const svg = $('connecting-waves');
  svg.replaceChildren(
    ...waves.map((wave, index) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', wavePath(1600, 200, wave.wavelength, wave.amplitude));
      path.setAttribute('class', `wave wave-${index}`);
      path.style.setProperty('--shift', `-${wave.wavelength * 2}px`);
      path.style.setProperty('--seconds', `${wave.seconds}s`);
      path.style.opacity = wave.opacity;
      return path;
    }),
  );
  show('connecting');
  setTimeout(done, CONNECTING_MS);
}

export function initOnboarding({ onWelcomeDone }) {
  $('welcome-start').append(...hourOptions(0, 23));
  $('welcome-end').append(...hourOptions(1, 24));
  welcomeName = nameFields({ nameInput: $('name-input'), readingInput: $('reading-input'), readingRow: $('reading-row'), hearButton: $('hear-name') });
  $('welcome-form').addEventListener('submit', (event) => saveWelcome(event, onWelcomeDone));
  $('upgrade-back').addEventListener('click', () => show('welcome'));

  // Manage Account: the same name fields, saved with their own button.
  accountName = nameFields({ nameInput: $('account-name-input'), readingInput: $('account-reading-input'), readingRow: $('account-reading-row'), hearButton: $('account-hear-name') });
  $('account-name-save').addEventListener('click', async () => {
    $('account-name-status').hidden = true;
    try {
      state.me = await api('/api/profile', { method: 'PUT', body: { name: $('account-name-input').value, nameReading: $('account-reading-input').value.trim() || null } });
      $('account-name-status').textContent = 'Saved. Ping will use it from your next call.';
    } catch (error) {
      $('account-name-status').textContent = error.message;
    }
    $('account-name-status').hidden = false;
  });
}

let accountName = null;

// Manage Account's name fields, filled in each time it opens (called from settings.js).
export function renderAccountName() {
  $('account-name-input').value = state.me.name ?? '';
  $('account-reading-input').value = state.me.nameReading ?? '';
  $('account-reading-row').hidden = !state.me.nameReading;
  $('account-name-status').hidden = true;
  accountName?.reset();
}
