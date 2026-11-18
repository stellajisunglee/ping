import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CallEngine } from '../server/calls.js';
import { PING } from '../server/contacts.js';
import { agentSettings } from '../server/deepgram.js';
import { scenarioById, SCENARIOS } from '../server/scenarios.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { Store } from '../server/store.js';
import { buildInstructions, buildSession, QUESTIONS, questionById } from '../server/tutor.js';

const SUBSCRIPTION = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };

// The same made-up random numbers for every engine, so two engines given the same steps pick the same questions.
function seeded() {
  let seed = 7;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function setup(role = 'admin') {
  const engine = new CallEngine({ store: new Store(), sendPush: async () => ({ gone: false }), random: seeded() });
  const { user } = engine.register('Asia/Tokyo', role);
  return { engine, user };
}

const questionsOf = (engine, user, count) => Array.from({ length: count }, () => engine.callBack(user).questionId);

// Everything in a scenario that's meant for the admin, never for the voice engine.
const adminText = (scenario) => [scenario.name, scenario.focus, scenario.example, scenario.note, ...scenario.actions, ...scenario.checkpoints.map((checkpoint) => checkpoint.text)].filter(Boolean);

test('each scenario has a stable, unique id, a real opening question and checkpoints with unique ids', () => {
  assert.deepEqual(
    SCENARIOS.map((scenario) => [scenario.id, scenario.questionId]),
    [
      ['weekend-plans', 'weekend'],
      ['daily-life', 'did'],
      ['vocabulary-help', 'day'],
      ['recent-activities', 'lately'],
    ],
  );
  for (const scenario of SCENARIOS) {
    assert.match(scenario.id, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(QUESTIONS.some((question) => question.id === scenario.questionId), `${scenario.id} opens with one of Ping's questions`);
    const ids = scenario.checkpoints.map((checkpoint) => checkpoint.id);
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(scenarioById(scenario.id), scenario);
  }
  assert.equal(scenarioById('made-up'), null);
});

test('randomized topics pick questions exactly as before, and controlled calls in between leave them alone', () => {
  const untouched = setup();
  const switchedBack = setup();
  const testedInBetween = setup();
  untouched.engine.callBack(untouched.user);
  switchedBack.engine.callBack(switchedBack.user);
  testedInBetween.engine.callBack(testedInBetween.user);
  const lastBefore = testedInBetween.user.lastQuestionId;

  assert.ok(switchedBack.engine.setTopicSetup(switchedBack.user, { topicMode: 'controlled', scenarioId: 'daily-life' }));
  assert.ok(switchedBack.engine.setTopicSetup(switchedBack.user, { topicMode: 'randomized' }));
  testedInBetween.engine.setTopicSetup(testedInBetween.user, { topicMode: 'controlled', scenarioId: 'weekend-plans' });
  assert.deepEqual(questionsOf(testedInBetween.engine, testedInBetween.user, 3), ['weekend', 'weekend', 'weekend']);
  assert.equal(testedInBetween.user.lastQuestionId, lastBefore, 'a controlled call is not remembered as the last random question');
  testedInBetween.engine.setTopicSetup(testedInBetween.user, { topicMode: 'randomized' });

  const expected = questionsOf(untouched.engine, untouched.user, 8);
  assert.deepEqual(questionsOf(switchedBack.engine, switchedBack.user, 8), expected);
  assert.deepEqual(questionsOf(testedInBetween.engine, testedInBetween.user, 8), expected);
  assert.ok(expected.every((id, index) => index === 0 || id !== expected[index - 1]), 'never the same question twice in a row');
  assert.ok(Object.values(untouched.engine.store.calls).every((call) => call.topicMode === 'randomized' && call.scenarioId === null));
});

test("controlled topics give every call the scenario's question, on scheduled calls and calls back alike", async () => {
  const { engine, user } = setup();
  for (const scenario of SCENARIOS) {
    engine.setTopicSetup(user, { topicMode: 'controlled', scenarioId: scenario.id });
    const call = engine.callBack(user);
    assert.deepEqual([call.questionId, call.topicMode, call.scenarioId], [scenario.questionId, 'controlled', scenario.id]);
  }
  engine.setTopicSetup(user, { scenarioId: 'recent-activities' });
  engine.setSubscription(user, SUBSCRIPTION);
  for (const call of Object.values(engine.store.calls)) call.state = 'ended';
  engine.now = () => user.nextCallAt;
  await engine.tick();
  const ring = Object.values(engine.store.calls).find((call) => call.direction === 'incoming');
  assert.deepEqual([ring.questionId, ring.topicMode, ring.scenarioId], ['lately', 'controlled', 'recent-activities']);
});

test('switching to controlled starts on the first scenario, and unknown modes or scenarios change nothing', () => {
  const { engine, user } = setup();
  assert.deepEqual([user.topicMode, user.scenarioId], ['randomized', null]);
  assert.equal(engine.setTopicSetup(user, { topicMode: 'controlled' }), true);
  assert.deepEqual([user.topicMode, user.scenarioId], ['controlled', SCENARIOS[0].id]);
  assert.equal(engine.setTopicSetup(user, { topicMode: 'scripted' }), false);
  assert.equal(engine.setTopicSetup(user, { scenarioId: 'made-up' }), false);
  assert.deepEqual([user.topicMode, user.scenarioId], ['controlled', SCENARIOS[0].id]);
  assert.equal(engine.setTopicSetup(user, { topicMode: 'randomized' }), true);
  assert.deepEqual([user.topicMode, user.scenarioId], ['randomized', SCENARIOS[0].id], 'the scenario is kept for next time');
});

test("a non-admin's account can't run a controlled call, even if its record somehow says controlled", () => {
  const { engine, user } = setup('beta');
  Object.assign(user, { topicMode: 'controlled', scenarioId: 'daily-life' });
  const call = engine.callBack(user);
  assert.deepEqual([call.topicMode, call.scenarioId], ['randomized', null]);
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'interrupt-handled', result: 'pass' }), null);
  assert.deepEqual(engine.store.scenarioChecks, []);
});

test('the topic and the engine are set separately, and neither changes the other', () => {
  const { engine, user } = setup();
  engine.setCallSetup(user, { manual: true, engine: 'deepgram-agent' });
  engine.setTopicSetup(user, { topicMode: 'controlled', scenarioId: 'weekend-plans' });
  assert.deepEqual([user.callSetupManual, user.engine], [true, 'deepgram-agent']);
  engine.setCallSetup(user, { manual: true, engine: 'gpt-realtime', turnMode: 'semantic' });
  assert.deepEqual([user.topicMode, user.scenarioId], ['controlled', 'weekend-plans']);

  const manual = engine.callBack(user);
  engine.sessionDetails(user, manual.id);
  assert.deepEqual([manual.engine, manual.turnMode, manual.assigned, manual.questionId], ['gpt-realtime', 'semantic', 'manual', 'weekend']);

  // Randomized engines still balance per person on controlled calls, the same as on any other call.
  engine.setCallSetup(user, { manual: false });
  const assigned = Array.from({ length: 4 }, () => {
    const call = engine.callBack(user);
    engine.sessionDetails(user, call.id);
    return [call.assigned, call.questionId];
  });
  assert.ok(assigned.every(([how, question]) => how === 'random' && question === 'weekend'));
  assert.deepEqual(Object.values(user.comboCounts), [1, 1, 1, 1]);
});

test('the call log says which topic mode and scenario each call had', () => {
  const { engine, user } = setup();
  const random = engine.callBack(user);
  engine.sessionDetails(user, random.id);
  engine.setTopicSetup(user, { topicMode: 'controlled', scenarioId: 'vocabulary-help' });
  const controlled = engine.callBack(user);
  engine.sessionDetails(user, controlled.id);
  const entry = (call) => engine.store.callLog.find((item) => item.callId === call.id);
  assert.deepEqual([entry(random).topicMode, entry(random).scenarioId, entry(random).questionId], ['randomized', null, random.questionId]);
  assert.deepEqual([entry(controlled).topicMode, entry(controlled).scenarioId, entry(controlled).questionId], ['controlled', 'vocabulary-help', 'day']);
  assert.equal(entry(controlled).assigned, 'random', 'assigned still says how the engine was chosen');
  assert.ok(Object.values(entry(controlled)).every((value) => value === null || ['number', 'string', 'boolean'].includes(typeof value)));
});

test('checklist results are kept per checkpoint, apart from ratings, and only for real checkpoints and results', () => {
  const { engine, user } = setup();
  engine.setTopicSetup(user, { topicMode: 'controlled', scenarioId: 'daily-life' });
  const call = engine.callBack(user);
  engine.sessionDetails(user, call.id);
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'interrupt-handled', result: 'pass' }), true);
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'interrupt-handled', result: 'unclear' }), true);
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'aizuchi-kept', result: 'fail' }), true);
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'no-repeat', result: 'pass' }), false, "another scenario's checkpoint");
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'aizuchi-kept', result: 'great' }), false);
  assert.deepEqual(
    engine.scenarioChecks().map(({ callId, scenarioId, checkpointId, result }) => [callId, scenarioId, checkpointId, result]),
    [
      [call.id, 'daily-life', 'aizuchi-kept', 'fail'],
      [call.id, 'daily-life', 'interrupt-handled', 'unclear'],
    ],
  );
  assert.equal(engine.saveScenarioCheck(user, call.id, { checkpointId: 'aizuchi-kept', result: null }), true, 'null clears it');
  assert.equal(engine.scenarioChecks().length, 1);
  assert.deepEqual(user.ratings, []);
  assert.equal(engine.store.callLog.find((item) => item.callId === call.id).cutOffs, undefined);

  engine.setTopicSetup(user, { topicMode: 'randomized' });
  const random = engine.callBack(user);
  assert.equal(engine.saveScenarioCheck(user, random.id, { checkpointId: 'aizuchi-kept', result: 'pass' }), null, 'a randomized call has no checklist');
});

test("OpenAI and Deepgram are given the same opening question, and none of the scenario's guidance", () => {
  const context = { settings: DEFAULT_SETTINGS, localHour: 12, localDate: { year: 2026, month: 11, day: 18 }, contact: PING, memories: [] };
  for (const scenario of SCENARIOS) {
    const question = questionById(scenario.questionId);
    for (const calledBack of [true, false]) {
      const openai = buildSession({ model: 'gpt-realtime', voice: 'marin', question, calledBack, ...context });
      const deepgram = agentSettings({ question, calledBack, thinkModel: 'gpt-4.1-mini', voice: 'aura', ...context });
      assert.ok(openai.instructions.includes(question.japanese));
      assert.ok(deepgram.agent.think.prompt.includes(question.japanese));
      assert.equal(openai.instructions, buildInstructions({ question, calledBack, ...context }), 'the same instructions as any call with this question');
      const sent = JSON.stringify([openai, deepgram]);
      for (const text of adminText(scenario)) assert.ok(!sent.includes(text), `${scenario.id}: "${text}" never reaches the voice engine`);
      assert.ok(!sent.includes(scenario.id));
    }
  }
});

test("nothing that builds what a voice engine is told imports the scenarios", () => {
  for (const file of ['prompt.js', 'tutor.js', 'deepgram.js', 'lines.js', 'persona.js', 'openai.js']) {
    assert.ok(!readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8').includes('scenarios.js'), file);
  }
});

test('the admin call log tells controlled calls from randomized ones, with the checklist tally', async () => {
  const { topicText } = await import('../public/settings.js');
  const checks = [{ result: 'pass' }, { result: 'pass' }, { result: 'unclear' }];
  assert.equal(topicText({ topicMode: 'controlled', scenarioId: 'daily-life' }, checks, SCENARIOS), 'Controlled: Daily Life (2 pass, 1 unclear)');
  assert.equal(topicText({ topicMode: 'controlled', scenarioId: 'weekend-plans' }, [], SCENARIOS), 'Controlled: Weekend Plans');
  assert.equal(topicText({ topicMode: 'randomized', scenarioId: null }), 'Randomized');
  assert.equal(topicText({}), '-', 'entries from before topic modes');
});
