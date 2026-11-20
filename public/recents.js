// The Calls tab: the latest voicemail as a small card at the top, then recent calls to and from contacts, laid out
// like a phone's recent calls. Tapping a call calls that contact back; the ⓘ opens what happened on it.

import { $, api, el, go, initialOf, onShow, state } from './lib.js';

let callContact = () => {};
let detailCallId = null;

const DAY_MS = 86_400_000;

// Today's calls show the time, yesterday's say Yesterday, this week's the weekday, older ones the date.
export function whenText(at, now = Date.now()) {
  const date = new Date(at);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at >= startOfToday.getTime() - DAY_MS) return 'Yesterday';
  if (at >= startOfToday.getTime() - 6 * DAY_MS) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

const lengthText = (seconds) => (seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`);

// What the second line of a call says, and whether it's a missed call (shown in red, like a phone does).
export function callKind(entry) {
  if (entry.direction === 'outgoing') return { text: entry.outcome === 'connected' ? `Outgoing${entry.seconds ? ` · ${lengthText(entry.seconds)}` : ''}` : 'Not connected', missed: false };
  if (entry.outcome === 'missed') return { text: 'Missed call', missed: true };
  if (entry.outcome === 'declined') return { text: 'Declined', missed: true };
  return { text: `Incoming${entry.seconds ? ` · ${lengthText(entry.seconds)}` : ''}`, missed: false };
}

const OUTGOING_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="M8 16 16 8M9 8h7v7" /></svg>';
const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="stroke" cx="12" cy="12" r="9" /><path class="stroke" d="M12 11v6M12 7.5v.5" /></svg>';

function svg(markup) {
  const holder = el('span', { className: 'icon' });
  holder.innerHTML = markup; // fixed markup from this file, never user text
  return holder;
}

function recentRow(entry) {
  const kind = callKind(entry);
  const when = new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const main = el(
    'button',
    { type: 'button', className: 'recent-main', ariaLabel: `${entry.contactName}, ${kind.text}, ${when}. Call back` },
    el('span', { className: 'recent-direction' }, entry.direction === 'outgoing' ? svg(OUTGOING_ICON) : ''),
    el('span', { className: 'recent-text' }, el('span', { className: kind.missed ? 'recent-name missed' : 'recent-name', textContent: entry.contactName }), el('span', { className: 'recent-kind', textContent: kind.text })),
    el('span', { className: 'recent-when', textContent: whenText(entry.at) }),
  );
  main.addEventListener('click', () => callContact(entry.contactId));
  const info = el('button', { type: 'button', className: 'recent-info', ariaLabel: `Details of the call with ${entry.contactName}, ${when}` }, svg(INFO_ICON));
  info.addEventListener('click', () => {
    detailCallId = entry.callId;
    go('call-detail');
  });
  return el('li', { className: 'recent' }, main, info);
}

// The latest voicemail, condensed: who and when, play, and call back. Tapping it shows what was said.
function renderVoicemail() {
  const { voicemail } = state.me;
  $('voicemail-section').hidden = !voicemail;
  if (!voicemail) return;
  const when = whenText(voicemail.at);
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = voicemail.audioUrl;
  const play = el('button', { type: 'button', className: 'secondary small', textContent: 'Play' });
  const markHeard = () => {
    if (voicemail.heard) return;
    voicemail.heard = true;
    card.classList.remove('unheard');
    renderBadge();
    api(`/api/messages/${voicemail.id}/heard`, { method: 'POST' }).catch(() => {});
  };
  play.addEventListener('click', () => {
    if (!audio.paused) return audio.pause();
    audio.playbackRate = state.me.settings.speed;
    audio.play().catch(() => (play.hidden = true));
    markHeard();
  });
  audio.addEventListener('play', () => (play.textContent = 'Pause'));
  audio.addEventListener('pause', () => (play.textContent = 'Play'));
  audio.addEventListener('ended', () => (play.textContent = 'Play'));
  // Without a recording the words still deliver the message.
  audio.addEventListener('error', () => (play.hidden = true));
  const callBack = el('button', { type: 'button', className: 'primary small', textContent: 'Call back', disabled: !state.me.calling.canCall });
  callBack.addEventListener('click', () => callContact(voicemail.contactId));
  const words = el('details', { className: 'voicemail-words' }, el('summary', { textContent: 'What they said' }), el('p', { lang: 'ja', textContent: voicemail.japanese }), el('p', { className: 'muted', textContent: voicemail.english }));
  words.addEventListener('toggle', () => words.open && markHeard());
  const card = el(
    'div',
    { className: voicemail.heard ? 'card voicemail-card' : 'card voicemail-card unheard' },
    el('div', { className: 'voicemail-head' }, el('div', { className: 'avatar small', ariaHidden: 'true', textContent: initialOf(voicemail.contactName) }), el('div', {}, el('strong', { textContent: `Voicemail from ${voicemail.contactName}` }), el('p', { className: 'muted', textContent: when }))),
    el('div', { className: 'button-row' }, play, callBack),
    words,
  );
  $('voicemail').replaceChildren(card);
}

// A dot on the Calls tab while there's a voicemail they haven't heard.
export function renderBadge() {
  const unheard = Boolean(state.me?.voicemail && !state.me.voicemail.heard);
  $('calls-badge').hidden = !unheard;
  $('calls-badge').textContent = unheard ? '1' : '';
}

function renderCalls() {
  renderVoicemail();
  const calls = state.me.recentCalls ?? [];
  $('recent-calls').replaceChildren(...(calls.length ? calls.map(recentRow) : [el('li', { className: 'muted empty', textContent: 'No calls yet. Calls to and from Ping show up here.' })]));
}

async function renderCallDetail() {
  const holder = $('call-detail');
  holder.replaceChildren(el('p', { className: 'muted', textContent: 'Loading…' }));
  try {
    const { call, japaneseMinutes, japaneseChars, newWords, lines } = await api(`/api/calls/${detailCallId}/details`);
    const kind = callKind(call);
    const date = new Date(call.at);
    const facts = [
      ['When', date.toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })],
      ['Call', kind.text],
      ...(japaneseMinutes !== null ? [['Japanese you spoke', `${japaneseMinutes} min`]] : []),
      ...(japaneseChars !== null ? [['Japanese characters', String(japaneseChars)]] : []),
      ...(newWords !== null ? [['Words saved', String(newWords)]] : []),
    ];
    const callAgain = el('button', { type: 'button', className: 'primary wide', textContent: `Call ${call.contactName}`, disabled: !state.me.calling.canCall });
    callAgain.addEventListener('click', () => callContact(call.contactId));
    holder.replaceChildren(
      el('div', { className: 'detail-head' }, el('div', { className: 'avatar', ariaHidden: 'true', textContent: initialOf(call.contactName) }), el('h1', { textContent: call.contactName })),
      el('dl', { className: 'detail-facts' }, ...facts.flatMap(([term, value]) => [el('dt', { textContent: term }), el('dd', { textContent: value })])),
      callAgain,
      ...(lines.length
        ? [el('h2', { textContent: 'Transcript' }), el('ol', { className: 'detail-transcript' }, ...lines.map((line) => el('li', { className: line.from, lang: 'ja', textContent: `${line.from === 'you' ? 'You' : call.contactName}: ${line.text}` })))]
        : []),
    );
  } catch (error) {
    holder.replaceChildren(el('p', { className: 'error', textContent: error.message }));
  }
}

export function initRecents({ onCall }) {
  callContact = onCall;
  onShow('calls', renderCalls);
  onShow('call-detail', renderCallDetail);
}
