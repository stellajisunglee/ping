// My Stack: the words the user didn't understand, and the example sentences they saved.

import { $, api, clearWarning, el, go, isPaid, onShow, setError, state } from './lib.js';

const SWIPE_REMOVE_SHARE = 0.35; // how far across the row a swipe has to travel

let currentWordId = null;

function renderStack() {
  const { words, sentences, freeWordLimit } = state.me;
  $('stack-words-count').textContent = isPaid() ? `${words.length}` : `${words.length} of ${freeWordLimit}`;
  $('stack-sentences-count').textContent = isPaid() || sentences.length ? `${sentences.length}` : 'Subscribers';
  setError('stack-clear', clearWarning());
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
  $('word-examples-button').hidden = !isPaid();
  $('word-examples-button').disabled = false;
  $('word-examples-button').textContent = 'Show example sentences';
  $('word-remove-button').hidden = !isPaid();
  $('word-upgrade').hidden = isPaid();
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
  return el('li', { className: 'card' }, el('p', { lang: 'ja', textContent: sentence.japanese }), el('p', { className: 'muted', textContent: sentence.english }), save);
}

async function removeWord() {
  try {
    state.me = await api(`/api/stack/words/${currentWordId}`, { method: 'DELETE' });
    go('words');
  } catch (error) {
    setError('word-error', error.message);
  }
}

function swipeToRemove(row, front, remove) {
  let startX = null;
  let moved = 0;
  const reset = () => {
    startX = null;
    moved = 0;
    front.style.transform = '';
  };
  row.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
    moved = 0;
  });
  row.addEventListener('pointermove', (event) => {
    if (startX === null) return;
    moved = Math.min(0, event.clientX - startX);
    front.style.transform = `translateX(${moved}px)`;
  });
  row.addEventListener('pointerup', () => {
    if (startX !== null && -moved > row.offsetWidth * SWIPE_REMOVE_SHARE) remove();
    else reset();
  });
  row.addEventListener('pointercancel', reset);
}

function renderSentences() {
  const list = $('sentences-list');
  const { sentences } = state.me;
  $('sentences-upgrade').hidden = isPaid();
  $('sentences-hint').hidden = sentences.length === 0;
  $('sentences-empty').hidden = sentences.length > 0 || !isPaid();
  list.replaceChildren(
    ...sentences.map((sentence) => {
      const remove = async () => {
        state.me.sentences = state.me.sentences.filter((other) => other.id !== sentence.id);
        renderSentences();
        await api(`/api/stack/sentences/${sentence.id}`, { method: 'DELETE' }).catch((error) => setError('sentences-error', error.message));
      };
      const removeButton = el('button', { type: 'button', className: 'icon-remove', textContent: '×', ariaLabel: `Remove ${sentence.japanese}` });
      removeButton.addEventListener('click', remove);
      const front = el(
        'div',
        { className: 'swipe-front' },
        el('div', {}, el('p', { lang: 'ja', textContent: sentence.japanese }), el('p', { className: 'muted', textContent: sentence.english })),
        removeButton,
      );
      const row = el('li', { className: 'swipe-row' }, el('div', { className: 'swipe-behind', textContent: 'Remove' }), front);
      swipeToRemove(row, front, remove);
      return row;
    }),
  );
}

export function initStack() {
  onShow('stack', renderStack);
  onShow('words', renderWords);
  onShow('word', renderWord);
  onShow('sentences', renderSentences);
  $('word-examples-button').addEventListener('click', showExamples);
  $('word-remove-button').addEventListener('click', removeWord);
}
