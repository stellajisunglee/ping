import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanLearning, LEARNING_FIELDS, summarizeLearning, wordLevels } from '../public/learning-metrics.js';

const LIST = JSON.parse(readFileSync(new URL('../public/jlpt-words.json', import.meta.url), 'utf8'));
const levels = wordLevels(LIST);
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
const you = (text) => ({ from: 'you', text });
const ping = (text) => ({ from: 'contact', text });

test('the word list gives each word its easiest JLPT level', () => {
  assert.equal(levels.get('友達'), 'N5');
  assert.equal(levels.get('映画'), 'N5');
  assert.ok(levels.size > 10_000);
  assert.match(LIST.source, /tanos\.co\.uk/);
});

test("only the learner's lines count: characters, English share, help and stack words", () => {
  const summary = summarizeLearning({
    lines: [ping('今日は何をしましたか？'), you('友達と映画を見ました。'), you('What does sanpo mean?'), you('散歩もしました。もう一度お願いします。'), ping('いいですね！')],
    stackWords: [{ kanji: '散歩', kana: 'さんぽ' }, { kanji: '週末', kana: 'しゅうまつ' }],
    newWords: 2,
    levels,
    segmenter,
  });
  assert.equal(summary.learnerTurns, 3);
  assert.equal(summary.japaneseChars, 10 + 0 + 17);
  assert.equal(summary.avgTurnChars, 9);
  assert.equal(summary.englishTurnPercent, 33);
  assert.equal(summary.helpRequests, 2, 'asking what a word means, and もう一度');
  assert.equal(summary.stackWordsUsed, 1, '散歩 was in the stack; 週末 was not said');
  assert.equal(summary.newWords, 2);
  assert.ok(summary.jlptN5Words >= 2, '友達 and 映画 are N5');
  assert.equal(summary.jlptN5Words + summary.jlptN4Words + summary.jlptN3Words + summary.jlptN2Words + summary.jlptN1Words + summary.offListWords, summary.distinctWords);
});

test('particles, verb endings and fillers are not counted as words', () => {
  const summary = summarizeLearning({ lines: [you('えーと、は、を、ました。ですね。')], levels, segmenter });
  assert.equal(summary.distinctWords, 0);
});

test('a call where the learner said nothing has counts of zero and no averages', () => {
  const summary = summarizeLearning({ lines: [ping('もしもし')], levels, segmenter });
  assert.deepEqual([summary.learnerTurns, summary.avgTurnChars, summary.englishTurnPercent, summary.distinctWords], [0, null, null, 0]);
  assert.deepEqual(cleanLearning(summary), summary, 'still valid to send');
});

test('without a word splitter, words are not counted but everything else is', () => {
  const summary = summarizeLearning({ lines: [you('友達と映画を見ました。')], levels });
  assert.deepEqual([summary.distinctWords, summary.japaneseChars], [0, 10]);
});

test('learning numbers must be every known field, whole numbers in range, and nothing else', () => {
  const good = summarizeLearning({ lines: [you('映画を見ました。')], levels, segmenter });
  assert.deepEqual(Object.keys(good), LEARNING_FIELDS);
  assert.deepEqual(cleanLearning(good), good);
  for (const bad of [{ ...good, text: '映画' }, { ...good, japaneseChars: -1 }, { ...good, englishTurnPercent: 101 }, { ...good, newWords: 1.5 }, { ...good, newWords: null }, {}, null, []]) {
    assert.equal(cleanLearning(bad), null, JSON.stringify(bad));
  }
});

test("the admin call log shows the learner's side of a call, and - for calls from before it was measured", async () => {
  const { learningFacts } = await import('../public/settings.js');
  const facts = (entry) => Object.fromEntries(learningFacts(entry));
  const measured = facts({
    userCallSharePercent: 42, avgTurnMs: 4200, avgTurnChars: 14, answerStartMedianMs: 1800, japaneseChars: 120, englishTurnPercent: 10,
    distinctWords: 20, jlptN5Words: 10, jlptN4Words: 4, jlptN3Words: 2, jlptN2Words: 1, jlptN1Words: 0, offListWords: 3,
    stackWordsUsed: 2, newWords: 1, helpRequests: 1, estimatedLevel: 'N4', estimatedVocabulary: 'N4', estimatedGrammar: 'N5', levelConfidence: 'medium',
  });
  assert.equal(measured['Learner talk share'], '42%');
  assert.equal(measured['Average turn'], '4.2 s, 14 characters');
  assert.equal(measured['Different words'], '20 (N5 10, N4 4, N3 2, N2 1, N1 0, other 3)');
  assert.equal(measured['Estimated level'], 'N4 (vocabulary N4, grammar N5, medium confidence)');
  assert.ok(Object.values(facts({})).every((value) => value === '-'));
});

test("the invite list says whether Ping fits into a learner's day", async () => {
  const { habitText } = await import('../public/settings.js');
  const habit = { days: 28, pingCalls: 6, answerRatePercent: 83, pickupMedianSeconds: 5, callsStartedByPing: 6, callsStartedByLearner: 2, practiceDaysPerWeek: 3.5, answeredHours: {}, unplannedMinutesThisWeek: 4.2 };
  assert.equal(habitText(habit), "Last 4 weeks: answered 83% of Ping's 6 calls (in 5 s) · started 2 themselves · 3.5 practice days a week · 4.2 min of Japanese from Ping's calls this week");
  assert.match(habitText({ ...habit, pingCalls: 0, answerRatePercent: null, pickupMedianSeconds: null }), /no calls from Ping yet/);
});
