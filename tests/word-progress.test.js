import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWordEvents, dueWords, WORDS_PER_CALL, wordProgress } from '../server/word-progress.js';
import { wordEvents } from '../public/learning-metrics.js';

const DAY = 86_400_000;
const word = (id, at, extra = {}) => ({ id, kanji: '', kana: id, english: id, at, ...extra });

test('a saved word is due a day later, oldest first, at most two a call', () => {
  const now = 10 * DAY;
  const words = [word('a', now - 3 * DAY), word('b', now - 5 * DAY), word('c', now - 2 * DAY), word('d', now - 12 * 3600_000)];
  assert.deepEqual(dueWords(words, now).map((w) => w.id), ['b', 'a']);
  assert.equal(WORDS_PER_CALL, 2);
  assert.equal(wordProgress(words[3]).nextDueAt, words[3].at + DAY, 'saved this morning: not due till tomorrow');
});

test('a word moves from saved to came back, understood and used, and comes back again later each time', () => {
  const words = [word('さんぽ', 0, { kanji: '散歩' }), word('てんき', 0, { kanji: '天気' })];
  let events = applyWordEvents(words, { cameBack: ['さんぽ', 'てんき'], lookedUp: ['てんき'] }, 2 * DAY);
  assert.deepEqual(events, [{ wordId: 'さんぽ', event: 'understood' }, { wordId: 'てんき', event: 'looked-up-again' }, { wordId: 'てんき', event: 'came-back' }]);
  assert.deepEqual([words[0].progress.stage, words[1].progress.stage], ['understood', 'came-back']);
  assert.equal(words[0].progress.nextDueAt, 2 * DAY + 3 * DAY, 'next comeback in 3 days, then 7');
  events = applyWordEvents(words, { used: ['てんき'] }, 4 * DAY);
  assert.deepEqual([words[1].progress.stage, words[1].progress.usedCount, words[1].progress.firstUsedAt], ['used', 1, 4 * DAY]);
  applyWordEvents(words, { cameBack: ['てんき'], lookedUp: ['てんき'] }, 9 * DAY);
  assert.equal(words[1].progress.stage, 'used', 'a stage never goes back');
});

test("the phone finds saved words in what each side said, by kanji or by kana of 2+ characters", () => {
  const stackWords = [word('w1', 0, { kanji: '散歩', kana: 'さんぽ' }), word('w2', 0, { kanji: '', kana: 'い' }), word('w3', 0, { kanji: '天気', kana: 'てんき' })];
  const lines = [
    { from: 'contact', text: '今日は散歩しましたか？いい天気ですね。' },
    { from: 'you', text: 'はい、さんぽしました。' },
  ];
  assert.deepEqual(wordEvents({ lines, stackWords, lookedUpIds: ['w3', 'not-mine'] }), { cameBack: ['w1', 'w3'], used: ['w1'], lookedUp: ['w3'] });
});
