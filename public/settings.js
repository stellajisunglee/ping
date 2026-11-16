// The Settings tab and the pages under it.

import { $, api, clearWarning, el, fetchBlob, go, isAdmin, onShow, savedText, setError, show, state, writeToken } from './lib.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQUENCY_BUTTONS = { daily: 'Daily', 'every-other-day': 'Every other day', weekdays: 'Weekdays only', weekends: 'Weekends only', custom: 'Custom' };
const PLAN_NAMES = { free: 'Free', premium: 'Premium', platinum: 'Platinum' };
const TURN_MODE_NAMES = { silence: 'Silence', semantic: 'Semantic', smartTurn: 'Smart Turn' };
const RECORD_KEY = 'ping-record-calls';

// The last recorded call, kept in memory until the next recorded call or until the app closes.
// waiting: a recorded call is in progress or finishing. problem: why nothing was recorded.
let lastRecording = { recording: null, waiting: false, problem: null };

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
const ACCOUNT_KINDS = { yc: 'YC reviewer', beta: 'Beta tester', admin: 'Admin' };
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
  renderAdminTools();
}

// Recording is a setting of this phone, not the account, since the file never leaves the phone.
function recordSwitch() {
  try {
    return localStorage.getItem(RECORD_KEY) === 'on';
  } catch {
    return false;
  }
}

function setRecordSwitch(on) {
  try {
    if (on) localStorage.setItem(RECORD_KEY, 'on');
    else localStorage.removeItem(RECORD_KEY);
  } catch {
    setError('admin-tools-error', "This browser won't keep the setting. Check that it isn't in private browsing.");
  }
}

export const recordCallsOn = () => isAdmin() && recordSwitch();

export function keepRecording({ recording = null, waiting = false, problem = null }) {
  lastRecording = { recording, waiting, problem };
  if (!$('screen-settings').hidden) renderAdminTools();
}

function recordingStatus(text) {
  $('recording-status').textContent = text ?? '';
  $('recording-status').hidden = !text;
}

function renderAdminTools() {
  $('admin-tools').hidden = !isAdmin();
  if (!isAdmin()) return;
  $('record-input').checked = recordSwitch();
  const { recording, waiting, problem } = lastRecording;
  $('save-recording-button').hidden = !recording;
  if (recording) recordingStatus(`${recording.fileName}, ${(recording.blob.size / 1_000_000).toFixed(1)} MB`);
  else if (waiting) recordingStatus('Recording the call. It will be ready here once the call ends.');
  else if (problem) recordingStatus(`The last call wasn't recorded: ${problem}`);
  else recordingStatus(null);
}

// The share sheet lets the phone save the file to Files. Browsers without it download the file instead.
async function saveRecording() {
  const { recording } = lastRecording;
  if (!recording) return;
  setError('admin-tools-error', null);
  const file = new File([recording.blob], recording.fileName, { type: recording.blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error.name !== 'AbortError') setError('admin-tools-error', `Couldn't save the recording: ${error.message}`);
    }
    return;
  }
  const url = URL.createObjectURL(file);
  el('a', { href: url, download: recording.fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
const comboName = ({ engine, turnMode }) => [state.me.callSetup?.engines[engine]?.name ?? engine, TURN_MODE_NAMES[turnMode]].filter(Boolean).join(' + ');

async function changeCallSetup(change) {
  try {
    state.me = await api('/api/call-setup', { method: 'PUT', body: change });
  } catch (error) {
    setError('plan-clear', error.message);
  }
  renderTurnMode();
}

// Admins only: every caller is randomized across the mix, unless an admin picks for their own calls.
function renderTurnMode() {
  $('turn-mode-section').hidden = !isAdmin();
  if (!isAdmin() || !state.me.callSetup) return;
  const { manual, engine, turnMode, engines, randomMix } = state.me.callSetup;
  $('call-setup-random').textContent = `Every caller's calls are randomized, balanced per person, across: ${randomMix.map(comboName).join(', ')}.`;
  $('call-setup-manual').checked = manual;
  $('call-setup-choices').hidden = !manual;
  $('engine-choices').replaceChildren(...Object.entries(engines).map(([id, spec]) => choiceButton(spec.name, engine === id, () => changeCallSetup({ engine: id }))));
  const modes = engines[engine]?.turnModes ?? [];
  $('turn-mode-group').hidden = !modes.length;
  $('turn-mode-choices').replaceChildren(...modes.map((mode) => choiceButton(TURN_MODE_NAMES[mode] ?? mode, turnMode === mode, () => changeCallSetup({ turnMode: mode }))));
}

const durationText = (seconds) => (seconds == null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
const secondsText = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`);

// What the admin call log says about a call's turn-taking. What the engine doesn't let the phone measure says
// n/a; what wasn't measured or reported (an older entry, or a call with no replies) says -.
// Deepgram's latency is its own report, from where it judged the user stopped, so it's never shown as the gap.
export function turnFacts(entry) {
  const deepgram = entry.engine === 'deepgram-agent';
  const talkOvers = entry.talkOvers == null ? '-' : `${entry.talkOvers} (${deepgram ? 'aizuchi: n/a' : `${entry.ignoredAizuchi ?? '-'} aizuchi`})`;
  const providerLatency = entry.providerLatencyMedianMs == null ? '-' : `${secondsText(entry.providerLatencyMedianMs)}, P90 ${secondsText(entry.providerLatencyP90Ms)}`;
  return [
    ['Gap before reply', deepgram ? 'n/a' : secondsText(entry.replyGapMedianMs)],
    ...(deepgram ? [['Deepgram-reported latency', providerLatency]] : []),
    ['Talked over Ping', talkOvers],
    ['Suspected cut-offs', entry.suspectedCutoffs ?? '-'],
  ];
}

// One call in the admin call log. The turn mode is blank for engines that decide turns themselves.
function callLogRow(entry) {
  const when = new Date(entry.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const who = `${ACCOUNT_KINDS[entry.joinedWith] ?? entry.joinedWith ?? ''} ${entry.userId.slice(0, 6)}`;
  const mode = TURN_MODE_NAMES[entry.turnMode] ?? '';
  const fellBack = entry.actualTurnMode && entry.actualTurnMode !== entry.turnMode ? ` → ${TURN_MODE_NAMES[entry.actualTurnMode] ?? entry.actualTurnMode}` : '';
  const facts = [
    ['Engine', state.me.callSetup?.engines[entry.engine]?.name ?? entry.engine],
    ['Turn detection', `${mode}${fellBack}`],
    ['Assigned', entry.assigned ?? ''],
    ['Length', durationText(entry.seconds)],
    ...turnFacts(entry),
    ['Rating', entry.cutOffs ? `cut-offs ${entry.cutOffs}/5, natural ${entry.naturalness}/5` : '-'],
  ];
  return el(
    'li',
    { className: 'call-log-entry' },
    el('p', {}, el('strong', { textContent: when }), el('span', { className: 'muted', textContent: ` ${who}${entry.recorded ? ' · recorded' : ''}` })),
    el('dl', {}, ...facts.flatMap(([term, value]) => [el('dt', { textContent: term }), el('dd', { textContent: String(value) })])),
  );
}

async function renderCallLog() {
  setError('call-log-error', null);
  const list = $('call-log-list');
  list.replaceChildren(el('li', { className: 'muted', textContent: 'Loading…' }));
  try {
    const { calls } = await api('/api/admin/calls');
    list.replaceChildren(...(calls.length ? calls.map(callLogRow) : [el('li', { className: 'muted', textContent: 'No calls yet.' })]));
  } catch (error) {
    list.replaceChildren();
    setError('call-log-error', error.message);
  }
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
  setError('admin-tools-error', null);
  try {
    await api('/api/test-ring', { method: 'POST' });
    $('test-ring-status').textContent = 'Ringing in 10 seconds. Start your screen recording now, or lock your phone to see the notification.';
    $('test-ring-status').hidden = false;
  } catch (error) {
    setError('admin-tools-error', error.message);
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

// Manage Account's recording switch. Admin and beta tester accounts can't turn it off.
function renderAccount() {
  const { on, canTurnOff } = state.me.recording;
  $('recording-input').checked = on;
  $('recording-input').disabled = !canTurnOff;
  $('recording-hint').textContent = canTurnOff
    ? 'Calls are recorded and transcribed so the Ping team can review them and improve Ping. Turning this off stops recording future calls.'
    : 'Calls are recorded and transcribed so the Ping team can review them. Recording is part of testing, so it stays on for this account.';
}

async function changeRecording(on) {
  setError('account-error', null);
  try {
    const { recording } = await api('/api/recording', { method: 'PUT', body: { on } });
    state.me.recording = recording;
  } catch (error) {
    setError('account-error', error.message);
  }
  renderAccount();
}

const callLength = (seconds) => (seconds == null ? '' : ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

// One recorded call. Its audio and transcript load when it's opened, so the list stays quick.
function recordingRow(call) {
  const when = new Date(call.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const who = `${ACCOUNT_KINDS[call.joinedWith] ?? call.joinedWith} ${call.userId.slice(0, 6)}`;
  const details = el(
    'details',
    { className: 'recording' },
    el(
      'summary',
      {},
      el('strong', { textContent: `${when}${callLength(call.seconds)}` }),
      el('span', { className: 'muted', textContent: ` ${who} · ${call.contactName} · ${[call.engine ?? 'gpt-realtime', TURN_MODE_NAMES[call.turnMode]].filter(Boolean).join(' + ')}` }),
      call.rating ? el('span', { className: 'recording-rating', textContent: ` · cut-offs ${call.rating.cutOffs}/5, natural ${call.rating.naturalness}/5` }) : '',
    ),
  );
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const body = el('div', { className: 'recording-body' });
    details.append(body);
    try {
      if (call.audio) {
        const audio = await fetchBlob(`/api/admin/recordings/${call.callId}/audio`);
        body.append(el('audio', { controls: true, preload: 'metadata', src: URL.createObjectURL(audio) }));
      } else {
        body.append(el('p', { className: 'muted', textContent: 'No audio was uploaded for this call.' }));
      }
      const { lines } = await api(`/api/admin/recordings/${call.callId}`);
      body.append(
        lines.length
          ? el('ol', { className: 'recording-lines' }, ...lines.map((line) => el('li', { className: line.from, textContent: `${line.from === 'you' ? 'User' : call.contactName}: ${line.text}` })))
          : el('p', { className: 'muted', textContent: 'No transcript was saved for this call.' }),
      );
    } catch (error) {
      body.append(el('p', { className: 'error', textContent: error.message }));
    }
  });
  return el('li', {}, details);
}

async function renderRecordings() {
  setError('recordings-error', null);
  const list = $('recordings-list');
  list.replaceChildren(el('li', { className: 'muted', textContent: 'Loading…' }));
  try {
    const { recordings } = await api('/api/admin/recordings');
    list.replaceChildren(...(recordings.length ? recordings.map(recordingRow) : [el('li', { className: 'muted', textContent: 'No recorded calls yet.' })]));
  } catch (error) {
    list.replaceChildren();
    setError('recordings-error', error.message);
  }
}

export function initSettings() {
  onShow('settings', renderSettings);
  onShow('account', renderAccount);
  onShow('recordings', renderRecordings);
  onShow('call-log', renderCallLog);
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
  $('record-input').addEventListener('change', (event) => setRecordSwitch(event.target.checked));
  $('save-recording-button').addEventListener('click', saveRecording);
  $('delete-button').addEventListener('click', deleteAccount);
  $('recording-input').addEventListener('change', (event) => changeRecording(event.target.checked));
  $('call-setup-manual').addEventListener('change', (event) => changeCallSetup({ manual: event.target.checked }));
  $('feedback-form').addEventListener('submit', sendFeedback);
  $('plan-button').addEventListener('click', () => go('plan'));
}
