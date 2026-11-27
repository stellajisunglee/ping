// What learners tell Ping about themselves (server/check-ins.js): why they're learning and a first check-in, once,
// before Home ("A bit about you"), and then the same check-in once a week as a card on Home. Two taps each time:
// how comfortable they feel speaking Japanese with someone (1-5), and how much they spoke Japanese outside Ping
// in the past week. These are how Ping measures confidence and practice in real life, not only on calls.

import { $, api, el, show, state } from './lib.js';

const GOALS = [
  ['school', 'School or exams'],
  ['work', 'Work'],
  ['travel', 'Travel'],
  ['partner', 'A partner'],
  ['family', 'Family'],
  ['culture', 'Anime, games or media'],
  ['other', 'Something else'],
];
const OUTSIDE = [
  [0, 'Not at all'],
  [1, 'A little'],
  [2, 'A lot'],
];

// A row of buttons where one can be picked; onPick gets the value.
function choiceRow(container, options, { className, onPick }) {
  container.replaceChildren(
    ...options.map(([value, label]) => {
      const button = el('button', { type: 'button', className, textContent: label });
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        for (const other of container.children) other.setAttribute('aria-pressed', String(other === button));
        onPick(value);
      });
      return button;
    }),
  );
}

// The two check-in questions, in a form whose ids start with prefix. Returns the answers as they're picked.
function checkInQuestions(prefix, onChange) {
  const answers = { comfort: null, outside: null };
  choiceRow($(`${prefix}-comfort`), [1, 2, 3, 4, 5].map((value) => [value, String(value)]), {
    className: 'rating-choice',
    onPick: (value) => {
      answers.comfort = value;
      onChange();
    },
  });
  choiceRow($(`${prefix}-outside`), OUTSIDE, {
    className: 'choice',
    onPick: (value) => {
      answers.outside = value;
      onChange();
    },
  });
  return answers;
}

// "A bit about you": before Home, once. done() carries on to Home.
export function showBaseline(done) {
  const answers = { goal: state.me.goal ?? null };
  const ready = () => ($('about-done').disabled = !(answers.goal && checkIn.comfort && checkIn.outside !== null));
  choiceRow($('about-goal'), GOALS, {
    className: 'choice',
    onPick: (value) => {
      answers.goal = value;
      ready();
    },
  });
  if (answers.goal) $('about-goal').querySelector(`:nth-child(${GOALS.findIndex(([value]) => value === answers.goal) + 1})`)?.setAttribute('aria-pressed', 'true');
  const checkIn = checkInQuestions('about', ready);
  $('about-error').hidden = true;
  ready();
  $('about-done').onclick = async () => {
    $('about-error').hidden = true;
    try {
      state.me = await api('/api/baseline', { method: 'PUT', body: { goal: answers.goal, ...checkIn } });
      done();
    } catch (error) {
      $('about-error').textContent = error.message;
      $('about-error').hidden = false;
    }
  };
  show('about');
}

// The weekly check-in card on Home, when one is due.
export function renderCheckInCard() {
  const card = $('check-in');
  card.hidden = !state.me.checkInDue;
  if (card.hidden) return;
  const answers = checkInQuestions('check-in', () => ($('check-in-save').disabled = !(answers.comfort && answers.outside !== null)));
  $('check-in-save').disabled = true;
  const close = () => {
    state.me.checkInDue = false;
    card.hidden = true;
  };
  $('check-in-save').onclick = () => {
    close();
    api('/api/check-ins', { method: 'POST', body: answers }).catch((error) => console.warn('Could not save the check-in', error));
  };
  $('check-in-later').onclick = () => {
    close();
    api('/api/check-ins/snooze', { method: 'POST' }).catch((error) => console.warn('Could not snooze the check-in', error));
  };
}
