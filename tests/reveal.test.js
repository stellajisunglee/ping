import test from 'node:test';
import assert from 'node:assert/strict';
import { charsSaid, createPace, DEFAULT_UNITS_PER_SECOND, speechUnits, unitsOf } from '../public/reveal.js';

test('kanji take longer to say than kana, and English letters less', () => {
  assert.ok(unitsOf('食') > unitsOf('た'));
  assert.ok(unitsOf('た') > unitsOf('a'));
  assert.equal(speechUnits('たべた'), 3);
});

test('words are said in order, nothing before the voice starts, and never more than the line', () => {
  const perMs = DEFAULT_UNITS_PER_SECOND / 1000;
  const line = 'そうなんだ。今日は何を食べた？';
  assert.equal(charsSaid(line, 0, perMs), 0);
  assert.equal(charsSaid(line, -50, perMs), 0);
  const early = charsSaid(line, 500, perMs);
  const later = charsSaid(line, 1500, perMs);
  assert.ok(early > 0 && later > early, `${early} then ${later}`);
  assert.equal(charsSaid(line, 60_000, perMs), line.length);
});

test('the pace starts from the speed setting and learns from replies that played to the end', () => {
  const pace = createPace();
  assert.equal(pace.unitsPerMs(1), DEFAULT_UNITS_PER_SECOND / 1000);
  assert.equal(pace.unitsPerMs(0.5), DEFAULT_UNITS_PER_SECOND / 2000);

  // Ping actually spoke 10 units a second at speed 1, over more than 3 seconds of speech.
  pace.learn('あ'.repeat(40), 4000, 1);
  assert.ok(Math.abs(pace.unitsPerMs(1) - 0.01) < 1e-9);
  // Measured at speed 1, so a slower speed setting still slows it down.
  assert.ok(Math.abs(pace.unitsPerMs(0.8) - 0.008) < 1e-9);
});

test('one odd reply cannot make the text race ahead or crawl', () => {
  const racing = createPace();
  racing.learn('あ'.repeat(500), 3000, 1);
  assert.equal(racing.unitsPerMs(1), 20 / 1000);
  const crawling = createPace();
  crawling.learn('あ', 5000, 1);
  assert.equal(crawling.unitsPerMs(1), 3 / 1000);
});

test('a short or empty reply is not enough to measure the pace', () => {
  const pace = createPace();
  pace.learn('はい', 400, 1);
  pace.learn('   ', 5000, 1);
  pace.learn('はい', 0, 1);
  assert.equal(pace.unitsPerMs(1), DEFAULT_UNITS_PER_SECOND / 1000);
});
