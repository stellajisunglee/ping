import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CHECK_TYPES, runChecks, sentenceCount, usesEnglish } from '../evals/checks.js';
import { agreement, parseLabels } from '../evals/agreement.js';
import { cleanVerdicts, formatTranscript, judgeUserMessage, verdictSchema } from '../evals/judge-prompt.js';
import { runScenario, scenarioSession } from '../evals/ping-engine.js';
import { summarize, toMarkdown } from '../evals/summarize.js';
import { QUESTIONS } from '../server/tutor.js';
import { FORMALITY_LEVELS, PROFICIENCY_LEVELS } from '../server/settings.js';

const scenarios = JSON.parse(readFileSync(new URL('../evals/scenarios.json', import.meta.url)));
const rubric = JSON.parse(readFileSync(new URL('../evals/rubric.json', import.meta.url)));

const transcript = [
  { turn: 0, from: 'ping', text: 'こんにちは！週末は何をしますか？', tools: [] },
  { turn: 1, from: 'learner', text: '「予定」ってどういう意味？', tools: [] },
  { turn: 1, from: 'ping', text: '"Yotei" means plans or schedule.', tools: [{ name: 'add_to_stack', args: { kanji: '予定' } }] },
  { turn: 1, from: 'ping', text: '週末の予定は何ですか？', tools: [] },
];

test('every scenario is well formed: unique ids, real questions and settings, known checks', () => {
  const ids = scenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const scenario of scenarios) {
    assert.ok(QUESTIONS.some((question) => question.id === scenario.question), scenario.id);
    assert.ok(scenario.turns.length && scenario.expect && scenario.title, scenario.id);
    if (scenario.settings?.proficiency) assert.ok(PROFICIENCY_LEVELS.includes(scenario.settings.proficiency));
    if (scenario.settings?.formality) assert.ok(FORMALITY_LEVELS.includes(scenario.settings.formality));
    for (const check of scenario.checks ?? []) {
      assert.ok(CHECK_TYPES.includes(check.type), `${scenario.id}: ${check.type}`);
      if (check.turn !== undefined) assert.ok(check.turn <= scenario.turns.length, `${scenario.id}: turn ${check.turn}`);
    }
  }
  assert.deepEqual(rubric.map((item) => item.id), ['expectation', 'level', 'brevity', 'warmth', 'noLoop', 'register']);
});

test('English and sentence counting', () => {
  assert.equal(usesEnglish('Pingです。'), false);
  assert.equal(usesEnglish('"Yotei" means plans.'), true);
  assert.equal(sentenceCount('こんにちは！元気ですか？今日は暑いですね。'), 3);
  assert.equal(sentenceCount('It means plans. Try again!'), 2);
});

test('the code checks score tools, language, length and repeats', () => {
  const results = runChecks(
    [
      { type: 'calledTool', name: 'add_to_stack', turn: 1 },
      { type: 'didNotCallTool', name: 'end_call', turn: 1 },
      { type: 'usesEnglish', turn: 1 },
      { type: 'endsInJapanese', turn: 1 },
      { type: 'noEnglish', turn: 1 },
      { type: 'maxSentences', max: 1, turn: 1 },
      { type: 'noRepeat' },
      { type: 'madeUp' },
    ],
    transcript,
  );
  assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, false, true, true, false]);
  const mixed = [{ turn: 1, from: 'ping', text: '"予定" means "plan".\n\n週末の予定は何ですか？', tools: [] }];
  assert.equal(runChecks([{ type: 'endsInJapanese', turn: 1 }], mixed)[0].ok, true);
  const repeated = [...transcript, { turn: 2, from: 'ping', text: '週末の予定は何ですか？', tools: [] }];
  assert.equal(runChecks([{ type: 'noRepeat' }], repeated)[0].ok, false);
});

test('the judge sees the scenario, the learner settings, the conversation with tool calls, and the rubric', () => {
  const result = { transcript, settings: { proficiency: 'beginner', formality: 'formal' } };
  const message = judgeUserMessage(scenarios[0], result, rubric);
  assert.match(message, /Level: beginner\. Speech style requested: formal\./);
  assert.match(message, /\[tool: add_to_stack \{"kanji":"予定"\}\]/);
  assert.match(message, /- noLoop:/);
  assert.match(formatTranscript(transcript), /^Ping: こんにちは/);
  const schema = verdictSchema(rubric);
  assert.deepEqual(schema.properties.items.items.properties.id.enum, rubric.map((item) => item.id));
  assert.equal(schema.additionalProperties, false);
});

test("the judge's answer keeps one verdict per rubric item, in order, and marks gaps as unscored", () => {
  const verdicts = cleanVerdicts({ items: [{ id: 'warmth', verdict: 'fail', reason: 'cold' }, { id: 'level', verdict: 'maybe', reason: '?' }, { id: 'made-up', verdict: 'pass', reason: '' }] }, rubric);
  assert.deepEqual(verdicts.map((item) => item.id), rubric.map((item) => item.id));
  assert.deepEqual(verdicts.find((item) => item.id === 'warmth'), { id: 'warmth', verdict: 'fail', reason: 'cold' });
  assert.equal(verdicts.find((item) => item.id === 'level').verdict, null);
  assert.ok(cleanVerdicts(null, rubric).every((item) => item.verdict === null));
});

test('agreement with hand labels: overall, per item, kappa, and the disagreements', () => {
  const run = {
    scenarios: [
      { id: 'a', judge: { items: [{ id: 'warmth', verdict: 'pass', reason: '' }, { id: 'level', verdict: 'pass', reason: '' }] } },
      { id: 'b', judge: { items: [{ id: 'warmth', verdict: 'fail', reason: 'lectured' }, { id: 'level', verdict: null, reason: 'not scored' }] } },
    ],
  };
  const labels = parseLabels('scenario,item,label\na,warmth,pass\na,level,fail\nb,warmth,fail\nb,level,pass\n');
  const result = agreement(run, labels);
  assert.equal(result.compared, 3); // the unscored item is skipped
  assert.equal(result.agreement, 0.67);
  assert.deepEqual(result.byItem.warmth, { compared: 2, agreed: 2, agreement: 1 });
  assert.deepEqual(result.disagreements.map((miss) => [miss.scenario, miss.item, miss.judge, miss.you]), [['a', 'level', 'pass', 'fail']]);
  assert.equal(typeof result.kappa, 'number');
  assert.equal(agreement(run, []).agreement, null);
});

test("a scenario's session is Ping's real instructions and tools, in text, with its settings", () => {
  const { session, settings } = scenarioSession({ question: 'eat', settings: { formality: 'casual' } }, 'gpt-realtime');
  assert.deepEqual(session.output_modalities, ['text']);
  assert.equal(session.type, 'realtime');
  assert.ok(session.tools.some((tool) => tool.name === 'add_to_stack'));
  assert.match(session.instructions, /食べた/);
  assert.equal(settings.formality, 'casual');
  assert.equal(settings.proficiency, 'beginner');
  assert.match(session.instructions, /折り返してくれて/, 'the learner started the call, so Ping goes straight to the question');
  assert.match(scenarioSession({ question: 'eat', incoming: true }, 'gpt-realtime').session.instructions, /お時間大丈夫ですか/);
});

// A stand-in for OpenAI's Realtime connection that replies with scripted outputs.
function fakeSocket(replies) {
  const sent = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      setTimeout(() => {
        this.onopen?.();
        this.emit({ type: 'session.created' });
      });
    }
    emit(event) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(event) }));
    }
    send(text) {
      const event = JSON.parse(text);
      sent.push(event);
      if (event.type === 'session.update') this.emit({ type: 'session.updated' });
      if (event.type === 'response.create') this.emit({ type: 'response.done', response: { output: replies.shift() ?? [] } });
    }
    close() {}
  }
  return { FakeSocket, sent };
}

const say = (text) => ({ type: 'message', content: [{ type: 'output_text', text }] });
const callTool = (name, args = {}) => ({ type: 'function_call', name, call_id: `call-${name}`, arguments: JSON.stringify(args) });

test('playing a scenario: Ping greets, each learner line gets a reply, and tool calls are answered like the app', async () => {
  const { FakeSocket, sent } = fakeSocket([
    [say('こんにちは！週末は何をしますか？')],
    [callTool('update_settings', { speedChange: 'slower' })],
    [say('Sure, slower now.'), say('週末は何をしますか？')],
    [say('またね！'), callTool('end_call')],
  ]);
  const scenario = { question: 'weekend', turns: ['Slower please', 'Bye!', 'never sent'] };
  const result = await runScenario(scenario, { apiKey: 'test', WebSocketClass: FakeSocket });
  assert.equal(result.error, null);
  assert.deepEqual(
    result.transcript.map((line) => [line.turn, line.from, line.text, line.tools.map((tool) => tool.name).join()]),
    [
      [0, 'ping', 'こんにちは！週末は何をしますか？', ''],
      [1, 'learner', 'Slower please', ''],
      [1, 'ping', '', 'update_settings'],
      [1, 'ping', 'Sure, slower now.', ''],
      [1, 'ping', '週末は何をしますか？', ''],
      [2, 'learner', 'Bye!', ''],
      [2, 'ping', 'またね！', 'end_call'],
    ],
  );
  assert.equal(result.settings.speed, 0.85);
  const output = sent.find((event) => event.item?.type === 'function_call_output');
  assert.equal(JSON.parse(output.item.output).settings.speed, 0.85);
  assert.equal(sent.filter((event) => event.item?.role === 'user').length, 2, 'stops after Ping ends the call');
});

test('a saved word that Ping already explained needs no second reply, and errors are reported', async () => {
  const { FakeSocket, sent } = fakeSocket([[say('こんにちは')], [say('It means plans.'), callTool('add_to_stack', { kanji: '予定' })]]);
  const result = await runScenario({ question: 'weekend', turns: ['予定って？'] }, { apiKey: 'test', WebSocketClass: FakeSocket });
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 2);
  assert.equal(result.transcript.at(-1).tools[0].name, 'add_to_stack');

  class FailingSocket extends FakeSocket {
    send(text) {
      if (JSON.parse(text).type === 'session.update') return this.emit({ type: 'error', error: { code: 'invalid_value', message: 'bad session' } });
      super.send(text);
    }
  }
  const failed = await runScenario({ question: 'weekend', turns: [] }, { apiKey: 'test', WebSocketClass: FailingSocket });
  assert.match(failed.error, /invalid_value: bad session/);
});

test('several runs add up per scenario and rubric item, with errors counted', () => {
  const ids = ['warmth', 'noLoop'];
  const played = (warmth, ok, judgeError = null) => ({
    commit: 'abc',
    scenarios: [{ id: 'goodbye', checks: [{ ok }], error: null, judge: { error: judgeError, items: [{ id: 'warmth', verdict: warmth }, { id: 'noLoop', verdict: 'na' }] } }],
  });
  const summary = summarize([played('pass', true), played('fail', false), played(null, true, 'rate limited')], ids);
  assert.deepEqual(summary.checks, { passed: 2, total: 3 });
  assert.deepEqual(summary.scenarios[0].items.warmth, { pass: 1, fail: 1, runs: 3 });
  assert.deepEqual(summary.totals.warmth, { pass: 1, fail: 1, na: 0, unscored: 1 });
  assert.deepEqual(summary.errors, { play: 0, judge: 1 });
  assert.match(toMarkdown(summary, ids), /\| goodbye \| 2\/3 \| \*\*1\/3 fail\*\* \| na \|/);
});

test('the baseline runs are complete and add up', () => {
  const ids = rubric.map((item) => item.id);
  const dir = new URL('../evals/baseline/', import.meta.url);
  const runs = readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(new URL(file, dir))));
  assert.equal(runs.length, 3);
  const summary = summarize(runs, ids);
  // The baseline is a fixed record. New scenarios come later, but none it scored may disappear.
  for (const run of runs) assert.equal(run.scenarios.length, summary.scenarios.length, 'every run played every scenario');
  for (const { id } of summary.scenarios) assert.ok(scenarios.some((scenario) => scenario.id === id), id);
  assert.deepEqual(summary.errors, { play: 0, judge: 0 });
});

test('a sentence said again inside a later reply is caught, but not a new one or the greeting turn', () => {
  const repaired = (text) => [
    { turn: 0, from: 'ping', text: 'もしもし、ピンです！最近、どうですか？', tools: [] },
    { turn: 1, from: 'learner', text: 'Sorry, I don\'t understand.', tools: [] },
    { turn: 1, from: 'ping', text, tools: [] },
  ];
  const check = (text, options = {}) => runChecks([{ type: 'noRepeatedSentence', ...options }], repaired(text))[0];
  assert.equal(check('I asked how you have been.\n\n最近、どうですか？').ok, false);
  assert.match(check('I asked how you have been.\n\n最近、どうですか？').detail, /最近どうですか/);
  assert.equal(check('I asked how you have been.\n\n今週は忙しいですか？').ok, true);
  // Short words like はい said twice aren't a repeated question.
  assert.equal(check('はい！今週は忙しいですか？').ok, true);
  assert.equal(check('最近、どうですか？', { turn: 2 }).ok, true, 'only from the given turn on');
});

test('mentionsAny passes when Ping says one of the phrases in that turn, whatever the case', () => {
  const said = [
    { turn: 1, from: 'ping', text: 'たとえば「散歩しました。」どうですか？', tools: [] },
    { turn: 2, from: 'learner', text: 'Still nothing...', tools: [] },
    { turn: 2, from: 'ping', text: '一言でも大丈夫ですよ。家ですか？外ですか？', tools: [] },
  ];
  assert.equal(runChecks([{ type: 'mentionsAny', turn: 2, phrases: ['一言', 'one word'] }], said)[0].ok, true);
  assert.equal(runChecks([{ type: 'mentionsAny', turn: 1, phrases: ['一言', 'one word'] }], said)[0].ok, false);
  assert.equal(runChecks([{ type: 'mentionsAny', turn: 2, phrases: ['ONE WORD'] }], [{ turn: 2, from: 'ping', text: 'Just one word is fine!', tools: [] }])[0].ok, true);
});

test('mentionsNone fails when Ping says one of the phrases in that turn', () => {
  const said = [{ turn: 1, from: 'ping', text: '週末に何をするか、聞いていました。たとえば、「家で映画を見ます。」', tools: [] }];
  assert.equal(runChecks([{ type: 'mentionsNone', turn: 1, phrases: ['聞いて', 'I was asking'] }], said)[0].ok, false);
  assert.equal(runChecks([{ type: 'mentionsNone', turn: 1, phrases: ['I was asking'] }], said)[0].ok, true);
  assert.equal(runChecks([{ type: 'mentionsNone', turn: 1, phrases: ['i was asking'] }], [{ turn: 1, from: 'ping', text: 'I was asking about food.', tools: [] }])[0].ok, false);
});
