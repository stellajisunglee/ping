import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, DEFAULT_SETTINGS, MAX_SPEED, MIN_SPEED, SILENCE_MS, silenceMs } from '../server/settings.js';
import { buildInstructions, buildSession, NOT_NOW_GOODBYES, pickQuestion, QUESTIONS, turnDetection, voiceMessageFor } from '../server/tutor.js';
import { describeDay, PING_BIO, PING_DAYS, PING_IDENTITY, PING_PERSONA, pingsDay } from '../server/persona.js';
import { PING } from '../server/contacts.js';

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
  assert.ok(rule('Japanese language or Japanese culture') < rule('They try to steer the conversation away'));
  assert.ok(rule('Japanese language or Japanese culture') < rule('Try saying that in Japanese'));
});

test('asking what one word means saves it, however the question is put', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  const rule = (text) => instructions.indexOf(text);
  for (const example of ['what does genki mean?', 'what do you mean by genki?', "what's genki?", '「げんきってどういう意味？」']) assert.ok(instructions.includes(example), example);
  assert.match(instructions, /may spell the word wrongly/);
  // Checked before the whole-sentence translation rule, which doesn't save anything.
  assert.ok(rule('what do you mean by genki?') < rule('can you translate that'));
  assert.match(instructions, /without naming one word/);
  // Repeating Ping's word back as a question asks what it means, not about Ping's day.
  assert.ok(instructions.includes('「忙しい？」'));
  assert.match(instructions, /this rule, not rule 7/);
  // The rule it points to is the one about Ping.
  assert.match(instructions, /\n7\. They ask about you in Japanese/);
  assert.match(instructions, /aren't just repeating a word you just said/);
});

test("Ping never gets stuck asking the same question", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(instructions, /Never ask the same question more than twice in a row/);
  assert.match(instructions, /how would you use 複雑 in a sentence/);
});

test("asking what Ping said gets an English translation, not the same Japanese again", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  const rule = (text) => instructions.indexOf(text);
  assert.match(instructions, /can you translate that/);
  assert.match(instructions, /say what you just said in English/);
  assert.match(instructions, /Never answer this by repeating the same Japanese sentence/);
  // Checked before the culture-question and "try saying it in Japanese" rules, which only ask the question again.
  assert.ok(rule('can you translate that') < rule('Japanese language or Japanese culture'));
  assert.ok(rule('can you translate that') < rule('Try saying that in Japanese'));
});

test('a clarifying question gets an answer and a narrower version of the same question, never the opening one', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  const rule = (text) => instructions.indexOf(text);
  for (const example of ['do you mean today or in general?', 'you mean right now?', '「今日のこと？」']) assert.ok(instructions.includes(example), example);
  assert.match(instructions, /this is a clarifying question, so answer it/);
  assert.match(instructions, /made more specific to what they asked about/);
  assert.match(instructions, /Never answer a clarifying question by going back to an earlier question/);
  // After "didn't understand", which asks for a translation, and before the rules that would only ask the question again
  // or treat a Japanese clarifying question as a question about Ping.
  assert.ok(rule('can you translate that') < rule('do you mean today or in general?'));
  for (const later of ['Japanese language or Japanese culture', 'They ask about you in Japanese', 'They answer in Japanese', 'Try saying that in Japanese']) {
    assert.ok(rule('do you mean today or in general?') < rule(later), later);
  }
});

test('"the question" is the latest one, and the opening question is never brought back', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(instructions, /"The question" means the question you asked most recently, which is usually not the one from the opening/);
  assert.match(instructions, /once the conversation has moved on, never go back to it/);
  // Repeating "word for word" made the model reach for the one question written out in full: the opening one.
  assert.ok(!/word for word/.test(instructions));
  // The opening question still appears exactly once, in the opening.
  assert.equal(instructions.split(QUESTIONS[0].japanese).length - 1, 1);
});

test('Ping is formal by default, says it\'s not sure when off topic, and sticks to two languages', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(instructions, /You are Ping/);
  assert.match(instructions, /ピンです/);
  assert.match(instructions, /です\/ます/);
  // Ping says honestly it isn't her area; custom contacts keep their fixed 「ちょっとわかりません。」 (tested below).
  assert.match(instructions, /it isn't something you know much about/);
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
  assert.equal(applySettings(DEFAULT_SETTINGS, { speedChange: 'slower' }).speed, 0.85);
  assert.equal(applySettings(DEFAULT_SETTINGS, { speedChange: 'faster' }).speed, 1.15);
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

test("Ping has a life of its own, and says what it's doing when asked", () => {
  const localDate = { year: 2026, month: 11, day: 10 };
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 19, localDate });
  const rule = (text) => instructions.indexOf(text);
  const { today, tomorrow } = pingsDay({ localDate, localHour: 19 });
  assert.match(instructions, /YOUR LIFE/);
  assert.ok(instructions.includes(PING_BIO));
  assert.deepEqual(today.map((part) => part.status), ['done', 'done', 'now', 'planned']);
  assert.ok(instructions.includes(`This evening (now, what you've been doing): ${today[2].plan}.`));
  assert.ok(instructions.includes(`Tonight (planned): ${today[3].plan}.`));
  for (const plan of tomorrow) assert.ok(instructions.includes(plan));
  assert.match(instructions, /今、家にいるの？/); // asking what Ping is up to now, without reusing an opening question
  assert.match(instructions, /明日の予定は？/);
  assert.match(instructions, /tell them honestly that you are an AI/);
  // Checked before the off-topic rule, so "what are you doing?" isn't treated as steering away.
  assert.ok(rule('They ask about you in Japanese') < rule('They try to steer the conversation away'));
});

test("every call on the same day tells the same story, and tomorrow's plans are the next day's", () => {
  const day = (dayOfMonth, localHour) => pingsDay({ localDate: { year: 2026, month: 11, day: dayOfMonth }, localHour });
  const plans = (result) => result.today.map((part) => part.plan);
  assert.deepEqual(day(10, 9), day(10, 9));
  assert.deepEqual(plans(day(10, 9)), plans(day(10, 20)));
  assert.deepEqual(day(10, 9).tomorrow, plans(day(11, 9)));
  assert.notDeepEqual(plans(day(11, 9)), plans(day(10, 9)));
  for (let offset = 0; offset < PING_DAYS.length; offset += 1) assert.ok(day(1 + offset, 9).today.every((part) => part.plan));
});

test("Ping doesn't say how a planned part of its day went before it happens", () => {
  const morning = pingsDay({ localDate: { year: 2026, month: 11, day: 10 }, localHour: 8 });
  for (const part of morning.today.filter((part) => part.status === 'planned')) assert.equal(part.happened, undefined);
  assert.match(describeDay(morning), /Don't say how planned things turned out/);
});

test('a call after midnight still belongs to the night before', () => {
  const lateNight = pingsDay({ localDate: { year: 2026, month: 11, day: 11 }, localHour: 1 });
  const eveningBefore = pingsDay({ localDate: { year: 2026, month: 11, day: 10 }, localHour: 23 });
  assert.deepEqual(lateNight, eveningBefore);
  assert.deepEqual(lateNight.today.map((part) => part.status), ['done', 'done', 'done', 'now']);
});

test("a custom contact makes up small details that fit its topic, not Ping's life", () => {
  const contact = { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', voice: 'cedar', plan: 'platinum' };
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, contact });
  assert.match(instructions, /You are a friend who loves cooking/);
  assert.ok(!instructions.includes(PING_BIO));
});

test('when Ping calls it first asks if it is a good time, and a callback goes straight to the question', () => {
  const calling = buildInstructions({ question: QUESTIONS[0], localHour: 15 });
  assert.match(calling, /今、お時間大丈夫ですか？/);
  assert.match(calling, /wait for their answer/);
  assert.ok(calling.includes(NOT_NOW_GOODBYES.formal));
  const casual = buildInstructions({ question: QUESTIONS[0], localHour: 15, settings: { ...DEFAULT_SETTINGS, formality: 'casual' } });
  assert.match(casual, /今、話せる？/);
  assert.ok(casual.includes(NOT_NOW_GOODBYES.casual));
  const calledBack = buildInstructions({ question: QUESTIONS[0], localHour: 15, calledBack: true });
  assert.doesNotMatch(calledBack, /大丈夫ですか|wait for their answer/);
  assert.match(calledBack, /折り返してくれて/);
});

test("Ping's identity comes from persona.js, and what every user shares can't be changed by one call", () => {
  assert.deepEqual({ name: PING.name, spokenName: PING.spokenName, topic: PING.topic }, { ...PING_IDENTITY });
  for (const shared of [PING, PING_IDENTITY, PING_DAYS, PING_DAYS[0], PING_DAYS[0].morning]) assert.ok(Object.isFrozen(shared));
  assert.throws(() => {
    PING.name = 'Someone else';
  }, TypeError);
});

test("when Ping repairs, it changes the question instead of saying it again, and gets easier if they're still lost", () => {
  const instructions = buildInstructions({ question: QUESTIONS[5], localHour: 12 });
  assert.match(instructions, /If it was long, give only the part that matters, usually your question/);
  assert.match(instructions, /ask about the same thing in a new, easier way in Japanese: fewer words, easier words, or a narrower question/);
  assert.match(instructions, /If they are still lost after that, make it easier again in a different way/);
  // Asking to hear it again isn't being lost, so that's the one time Ping says the same thing again.
  assert.match(instructions, /If they only missed hearing it .*「もう一度お願いします」.*say it again, a little more slowly/);
});

test('Ping says its answer to a language or culture question before going back to the conversation', () => {
  const instructions = buildInstructions({ question: QUESTIONS[3], localHour: 12 });
  assert.match(instructions, /\n6\. They ask in English about the Japanese language or Japanese culture/);
  // A positive two-sentence shape, with no Japanese in the example, kept answers short and first in testing.
  assert.match(instructions, /Say your answer first, in English, the way a friend would: one sentence that answers the question directly, then one sentence with a relevant detail or something you've noticed yourself/);
  const example = instructions.match(/\(for example, for "is it rude to tip\?": "([^"]+)"\)/)[1];
  assert.ok(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(example), 'no Japanese a learner could take as a word to save');
  assert.match(instructions, /Only after you have said it, call back_to_conversation and say nothing more\./);
});

test('an answer in English is welcomed before Japanese is invited, even a good one, except when it matters more than practice', () => {
  const instructions = buildInstructions({ question: QUESTIONS[2], localHour: 12 });
  assert.match(instructions, /\n11\. They answer you, or say anything else, in English or another language, even if it's a good answer to your question: first show you understood/);
  assert.match(instructions, /in your usual speech style/);
  assert.match(instructions, /instead of asking something new, gently invite them to try saying it in Japanese/);
  assert.match(instructions, /give them the first Japanese words to start from/);
  assert.match(instructions, /never like a correction/);
  assert.match(instructions, /something serious or upsetting.*don't ask them to practice/);
});

test("the examples in Ping's own rules are never one of its opening questions, which would pull it back into the call", () => {
  for (const question of QUESTIONS) {
    for (const formality of ['formal', 'casual']) {
      const instructions = buildInstructions({ question, localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
      const rules = ['2', '3', '6', '8', '11'].map((number) => instructions.match(new RegExp(`\\n${number}\\. [^\\n]+`))[0]);
      for (const asked of QUESTIONS.flatMap((candidate) => [candidate.japanese, candidate.casual])) {
        assert.ok(rules.every((rule) => !rule.includes(asked)), `${asked} in ${question.id} ${formality}`);
      }
    }
  }
});

test("custom contacts keep the original ten rules: Ping's versions and Ping's extra rule are Ping's alone", () => {
  const contact = { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', voice: 'cedar', plan: 'platinum' };
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, contact });
  const rules = instructions.slice(instructions.indexOf('EVERY TURN AFTER THAT'));
  assert.match(instructions, /\n2\. They didn't understand .*Then ask the question again in Japanese, more slowly and with easier words\. Never answer this by repeating the same Japanese sentence\.\n/);
  assert.match(instructions, /\n3\. They understood you, but ask what you meant by your question or how to answer it/);
  assert.match(instructions, /\n6\. .*Answer in English in one or two short sentences, adding a short Japanese example only if it helps\. Then call back_to_conversation and say nothing more\./);
  assert.match(instructions, /\n8\. They try to steer the conversation away from cooking/);
  assert.match(instructions, /\n10\. They say anything else in a language other than Japanese: gently encourage them in English/);
  assert.ok(!/\n11\. /.test(instructions));
  for (const pingOnly of ['a new, easier way', 'example answer', "don't know what to say", 'missed hearing it', 'serious or upsetting', 'Say your answer first']) {
    assert.ok(!rules.includes(pingOnly), pingOnly);
  }
  // Rule 1 still points to the rule about the contact itself, for every contact.
  assert.match(instructions, /this rule, not rule 7/);
  assert.match(instructions, /\n7\. They ask about you in Japanese/);
});

test("rule 7's examples never repeat one of Ping's opening questions, in either speech style", () => {
  const plain = (text) => text.replace(/[\s、。！？!?「」]/g, '');
  for (const formality of ['formal', 'casual']) {
    const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
    const rule7 = plain(instructions.match(/\n7\. [^\n]+/)[0]);
    for (const question of QUESTIONS) {
      for (const form of [question.japanese, question.casual]) assert.ok(!rule7.includes(plain(form)), `${question.id}: ${form}`);
    }
  }
  // Custom contacts never ask these questions, so they keep the original examples.
  const custom = buildInstructions({ question: QUESTIONS[0], localHour: 12, contact: { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', plan: 'platinum' } });
  assert.ok(custom.includes('「今、何してる？」, 「今日は何を食べた？」'));
});

test('a learner still stuck after one example gets something easier, not the same three steps again', () => {
  for (const [formality, choices] of [['formal', '「家ですか？外ですか？」'], ['casual', '「家？外？」']]) {
    const instructions = buildInstructions({ question: QUESTIONS[1], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
    const rule8 = instructions.match(/\n8\. [^\n]+/)[0];
    assert.match(rule8, /If they are still stuck after that .*don't do the same steps again: make it easier\./);
    assert.ok(rule8.includes(`Then either say briefly in English what you'd like to hear, or offer two simple Japanese choices to pick from (for example ${choices})`), formality);
    assert.match(rule8, /Any short answer counts, even one word or a short phrase\.$/);
  }
});

test('a learner still stuck after the example is told, in the call\'s speech style, that a short answer is enough', () => {
  for (const [formality, shortIsFine, pickOne] of [
    ['formal', '「一言でも大丈夫ですよ。」 or 「短くてもいいですよ。」', '「一つ選ぶだけでもいいですよ。」'],
    ['casual', '「一言でも大丈夫だよ。」 or 「短くてもいいよ。」', '「一つ選ぶだけでもいいよ。」'],
  ]) {
    const instructions = buildInstructions({ question: QUESTIONS[1], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
    const rule8 = instructions.match(/\n8\. [^\n]+/)[0];
    assert.ok(rule8.includes(`that a short answer is enough, such as ${shortIsFine}. Then either say briefly in English`), formality);
    assert.ok(rule8.includes(`and you can add ${pickOne}.`), formality);
  }
});

const rulesOf = (instructions) => instructions.slice(instructions.indexOf('EVERY TURN AFTER THAT'));
const ruleText = (instructions, number) => instructions.match(new RegExp(`\\n${number}\\. [^\\n]+`))[0];
const routingOf = (instructions) => {
  const turns = rulesOf(instructions);
  return turns.slice(turns.indexOf("WHEN THEY SAY THEY DON'T UNDERSTAND OR DON'T KNOW"), turns.indexOf('\n1. '));
};

test("Ping decides which rule an \"I don't understand\" or \"I don't know\" belongs to before reading the rules", () => {
  const instructions = buildInstructions({ question: QUESTIONS[1], localHour: 12 });
  const turns = rulesOf(instructions);
  const routing = routingOf(instructions);
  // It comes first, ahead of rule 1.
  assert.ok(turns.indexOf("WHEN THEY SAY THEY DON'T UNDERSTAND OR DON'T KNOW, decide which rule fits before anything else:") < turns.indexOf('\n1. '));
  // Rules 2 and 8 are named by their real numbers.
  assert.match(ruleText(instructions, 2), /^\n2\. They didn't understand what you just said/);
  assert.match(ruleText(instructions, 8), /^\n8\. They understood your question but can't think what to answer/);
  assert.match(routing, /in Japanese or English .*: rule 2\./);
  assert.match(routing, /They show they understood your question but can't think what to say: rule 8\./);
});

test('saying plainly that they don\'t understand, in Japanese or in English, is always rule 2', () => {
  const routing = routingOf(buildInstructions({ question: QUESTIONS[1], localHour: 12 }));
  const plain = routing.split('\n').find((line) => line.startsWith('- They say plainly'));
  for (const said of ['「質問の意味がわかりません」', '「質問がわかりません」', '"I don\'t understand the question"', '"I didn\'t understand what you said"']) {
    assert.ok(plain.includes(said), said);
  }
  assert.match(plain, /: rule 2\.$/);
});

test('a bare 「わかりません」 is rule 2 right after a question, and rule 8 once they have shown they understood it', () => {
  const routing = routingOf(buildInstructions({ question: QUESTIONS[1], localHour: 12 }));
  const bare = routing.split('\n').find((line) => line.startsWith('- They say only'));
  assert.match(bare, /^- They say only 「わかりません」 or "I don't know": decide from the conversation\./);
  assert.match(bare, /Right after you asked something they may not have followed, or used words above their level, it's rule 2\./);
  assert.match(bare, /If they've already shown they understood your question \(they repeated part of it, started to answer, or you've already explained it\), it's rule 8\./);
});

test('rule 2 always starts with a short English gloss, even when they said it in Japanese, then keeps its repair ladder', () => {
  const rule2 = ruleText(buildInstructions({ question: QUESTIONS[1], localHour: 12 }), 2);
  assert.match(rule2, /say what you just said in English, in one short sentence, even if they told you in Japanese that they don't understand\./);
  assert.match(rule2, /Then ask about the same thing in a new, easier way in Japanese.*Never answer this by repeating the same Japanese sentence, even after the English\. If they are still lost after that, make it easier again in a different way/);
  // The routing lives in the note before rule 1, not in rule 2.
  assert.ok(!/it is always this rule|A bare 「わかりません」/.test(rule2));
});

test('rule 8 never explains, restates or paraphrases the question: it goes straight to a complete Japanese example', () => {
  for (const [formality, style, sample, prompt] of [
    ['formal', 'polite です/ます', '「ラーメンが好きです。」', '「どうですか？」'],
    ['casual', 'casual', '「ラーメンが好き。」', '「どう？」'],
  ]) {
    const rule8 = ruleText(buildInstructions({ question: QUESTIONS[1], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } }), 8);
    assert.match(rule8, /They already know what you asked, so don't explain, restate or paraphrase your question, in English or Japanese\. First, give one example answer\./);
    assert.ok(!/explain what you were asking|skip this step|I was asking/.test(rule8), formality);
    assert.ok(rule8.includes(`always one complete, natural sentence in Japanese, never English, even if they spoke to you in English: something they could really say back to your question, short and easy enough for their level, in ${style} Japanese.`), formality);
    assert.ok(rule8.includes(`たとえば、${sample}`), formality);
    assert.match(rule8, /It can come from your own day in YOUR LIFE when that fits, but it doesn't have to\./);
    assert.ok(rule8.includes(`Then invite them to give their own answer with a short, different prompt, such as ${prompt}, not the same question again. Keep to ${style} Japanese in all of it.`), formality);
  }
});

test('custom contacts get no routing note and keep their original rules 2 and 3', () => {
  const custom = buildInstructions({ question: QUESTIONS[1], localHour: 12, contact: { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', plan: 'platinum' } });
  assert.ok(!/WHEN THEY SAY THEY DON'T UNDERSTAND|even if they told you in Japanese|can't think what to answer/.test(custom));
  assert.match(ruleText(custom, 2), /Then ask the question again in Japanese, more slowly and with easier words\. Never answer this by repeating the same Japanese sentence\.$/);
  assert.match(ruleText(custom, 3), /ask what you meant by your question or how to answer it/);
});

test("a culture question doesn't save a word unless they asked how to say one, and asking what a word means still saves it", () => {
  const instructions = buildInstructions({ question: QUESTIONS[3], localHour: 12 });
  const rule6 = instructions.match(/\n6\. [^\n]+/)[0];
  assert.match(rule6, /A question like this is something to answer, not a word to save: don't call add_to_stack for it unless they asked how to say a word\./);
  assert.match(rule6, /If they asked how to say a word, first call add_to_stack with that Japanese word/);
  // Rule 1, which saves words they ask the meaning of, is unchanged.
  assert.match(instructions.match(/\n1\. [^\n]+/)[0], /first call add_to_stack with that word/);
  // Custom contacts keep their original rule 6.
  const custom = buildInstructions({ question: QUESTIONS[3], localHour: 12, contact: { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', plan: 'platinum' } });
  assert.ok(!/something to answer, not a word to save|the way a friend would/.test(custom));
});

// ---------- Ping's persona ----------

const YUKI = { id: 'c1', name: 'Yuki', spokenName: 'Yuki', topic: 'cooking', voice: 'cedar', plan: 'platinum' };
const allWeek = () => Array.from({ length: 7 }, (_, offset) => ({ year: 2026, month: 11, day: 16 + offset }));

test("Ping's facts are structured in one place, and her bio is built from them", () => {
  assert.equal(PING_PERSONA.identity, PING_IDENTITY);
  assert.equal(PING_PERSONA.age, 25);
  assert.equal(PING_PERSONA.home, 'Setagaya, Tokyo');
  assert.equal(PING_PERSONA.hometown, 'Kanagawa Prefecture');
  assert.equal(PING_PERSONA.studies, 'sociology');
  assert.deepEqual({ ...PING_PERSONA.work }, { role: 'part-time barista', place: '喫茶こもれび' });
  assert.deepEqual({ ...PING_PERSONA.cat }, { name: 'Taro', japaneseName: 'タロウ', age: 3, coat: 'orange-and-white', nature: 'a bit of a troublemaker you adore' });
  assert.equal(PING_PERSONA.firstPerson, '私');
  for (const fact of ['You are 25', 'Setagaya, Tokyo', 'タロウ (Taro), a 3-year-old orange-and-white cat and a bit of a troublemaker you adore', 'grew up in Kanagawa Prefecture', 'studied sociology', 'part-time barista at 喫茶こもれび']) {
    assert.ok(PING_BIO.includes(fact), fact);
  }
  for (const shared of [PING_PERSONA, PING_PERSONA.cat, PING_PERSONA.work, PING_PERSONA.likes, PING_PERSONA.personality]) assert.ok(Object.isFrozen(shared));
});

test('nothing of the old persona is left: no Mochi, Kōenji, Osaka or guitar, on any day of the week', () => {
  const stale = /mochi|kōenji|koenji|高円寺|osaka|大阪|guitar|ギター/i;
  assert.ok(!stale.test(JSON.stringify(PING_PERSONA)) && !stale.test(PING_BIO) && !stale.test(JSON.stringify(PING_DAYS)));
  for (const localDate of allWeek()) {
    for (const localHour of [8, 13, 19, 23]) assert.ok(!stale.test(buildInstructions({ question: QUESTIONS[0], localHour, localDate })), `${localDate.day} ${localHour}`);
  }
});

test("the week is set in Setagaya, uses Ping's Japanese names, and its stories run from Monday to Sunday", () => {
  const week = JSON.stringify(PING_DAYS);
  for (const place of ['Shimokitazawa', 'Sangenjaya', 'Gōtokuji', 'Komazawa Park', '喫茶こもれび', 'タロウ']) assert.ok(week.includes(place), place);
  assert.ok(!/\bTaro\b|Kissa Komorebi/.test(week), 'Japanese names in the week');
  // 16 to 22 November 2026 is Monday to Sunday.
  const dayText = (day) => JSON.stringify(pingsDay({ localDate: { year: 2026, month: 11, day }, localHour: 23 }).today);
  assert.match(dayText(16), /asked you to work out a new autumn drink, a hojicha latte/);
  assert.match(dayText(19), /hojicha latte finally came out right/);
  assert.match(dayText(16), /photo zine/);
  assert.match(dayText(20), /print the zine pages/);
  assert.match(dayText(18), /come home to Kanagawa this Sunday/);
  assert.match(dayText(22), /take the train home to Kanagawa/);
  assert.match(dayText(22), /come back to Setagaya/);
});

test("Ping's week is shared, so she doesn't talk as if the user has already heard it", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 15, localDate: { year: 2026, month: 11, day: 16 } });
  assert.match(instructions, /They only know what you've told them about your week, so don't talk as if they already know it\./);
  assert.ok(!/WHAT YOU REMEMBER/.test(instructions), 'no memory section is named when there are no memories');
});

test("Ping's personality, humor and voice are in her instructions, before the turn rules", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  const who = instructions.slice(instructions.indexOf('WHO YOU ARE'), instructions.indexOf('Only ever speak')).trim();
  assert.ok(instructions.indexOf('WHO YOU ARE') < instructions.indexOf('EVERY TURN AFTER THAT'));
  assert.match(who, /You're warm, curious, observant, opinionated, independent and emotionally perceptive, with honest opinions of your own, not relentlessly cheerful or agreeable\./);
  assert.match(who, /You speak everyday Japanese with natural fillers \(「えー」, 「まあ」, 「なんか」, 「そうそう」\) in short turns/);
  // Kept short: each time the instructions grew, rule 6 started being skipped.
  assert.ok(who.length < 950, `WHO YOU ARE is ${who.length} characters`);
});

test('Ping calls herself 私, in both speech styles', () => {
  for (const formality of ['formal', 'casual']) {
    const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
    assert.match(instructions, /and call yourself 私\./, formality);
  }
});

test("formal calls get friendly です/ます that's never stiff, and casual calls get タメ口", () => {
  const formal = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality: 'formal' } });
  const casual = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality: 'casual' } });
  assert.match(formal, /On this call, use friendly, natural です\/ます, never stiff or textbook-like\./);
  assert.ok(!/タメ口/.test(formal));
  assert.match(casual, /On this call, use casual タメ口\./);
  assert.ok(!/never stiff or textbook-like/.test(casual));
});

test("Ping teases herself, タロウ and situations, never the learner, and stops when they're struggling", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(instructions, /You tease yourself, タロウ or everyday situations, never them or their Japanese, and stop when they're struggling\./);
});

test("off topic, Ping says honestly it isn't her area, makes nothing up, and only bridges back when it fits", () => {
  for (const [formality, notMuch] of [['formal', '「うーん、それはあんまり詳しくないんですよね。」'], ['casual', '「うーん、それはあんまり詳しくないんだよね。」']]) {
    const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, settings: { ...DEFAULT_SETTINGS, formality } });
    const rule9 = instructions.match(/\n9\. [^\n]+/)[0];
    assert.match(rule9, /^\n9\. They try to steer the conversation away from daily life/);
    assert.ok(rule9.includes(`such as ${notMuch}, and never make up facts or give advice.`), formality);
    assert.match(rule9, /If you have a genuine everyday opinion or experience that fits, you can share it in a few words\. Then, if it fits, bridge back to everyday life with a related question in Japanese\./);
    assert.match(rule9, /If the topic is sensitive, or they seem to need support more than a new question, skip the question and just respond kindly\./);
    assert.ok(!rule9.includes('ちょっとわかりません'), formality);
  }
});

test("custom contacts get none of Ping's persona, and keep their own off-topic rule", () => {
  for (const localDate of allWeek()) {
    const custom = buildInstructions({ question: QUESTIONS[0], localHour: 15, localDate, contact: YUKI });
    assert.ok(!/WHO YOU ARE|タロウ|Taro|こもれび|Setagaya|Kanagawa|sociology|私|タメ口|only know what you've told them about your week|ユーザー|form of address|feeling first/.test(custom), `${localDate.day}`);
    assert.match(custom, /\n8\. They try to steer the conversation away from cooking, toward something that another kind of friend would be better for: say exactly 「ちょっとわかりません。」 Then ask the question again in Japanese\./);
  }
});

// ---------- Beta stabilization ----------

const whoYouAre = (instructions) => instructions.slice(instructions.indexOf('WHO YOU ARE'), instructions.indexOf('Only ever speak'));

test("Ping tells her life in Japanese at the learner's level, without losing it", () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  // Rewording this to keep her feelings in made her skip culture answers (rule 6), so her warmth for タロウ is in her bio instead.
  assert.match(whoYouAre(instructions), /Tell them about your life in Japanese at their level: simplify or leave out details that need harder words or grammar\./);
  // Her life is all still there, and the level system is unchanged.
  assert.ok(instructions.includes(PING_BIO));
  assert.match(instructions, /The user is a beginner\. Use only very common words and simple sentence patterns\./);
});

test('Ping never calls the learner ユーザーさん, usually uses no form of address, and her own sections say "they", not "the user"', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(whoYouAre(instructions), /Never call them ユーザー or ユーザーさん; usually use no form of address, and あなた only when it sounds natural\./);
  // Only sentences every contact shares still say "the user".
  const sentences = (text) => text.replaceAll('Yuki', 'Ping').replaceAll('cooking', PING.topic).split(/(?<=[.:])\s+|\n/);
  const shared = new Set(sentences(buildInstructions({ question: QUESTIONS[0], localHour: 12, contact: YUKI })));
  assert.deepEqual(sentences(instructions).filter((sentence) => !shared.has(sentence) && /\buser\b/i.test(sentence)), []);
});

test('a frustrated, sad or discouraged learner gets a response to the feeling before any rule, with no model sentence', () => {
  const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12 });
  assert.match(whoYouAre(instructions), /If they clearly sound frustrated, sad or discouraged, respond to the feeling first, before any rule below: no model sentence, no push to keep practicing, and language help only if they ask for it or clearly want it\./);
  assert.ok(instructions.indexOf('respond to the feeling first') < instructions.indexOf("WHEN THEY SAY THEY DON'T UNDERSTAND"));
});

test('rule 6 is still the tested variant, word for word', () => {
  const rule6 = buildInstructions({ question: QUESTIONS[3], localHour: 12 }).match(/\n6\. [^\n]+/)[0];
  assert.equal(
    rule6,
    '\n6. They ask in English about the Japanese language or Japanese culture, on any topic (for example "is it rude to tip?", "what\'s the difference between は and が?", "how would you use 複雑 in a sentence?" or "how do you say umbrella?"): this is a real question, so answer it. If they asked how to say a word, first call add_to_stack with that Japanese word, and answer when it returns. Say your answer first, in English, the way a friend would: one sentence that answers the question directly, then one sentence with a relevant detail or something you\'ve noticed yourself (for example, for "is it rude to tip?": "Tipping isn\'t really done in Japan, and it can even confuse people. At my coffee shop, people just thank the staff on their way out instead."). A question like this is something to answer, not a word to save: don\'t call add_to_stack for it unless they asked how to say a word. Only after you have said it, call back_to_conversation and say nothing more. When it returns, ask the question again in Japanese.',
  );
});

test("when it's a bad time, Ping says her goodbye out loud before ending the call, in the call's speech style", () => {
  for (const [formality, goodbye] of [['formal', 'わかりました。また電話しますね！'], ['casual', 'わかった。また電話するね！']]) {
    const instructions = buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: false, settings: { ...DEFAULT_SETTINGS, formality } });
    assert.ok(instructions.includes(`If they say it's not a good time or they're busy, in any language, first say exactly 「${goodbye}」 out loud. Only after you have said it, call end_call, and say nothing more.`), formality);
    // The goodbye is the same line the phone listens for to hang up, so a call never stays open after it.
    assert.equal(NOT_NOW_GOODBYES[formality], goodbye);
  }
  // When the learner called, there's no "is now a good time?", so no such line.
  assert.ok(!/not a good time/.test(buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: true })));
});

test("Sunday's visit home is a story a beginner can follow: Mom made her favorite dish", () => {
  const sunday = pingsDay({ localDate: { year: 2026, month: 11, day: 22 }, localHour: 23 }).today;
  assert.deepEqual(sunday.map((part) => part.plan), ['take the train home to Kanagawa', 'have lunch with your parents', 'come back to Setagaya', 'get ready for the new week']);
  assert.equal(sunday[1].happened, 'your mom made your favorite dish');
  assert.ok(!/dad|sociology degree/.test(JSON.stringify(sunday)));
  // The rest of the visit-home story is unchanged.
  assert.match(JSON.stringify(PING_DAYS), /reply to your mom, who asked if you can come home to Kanagawa this Sunday/);
  assert.match(JSON.stringify(PING_DAYS), /pack a small bag for tomorrow's trip home to Kanagawa/);
});

test("custom contacts also say their goodbye out loud before ending the call, in the call's speech style", () => {
  for (const [formality, goodbye] of [['formal', 'わかりました。また電話しますね！'], ['casual', 'わかった。また電話するね！']]) {
    const custom = buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: false, contact: YUKI, settings: { ...DEFAULT_SETTINGS, formality } });
    const line = custom.split('\n').find((text) => text.startsWith("If they say it's not a good time"));
    assert.equal(line, `If they say it's not a good time or they're busy, in any language, first say exactly 「${goodbye}」 out loud. Only after you have said it, call end_call, and say nothing more.`, formality);
    // The goodbye comes before the tool, and nothing is said after it.
    assert.ok(line.indexOf(goodbye) < line.indexOf('call end_call'), formality);
    assert.match(line, /call end_call, and say nothing more\.$/);
    // It's the same line Ping uses, and the one the phone listens for to hang up.
    const ping = buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: false, settings: { ...DEFAULT_SETTINGS, formality } });
    assert.ok(ping.includes(line), formality);
    assert.equal(NOT_NOW_GOODBYES[formality], goodbye);
  }
  // A custom contact the learner called has no bad-time question, so no such line.
  assert.ok(!/not a good time/.test(buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: true, contact: YUKI })));
});

test("custom contacts keep everything else: their own identity, life, off-topic line and Ping-free instructions", () => {
  const custom = buildInstructions({ question: QUESTIONS[0], localHour: 12, calledBack: false, contact: YUKI });
  assert.match(custom, /^You are Yuki, a warm Japanese friend/);
  assert.match(custom, /You are a friend who loves cooking\./);
  assert.match(custom, /say exactly 「ちょっとわかりません。」 Then ask the question again in Japanese\./);
  assert.match(custom, /ask one simple open-ended question in Japanese about your topic\./);
  assert.ok(!/WHO YOU ARE|タロウ|こもれび|WHEN THEY SAY THEY DON'T UNDERSTAND/.test(custom));
});
