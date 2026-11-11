// My Stack: the words the user didn't understand, and the example sentences they saved.

import { $, api, el, go, onShow, planLabel, refresh, savedText, setError, state } from './lib.js';

const SWIPE_REMOVE_SHARE = 0.35; // how far across the row a swipe has to travel
const SWIPE_NOT_TAP_PX = 10; // a row dragged further than this was swiped, not tapped

let currentWordId = null;
let currentSentenceId = null;

// The Words and Sentences buttons on Home, with how many of each the user has.
export function renderStackTiles() {
  const { words, sentences } = state.me;
  const limit = state.me.planLimits[state.me.plan].savedItems;
  const count = (list) => (limit === null ? `${list.length}` : `${list.length} of ${limit}`);
  // Empty, each one says how to fill it.
  $('stack-words-count').textContent = words.length ? count(words) : 'Ask Ping what a word means on a call, and it saves here.';
  $('stack-sentences-count').textContent = sentences.length ? count(sentences) : 'Open a word to find example sentences to save.';
}

// On plans with a limit, says what's kept and what upgrading adds.
function stackLimitNote(noun) {
  const { plan } = state.me;
  if (plan === 'platinum') return null;
  const next = plan === 'free' ? 'premium' : 'platinum';
  return `Your ${planLabel()} plan keeps your latest ${savedText(plan, noun)}. Saving more removes the oldest. ${planLabel(next)} keeps ${savedText(next, noun)}.`;
}

function showLimitNote(id, noun) {
  const note = stackLimitNote(noun);
  $(id).hidden = !note;
  $(id).querySelector('p').textContent = note ?? '';
}

function renderWords() {
  const list = $('words-list');
  const { words } = state.me;
  $('words-empty').hidden = words.length > 0;
  list.replaceChildren(
    ...words.map((word) => {
      const button = el('button', { type: 'button', className: 'row-button', lang: 'ja', textContent: word.kanji || word.kana });
      button.addEventListener('click', () => {
        currentWordId = word.id;
        go('word');
      });
      return el('li', {}, button);
    }),
  );
}

function renderWord() {
  const word = state.me.words.find((candidate) => candidate.id === currentWordId);
  if (!word) return renderWords();
  $('word-kanji').textContent = word.kanji;
  $('word-kanji').hidden = !word.kanji;
  $('word-kana').textContent = word.kana;
  $('word-romaji').textContent = word.romaji;
  $('word-english').textContent = word.english;
  $('word-examples').replaceChildren();
  setError('word-error', null);
  // Hidden once its sentences are showing, so it has to come back for the next word.
  $('word-examples-button').hidden = false;
  $('word-examples-button').disabled = false;
  $('word-examples-button').textContent = 'Show example sentences';
  showLimitNote('word-upgrade', 'word');
}

async function showExamples() {
  const button = $('word-examples-button');
  const word = state.me.words.find((candidate) => candidate.id === currentWordId);
  button.disabled = true;
  button.textContent = 'Looking up...';
  setError('word-error', null);
  try {
    const { sentences } = await api(`/api/stack/words/${currentWordId}/examples`, { method: 'POST' });
    $('word-examples').replaceChildren(...sentences.map((sentence) => exampleRow(sentence, word)));
    button.hidden = true;
  } catch (error) {
    setError('word-error', error.message);
    button.disabled = false;
    button.textContent = 'Show example sentences';
  }
}

// Japanese, romaji, then English, the same order as a word. Sentences saved before romaji was added have none.
function sentenceLines(sentence) {
  return [
    el('p', { lang: 'ja', textContent: sentence.japanese }),
    ...(sentence.romaji ? [el('p', { className: 'muted', textContent: sentence.romaji })] : []),
    el('p', { className: 'muted', textContent: sentence.english }),
  ];
}

function exampleRow(sentence, word) {
  const save = el('button', { type: 'button', className: 'secondary small', textContent: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      state.me = await api('/api/stack/sentences', { method: 'POST', body: { ...sentence, word: word.kanji || word.kana } });
      save.textContent = 'Saved';
    } catch (error) {
      save.disabled = false;
      setError('word-error', error.message);
    }
  });
  return el('li', { className: 'card' }, ...sentenceLines(sentence), save);
}

async function removeWord() {
  try {
    state.me = await api(`/api/stack/words/${currentWordId}`, { method: 'DELETE' });
    go('words');
  } catch (error) {
    setError('word-error', error.message);
  }
}

// Returns whether the row's last touch was a swipe, so a swipe that's let go isn't taken as a tap.
function swipeToRemove(row, front, remove) {
  let startX = null;
  let moved = 0;
  let swiped = false;
  const reset = () => {
    startX = null;
    moved = 0;
    front.style.transform = '';
  };
  row.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
    moved = 0;
    swiped = false;
  });
  row.addEventListener('pointermove', (event) => {
    if (startX === null) return;
    moved = Math.min(0, event.clientX - startX);
    if (-moved > SWIPE_NOT_TAP_PX) swiped = true;
    front.style.transform = `translateX(${moved}px)`;
  });
  row.addEventListener('pointerup', () => {
    if (startX !== null && -moved > row.offsetWidth * SWIPE_REMOVE_SHARE) remove();
    else reset();
  });
  row.addEventListener('pointercancel', reset);
  return () => swiped;
}

function renderSentences() {
  const list = $('sentences-list');
  const { sentences } = state.me;
  showLimitNote('sentences-upgrade', 'sentence');
  $('sentences-hint').hidden = sentences.length === 0;
  $('sentences-empty').hidden = sentences.length > 0;
  list.replaceChildren(
    ...sentences.map((sentence) => {
      const remove = async () => {
        state.me.sentences = state.me.sentences.filter((other) => other.id !== sentence.id);
        renderSentences();
        await api(`/api/stack/sentences/${sentence.id}`, { method: 'DELETE' }).catch((error) => setError('sentences-error', error.message));
      };
      const removeButton = el('button', { type: 'button', className: 'icon-remove', textContent: '×', ariaLabel: `Remove ${sentence.japanese}` });
      removeButton.addEventListener('click', remove);
      const open = el('button', { type: 'button', className: 'sentence-open', ariaLabel: `Study the kanji in ${sentence.japanese}` }, ...sentenceLines(sentence));
      const front = el('div', { className: 'swipe-front' }, open, removeButton);
      const row = el('li', { className: 'swipe-row' }, el('div', { className: 'swipe-behind', textContent: 'Remove' }), front);
      const wasSwiped = swipeToRemove(row, front, remove);
      open.addEventListener('click', () => {
        if (wasSwiped()) return;
        currentSentenceId = sentence.id;
        go('sentence');
      });
      return row;
    }),
  );
}

// ---------- One sentence: its words with kanji, each of which can be added to Words ----------

const inWords = (word) => state.me.words.some((other) => other.kanji === word.kanji && other.kana === word.kana);

function sentenceWordRow(word) {
  const add = el('button', { type: 'button', className: 'secondary small' });
  const showSaved = () => {
    add.textContent = inWords(word) ? 'In your Words' : 'Add to Words';
    add.disabled = inWords(word);
  };
  showSaved();
  add.addEventListener('click', async () => {
    add.disabled = true;
    setError('sentence-error', null);
    try {
      await api('/api/stack/words', { method: 'POST', body: { kanji: word.kanji, kana: word.kana, romaji: word.romaji, english: word.english } });
      await refresh(); // the stack may have dropped its oldest word to make room
      showSaved();
    } catch (error) {
      setError('sentence-error', error.message);
      showSaved();
    }
  });
  // Shown as written in the sentence, with the dictionary form underneath when it's different.
  const lines = [el('p', { className: 'sentence-word-kanji', lang: 'ja', textContent: word.asWritten })];
  if (word.asWritten !== word.kanji) lines.push(el('p', { className: 'muted', lang: 'ja', textContent: `Dictionary form: ${word.kanji}` }));
  lines.push(el('p', { lang: 'ja', textContent: word.kana }), el('p', { className: 'muted', textContent: word.romaji }), el('p', { textContent: word.english }));
  return el('li', { className: 'card' }, ...lines, add);
}

function showSentenceWords(words) {
  $('sentence-words').replaceChildren(...words.map(sentenceWordRow));
  $('sentence-words-status').textContent = words.length ? '' : 'There are no kanji in this sentence.';
  $('sentence-words-status').hidden = words.length > 0;
}

async function renderSentence() {
  const sentence = state.me.sentences.find((candidate) => candidate.id === currentSentenceId);
  if (!sentence) return go('sentences');
  $('sentence-card').replaceChildren(...sentenceLines(sentence));
  setError('sentence-error', null);
  showLimitNote('sentence-upgrade', 'word');
  $('sentence-words').replaceChildren();
  if (sentence.kanjiWords) return showSentenceWords(sentence.kanjiWords);
  $('sentence-words-status').hidden = false;
  $('sentence-words-status').textContent = 'Finding the kanji...';
  try {
    const { words } = await api(`/api/stack/sentences/${sentence.id}/words`, { method: 'POST' });
    sentence.kanjiWords = words;
    if (currentSentenceId === sentence.id) showSentenceWords(words);
  } catch (error) {
    $('sentence-words-status').hidden = true;
    setError('sentence-error', error.message);
  }
}

export function initStack() {
  onShow('words', renderWords);
  onShow('word', renderWord);
  onShow('sentences', renderSentences);
  onShow('sentence', renderSentence);
  $('word-examples-button').addEventListener('click', showExamples);
  $('word-remove-button').addEventListener('click', removeWord);
}
