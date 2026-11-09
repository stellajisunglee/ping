import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, DEFAULT_SETTINGS, MAX_SPEED, MIN_SPEED, SILENCE_MS, silenceMs } from '../server/settings.js';
import { buildInstructions, buildSession, pickQuestion, QUESTIONS, turnDetection, voiceMessageFor } from '../server/tutor.js';

test('every question is open-ended, with a polite and a casual version', () => {
  for (const question of QUESTIONS) {
    assert.match(question.japanese, /何|どんな|どう/, question.id);
    assert.match(question.japanese, /(です|ます|ました)か？$/, question.id);
    assert.ok(question.casual && !/(です|ます|ました)/.test(question.casual), question.id);
  }
});

test('pickQuestion avoids the last question', () => {
  for (const value of [0, 0.3, 0.6, 0.99]) {
    assert.notEqual(pickQuestion('day', () => value).id, 'day');
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
  assert.match(instructions, /add_to_stack/);
});

test('a language or culture question in English gets a short answer before the Japanese nudge', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  const rule = (text) => instructions.indexOf(text);
  assert.match(instructions, /how do you say umbrella/);
  assert.match(instructions, /back_to_conversation/);
  // The rules are checked in order, so an off-topic culture question is answered before the off-topic rule could catch it.
  assert.ok(rule('Japanese language or Japanese culture') < rule('ちょっとわかりません'));
  assert.ok(rule('Japanese language or Japanese culture') < rule('Try saying that in Japanese'));
});

test('Ping is formal by default, says it\'s not sure when off topic, and sticks to two languages', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(instructions, /You are Ping/);
  assert.match(instructions, /ピンです/);
  assert.match(instructions, /です\/ます/);
  assert.match(instructions, /ちょっとわかりません/);
  assert.match(instructions, /Only ever speak Japanese or English/);
  assert.ok(!/Mina|ミナ/.test(instructions));
});

test('the level and politeness settings change how the contact talks', () => {
  const settings = { ...DEFAULT_SETTINGS, formality: 'casual', proficiency: 'advanced' };
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings });
  assert.match(instructions, /The user is advanced/);
  assert.match(instructions, /casual speech/);
  assert.match(instructions, /ピンだよ/);
  assert.ok(instructions.includes(QUESTIONS[0].casual));
});

test('a custom contact uses its own name, topic and voice', () => {
  const contact = { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', voice: 'cedar', plan: 'pro' };
  const session = buildSession({ model: 'm', voice: 'marin', question: QUESTIONS[0], settings: DEFAULT_SETTINGS, localHour: 12, contact });
  assert.equal(session.audio.output.voice, 'cedar');
  assert.match(session.instructions, /You are Yuki/);
  assert.match(session.instructions, /about cooking/);
  assert.ok(!session.instructions.includes(QUESTIONS[0].japanese));
});

test('past conversations reach the instructions only when given', () => {
  const remembered = buildInstructions({ question: QUESTIONS[0], localHour: 12, memories: ['ラーメンが好きです'] });
  assert.match(remembered, /WHAT YOU REMEMBER/);
  assert.match(remembered, /ラーメンが好きです/);
  assert.ok(!/WHAT YOU REMEMBER/.test(buildInstructions({ question: QUESTIONS[0], localHour: 12 })));
});

test('voicemail uses the contact name in both languages', () => {
  assert.match(voiceMessageFor().japanese, /ピン/);
  assert.match(voiceMessageFor().english, /Ping/);
});

test('the session carries the user speed and thinking time', () => {
  const session = buildSession({
    model: 'gpt-realtime',
    voice: 'marin',
    question: QUESTIONS[0],
    settings: { ...DEFAULT_SETTINGS, speed: 0.75, thinkingTime: 'long' },
    localHour: 12,
  });
  assert.equal(session.type, 'realtime');
  assert.equal(session.audio.output.speed, 0.75);
  assert.equal(session.audio.output.voice, 'marin');
  assert.equal(session.audio.input.turn_detection.silence_duration_ms, silenceMs('long', 0.75));
  assert.deepEqual(session.audio.input.transcription.languages, ['ja', 'en']);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['add_to_stack', 'update_settings', 'back_to_conversation', 'end_call']);
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
  assert.equal(turnDetection({ thinkingTime: 'nonsense' }).silence_duration_ms, SILENCE_MS.normal);
});

test('slower speeds are more patient with gaps in speech', () => {
  assert.equal(silenceMs('normal', 1), SILENCE_MS.normal);
  assert.equal(silenceMs('normal', 1.5), SILENCE_MS.normal);
  assert.ok(silenceMs('normal', 0.75) > silenceMs('normal', 0.9));
  assert.ok(silenceMs('normal', 0.6) > silenceMs('normal', 0.75));
  assert.equal(turnDetection({ thinkingTime: 'long', speed: 0.6 }).silence_duration_ms, 4000);
});

test('schedule and call settings are checked', () => {
  const changed = applySettings(DEFAULT_SETTINGS, { frequency: 'weekends', proficiency: 'advanced', formality: 'casual', callStartHour: 8, callEndHour: 12, customDays: [6, 0, 9, 6, 'x'] });
  assert.equal(changed.frequency, 'weekends');
  assert.equal(changed.proficiency, 'advanced');
  assert.equal(changed.formality, 'casual');
  assert.deepEqual([changed.callStartHour, changed.callEndHour], [8, 12]);
  assert.deepEqual(changed.customDays, [0, 6]);

  const rejected = applySettings(DEFAULT_SETTINGS, { frequency: 'hourly', language: 'fr', callStartHour: 15, callEndHour: 9 });
  assert.deepEqual(rejected, DEFAULT_SETTINGS);
  assert.equal(applySettings(DEFAULT_SETTINGS, { callEndHour: 99 }).callEndHour, DEFAULT_SETTINGS.callEndHour);
});

test('silence mode waits a set silence for every thinking time, as before', () => {
  for (const thinkingTime of ['short', 'normal', 'long']) {
    assert.deepEqual(turnDetection({ thinkingTime, speed: 0.9, turnMode: 'silence' }), {
      type: 'server_vad',
      silence_duration_ms: silenceMs(thinkingTime, 0.9),
      create_response: false,
      interrupt_response: true,
    });
  }
  assert.deepEqual(turnDetection({ thinkingTime: 'normal', speed: 0.9 }), turnDetection({ thinkingTime: 'normal', speed: 0.9, turnMode: 'silence' }));
});

test('semantic mode is patient: short is medium, normal and long are low', () => {
  const eagerness = (thinkingTime) => turnDetection({ thinkingTime, speed: 0.9, turnMode: 'semantic' });
  assert.deepEqual(eagerness('short'), { type: 'semantic_vad', eagerness: 'medium', create_response: false, interrupt_response: true });
  assert.equal(eagerness('normal').eagerness, 'low');
  assert.equal(eagerness('long').eagerness, 'low');
  assert.equal(eagerness('nonsense').eagerness, 'low');
  assert.equal(eagerness('normal').silence_duration_ms, undefined);
});

test('the session uses the turn mode it is given', () => {
  const build = (turnMode) => buildSession({ model: 'm', voice: 'marin', question: QUESTIONS[0], settings: DEFAULT_SETTINGS, localHour: 12, turnMode });
  assert.equal(build('semantic').audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(build(undefined).audio.input.turn_detection.type, 'server_vad');
});

test('Smart Turn mode starts with the same silence detection, for the phone to switch off once ready', () => {
  for (const thinkingTime of ['short', 'normal', 'long']) {
    assert.deepEqual(turnDetection({ thinkingTime, speed: 0.9, turnMode: 'smartTurn' }), turnDetection({ thinkingTime, speed: 0.9, turnMode: 'silence' }));
  }
});

test('in every mode OpenAI stops the contact when the user speaks, but leaves replies to the app', () => {
  for (const turnMode of ['silence', 'semantic', 'smartTurn']) {
    const detection = turnDetection({ thinkingTime: 'normal', speed: 0.9, turnMode });
    assert.equal(detection.create_response, false, turnMode);
    assert.equal(detection.interrupt_response, true, turnMode);
  }
});
