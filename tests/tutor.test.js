import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, DEFAULT_SETTINGS, MAX_SPEED, MIN_SPEED, SILENCE_MS } from '../server/settings.js';
import { buildInstructions, buildSession, pickQuestion, QUESTIONS, turnDetection } from '../server/tutor.js';

test('the four requested questions are all in the bank', () => {
  const japanese = QUESTIONS.map((question) => question.japanese);
  for (const question of ['今日は元気ですか？', '何してますか？', '今日は何を食べますか？', '週末に何をしますか？']) {
    assert.ok(japanese.includes(question), question);
  }
});

test('pickQuestion avoids the last question', () => {
  for (const value of [0, 0.3, 0.6, 0.99]) {
    assert.notEqual(pickQuestion('genki', () => value).id, 'genki');
  }
});

test('the greeting fits the time of day', () => {
  const question = QUESTIONS[0];
  assert.match(buildInstructions({ question, localHour: 10 }), /おはよう/);
  assert.match(buildInstructions({ question, localHour: 14 }), /こんにちは/);
  assert.match(buildInstructions({ question, localHour: 19 }), /こんばんは/);
  assert.match(buildInstructions({ question, localHour: 14, calledBack: true }), /折り返して/);
});

test('the instructions ask this call\'s question and cover each behavior', () => {
  const instructions = buildInstructions({ question: QUESTIONS[2], localHour: 12 });
  assert.ok(instructions.includes(QUESTIONS[2].japanese));
  assert.match(instructions, /what does genki mean/);
  assert.match(instructions, /update_settings/);
  assert.match(instructions, /end_call/);
  assert.match(instructions, /Try saying that in Japanese/);
});

test('the session carries the user speed and thinking time', () => {
  const session = buildSession({
    model: 'gpt-realtime',
    voice: 'marin',
    question: QUESTIONS[0],
    settings: { speed: 0.75, thinkingTime: 'long', callsEnabled: true },
    localHour: 12,
  });
  assert.equal(session.type, 'realtime');
  assert.equal(session.audio.output.speed, 0.75);
  assert.equal(session.audio.output.voice, 'marin');
  assert.equal(session.audio.input.turn_detection.silence_duration_ms, SILENCE_MS.long);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['update_settings', 'end_call']);
});

test('speed steps stay inside the allowed range', () => {
  assert.equal(applySettings(DEFAULT_SETTINGS, { speedChange: 'slower' }).speed, 0.75);
  assert.equal(applySettings(DEFAULT_SETTINGS, { speedChange: 'faster' }).speed, 1.05);
  assert.equal(applySettings(DEFAULT_SETTINGS, { speedChange: 'normal' }).speed, 1);
  assert.equal(applySettings({ ...DEFAULT_SETTINGS, speed: 0.65 }, { speedChange: 'much_slower' }).speed, MIN_SPEED);
  assert.equal(applySettings({ ...DEFAULT_SETTINGS, speed: 1.4 }, { speedChange: 'much_faster' }).speed, MAX_SPEED);
  assert.equal(applySettings(DEFAULT_SETTINGS, { speed: 99 }).speed, MAX_SPEED);
});

test('unknown settings changes are ignored', () => {
  assert.deepEqual(applySettings(DEFAULT_SETTINGS, { speedChange: 'warp', thinkingTime: 'forever', callsEnabled: 'no', admin: true }), DEFAULT_SETTINGS);
  assert.equal(applySettings(DEFAULT_SETTINGS, { callsEnabled: false }).callsEnabled, false);
  assert.equal(turnDetection('nonsense').silence_duration_ms, SILENCE_MS.normal);
});
