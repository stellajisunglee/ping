// The Settings tab and the pages under it.

import { $, api, clearWarning, el, go, isAdmin, onShow, savedText, setError, show, state, writeToken } from './lib.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQUENCY_BUTTONS = { daily: 'Daily', 'every-other-day': 'Every other day', weekdays: 'Weekdays only', weekends: 'Weekends only', custom: 'Custom' };
const PLAN_NAMES = { free: 'Free', premium: 'Premium', platinum: 'Platinum' };
const TURN_MODE_NAMES = { silence: 'Silence', semantic: 'Semantic', smartTurn: 'Smart Turn' };
const PLAN_EXTRAS = {
  free: 'Ping as your contact.',
  premium: 'More contacts, and calls that remember past conversations.',
  platinum: 'Everything in Premium, plus creating your own contacts.',
};

// The limits come from the server, so the page always matches what's enforced.
function callDetails(plan) {
  const { callsPerDay, perCall } = state.me.planLimits[plan];
  const calls = callsPerDay === 1
    ? `Ping calls once a day, for up to ${perCall} minutes. Miss it and you can call back.`
    : `Up to ${callsPerDay} calls a day, Ping's included, each up to ${perCall} minutes. Calling back after a missed call doesn't count.`;
  const saved = plan === 'platinum' ? 'Keeps every word and sentence.' : `Keeps your latest ${savedText(plan, 'word')} and ${savedText(plan, 'sentence')}.`;
  return `${calls} ${saved}`;
}

const INVITE_NAMES = { yc: 'YC reviewers', beta: 'Beta testers', admin: 'Admins' };
const INVITE_ORDER = ['yc', 'beta', 'admin'];

const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`;

function choiceButton(textContent, pressed, onClick) {
  const button = el('button', { type: 'button', className: 'choice', textContent });
  button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', onClick);
  return button;
}

async function changeSetting(change) {
  setError('calls-error', null);
  try {
    const { settings } = await api('/api/settings', { method: 'PATCH', body: change });
    state.me.settings = settings;
  } catch (error) {
    setError('calls-error', error.message);
  }
  renderManageCalls();
}

function renderManageCalls() {
  const { settings } = state.me;
  $('language-input').value = settings.language;
  $('speed-input').value = settings.speed;
  $('speed-output').textContent = `${Number(settings.speed).toFixed(2)}×`;
  $('proficiency-input').value = settings.proficiency;
  $('formality-input').value = settings.formality;
  $('thinking-input').value = settings.thinkingTime;
  $('calls-input').checked = settings.callsEnabled;
  $('start-hour-input').value = settings.callStartHour;
  $('end-hour-input').value = settings.callEndHour;
  $('frequency-choices').replaceChildren(
    ...Object.entries(FREQUENCY_BUTTONS).map(([frequency, label]) => choiceButton(label, settings.frequency === frequency, () => changeSetting({ frequency }))),
  );
  $('custom-days').hidden = settings.frequency !== 'custom';
  $('custom-days').replaceChildren(
    ...WEEKDAYS.map((label, day) =>
      choiceButton(label, settings.customDays.includes(day), () => {
        const customDays = settings.customDays.includes(day) ? settings.customDays.filter((other) => other !== day) : [...settings.customDays, day];
        changeSetting({ customDays });
      }),
    ),
  );
  $('custom-days-hint').hidden = settings.frequency !== 'custom' || settings.customDays.length > 0;
  $('test-ring').hidden = !isAdmin();
}

function changeHours() {
  const callStartHour = Number($('start-hour-input').value);
  const callEndHour = Number($('end-hour-input').value);
  if (callStartHour >= callEndHour) {
    setError('calls-error', 'The start time has to be before the end time.');
    return;
  }
  changeSetting({ callStartHour, callEndHour });
}

function renderSettings() {
  $('plan-button').textContent = state.me.plan === 'free' ? 'Upgrade Plan' : 'Manage Plan';
}

function renderPlan() {
  $('plan-title').textContent = state.me.plan === 'free' ? 'Upgrade Plan' : 'Manage Plan';
  $('plan-mode').textContent = isAdmin()
    ? "Test mode: real payments aren't connected, so you can switch freely and nothing is charged."
    : state.me.plan === 'free'
      ? "Upgrades aren't available during the beta, so everyone is on the Free plan for now."
      : `You're on ${PLAN_NAMES[state.me.plan]} for the beta, free of charge. Plans can't be changed yet.`;
  $('plan-cancel-note').hidden = !isAdmin();
  setError('plan-clear', clearWarning());
  $('plan-choices').replaceChildren(
    ...Object.entries(PLAN_NAMES).map(([plan, name]) => {
      const button = el('button', { type: 'button', className: 'plan-choice' }, el('strong', { textContent: name }), el('span', { className: 'muted', textContent: `${callDetails(plan)} ${PLAN_EXTRAS[plan]}` }));
      button.setAttribute('aria-pressed', String(state.me.plan === plan));
      button.disabled = !isAdmin();
      button.addEventListener('click', async () => {
        try {
          state.me = await api('/api/plan', { method: 'PUT', body: { plan } });
          renderPlan();
        } catch (error) {
          setError('plan-clear', error.message);
        }
      });
      return button;
    }),
  );
  renderTurnMode();
  renderInvites();
}

const when = (at) => (at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'before this was tracked');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Admins only: how many people joined with each invite code, and whether they've made a call.
async function renderInvites() {
  $('invites-section').hidden = !isAdmin();
  if (!isAdmin()) return;
  try {
    const { invites } = await api('/api/admin/invites');
    invites.sort((a, b) => INVITE_ORDER.indexOf(a.code) - INVITE_ORDER.indexOf(b.code));
    $('invites-list').replaceChildren(
      ...invites.map((invite) => {
        const summary = invite.accounts
          ? `${plural(invite.accounts, 'account')} · ${invite.accountsThatCalled} made a call · ${plural(invite.calls, 'call')} in all`
          : 'Nobody has joined yet.';
        const accounts = invite.newest.map((account) =>
          el('li', {
            textContent: `Joined ${when(account.joinedAt)} · ${account.calls ? `${plural(account.calls, 'call')}, last ${when(account.lastCallAt)}` : 'no calls yet'} · ${plural(account.words, 'word')}`,
          }),
        );
        return el(
          'div',
          { className: 'invite' },
          el('strong', { textContent: INVITE_NAMES[invite.code] ?? invite.code }),
          el('p', { className: 'muted', textContent: summary }),
          ...(accounts.length ? [el('ul', { className: 'muted' }, ...accounts)] : []),
        );
      }),
    );
  } catch (error) {
    $('invites-list').replaceChildren(el('p', { className: 'muted', textContent: error.message }));
  }
}

// Admins only: which turn detector their own calls use, to compare the two.
function renderTurnMode() {
  $('turn-mode-section').hidden = !isAdmin();
  if (!isAdmin()) return;
  $('turn-mode-choices').replaceChildren(
    ...Object.entries(TURN_MODE_NAMES).map(([turnMode, name]) =>
      choiceButton(name, state.me.turnMode === turnMode, async () => {
        try {
          state.me = await api('/api/turn-mode', { method: 'PUT', body: { turnMode } });
          renderTurnMode();
        } catch (error) {
          setError('plan-clear', error.message);
        }
      }),
    ),
  );
}

async function deleteAccount() {
  if (!confirm('Delete your account? Calls will stop, and your streak, stack and contacts will be removed.')) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    const registration = await navigator.serviceWorker?.ready;
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    writeToken(null);
    state.me = null;
    show('join');
  } catch (error) {
    setError('account-error', error.message);
  }
}

async function testRing() {
  setError('calls-error', null);
  try {
    await api('/api/test-ring', { method: 'POST' });
    $('test-ring-status').textContent = 'Ringing in 5 seconds. Lock your phone or close the app if you want to see the notification.';
  } catch (error) {
    setError('calls-error', error.message);
  }
}

async function sendFeedback(event) {
  event.preventDefault();
  setError('feedback-error', null);
  $('feedback-sent').hidden = true;
  try {
    await api('/api/feedback', { method: 'POST', body: { text: $('feedback-input').value } });
    event.target.reset();
    $('feedback-sent').hidden = false;
  } catch (error) {
    setError('feedback-error', error.message);
  }
}

export function initSettings() {
  onShow('settings', renderSettings);
  onShow('manage-calls', renderManageCalls);
  onShow('plan', renderPlan);
  onShow('feedback', () => {
    $('feedback-sent').hidden = true;
  });

  const hours = (minimum, maximum) => Array.from({ length: maximum - minimum + 1 }, (_, index) => el('option', { value: minimum + index, textContent: hourLabel(minimum + index) }));
  $('start-hour-input').append(...hours(0, 23));
  $('end-hour-input').append(...hours(1, 24));

  $('speed-input').addEventListener('input', (event) => {
    $('speed-output').textContent = `${Number(event.target.value).toFixed(2)}×`;
  });
  $('speed-input').addEventListener('change', (event) => changeSetting({ speed: Number(event.target.value) }));
  $('language-input').addEventListener('change', (event) => changeSetting({ language: event.target.value }));
  $('proficiency-input').addEventListener('change', (event) => changeSetting({ proficiency: event.target.value }));
  $('formality-input').addEventListener('change', (event) => changeSetting({ formality: event.target.value }));
  $('thinking-input').addEventListener('change', (event) => changeSetting({ thinkingTime: event.target.value }));
  $('calls-input').addEventListener('change', (event) => changeSetting({ callsEnabled: event.target.checked }));
  $('start-hour-input').addEventListener('change', changeHours);
  $('end-hour-input').addEventListener('change', changeHours);
  $('test-ring-button').addEventListener('click', testRing);
  $('delete-button').addEventListener('click', deleteAccount);
  $('feedback-form').addEventListener('submit', sendFeedback);
  $('plan-button').addEventListener('click', () => go('plan'));
}
