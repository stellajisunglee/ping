// The Settings tab and the pages under it.

import { $, api, clearWarning, el, go, isAdmin, onShow, setError, show, state, writeToken } from './lib.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQUENCY_BUTTONS = { daily: 'Daily', 'every-other-day': 'Every other day', weekdays: 'Weekdays only', weekends: 'Weekends only', custom: 'Custom' };
const PLAN_NAMES = { free: 'Free', premium: 'Premium', platinum: 'Platinum' };
const PLAN_DETAILS = {
  free: 'Ping as your contact, and your latest 25 words.',
  premium: 'A lifetime word bank, removing words, example sentences, and calls that remember past conversations.',
  platinum: 'Everything in Premium, plus creating your own contacts.',
};

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
  $('plan-mode').textContent = isAdmin() ? "Test mode: real payments aren't connected, so you can switch freely and nothing is charged." : "Upgrades aren't available during the beta, so everyone is on the Free plan for now.";
  $('plan-cancel-note').hidden = !isAdmin();
  setError('plan-clear', clearWarning());
  $('plan-choices').replaceChildren(
    ...Object.entries(PLAN_NAMES).map(([plan, name]) => {
      const button = el('button', { type: 'button', className: 'plan-choice' }, el('strong', { textContent: name }), el('span', { className: 'muted', textContent: PLAN_DETAILS[plan] }));
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
