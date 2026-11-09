import test from 'node:test';
import assert from 'node:assert/strict';
import { initialTurnState, onBlock, onVerdict, shouldFallBack, SLOW_DECISION_MS, TURN, VERY_SLOW_DECISION_MS } from '../public/turn-machine.js';

const SPEECH = 0.9;
const QUIET = 0.05;
const UNSURE = 0.42; // between Silero's two thresholds

// Feeds blocks of speech probability, 32 ms apart, and collects every action.
function run(probabilities, { state = initialTurnState(), startAt = 0 } = {}) {
  const actions = [];
  let at = startAt;
  for (const speech of probabilities) {
    at += TURN.blockMs;
    const result = onBlock(state, { speech, at });
    state = result.state;
    actions.push(...result.actions);
  }
  return { state, actions, at };
}

const blocks = (count, speech) => Array(count).fill(speech);
const quietBlocksFor = (ms) => Math.ceil(ms / TURN.blockMs);

test('a click too short to be speech does not start a turn', () => {
  const { state, actions } = run([SPEECH, SPEECH, QUIET, SPEECH, QUIET]);
  assert.equal(state.inTurn, false);
  assert.deepEqual(actions, []);
});

test('about 0.1 s of speech starts a turn, timed from when the speech began', () => {
  const { state, actions } = run([QUIET, ...blocks(TURN.startBlocks, SPEECH)]);
  assert.equal(state.inTurn, true);
  assert.deepEqual(actions, [{ type: 'speech-start', at: TURN.blockMs }]);
});

test('after 0.2 s of quiet Smart Turn is asked once, and "done" ends the turn', () => {
  const talking = run(blocks(10, SPEECH));
  const pause = run(blocks(quietBlocksFor(TURN.askAfterQuietMs) + 3, QUIET), { state: talking.state, startAt: talking.at });
  assert.deepEqual(pause.actions, [{ type: 'ask', pause: 1 }]);
  const verdict = onVerdict(pause.state, { pause: 1, probability: 0.8, at: 999 });
  assert.deepEqual(verdict.actions, [{ type: 'end-turn', reason: 'smartTurn', at: 999, quietSince: talking.at }]);
  assert.equal(verdict.state.inTurn, false);
});

test('"still thinking" keeps waiting, until the backup ends the turn after 2.5 s of quiet', () => {
  const talking = run(blocks(10, SPEECH));
  const asked = run(blocks(quietBlocksFor(TURN.askAfterQuietMs), QUIET), { state: talking.state, startAt: talking.at });
  const thinking = onVerdict(asked.state, { pause: 1, probability: 0.1, at: 0 });
  assert.deepEqual(thinking.actions, []);
  const rest = run(blocks(quietBlocksFor(TURN.backupMs), QUIET), { state: thinking.state, startAt: asked.at });
  assert.deepEqual(rest.actions.at(-1), { type: 'end-turn', reason: 'backup', at: rest.actions.at(-1).at, quietSince: talking.at });
  assert.ok(rest.actions.at(-1).at - talking.at >= TURN.backupMs);
  assert.equal(rest.state.inTurn, false);
});

test('a verdict that arrives after the user started talking again is ignored', () => {
  const talking = run(blocks(10, SPEECH));
  const asked = run(blocks(quietBlocksFor(TURN.askAfterQuietMs), QUIET), { state: talking.state, startAt: talking.at });
  const resumed = run([SPEECH], { state: asked.state, startAt: asked.at });
  assert.deepEqual(onVerdict(resumed.state, { pause: 1, probability: 0.99, at: 0 }).actions, []);
  // The next pause is asked about afresh.
  const again = run(blocks(quietBlocksFor(TURN.askAfterQuietMs), QUIET), { state: resumed.state, startAt: resumed.at });
  assert.deepEqual(again.actions, [{ type: 'ask', pause: 2 }]);
});

test('a late verdict about an earlier turn can never end a new one', () => {
  const first = run([...blocks(10, SPEECH), ...blocks(quietBlocksFor(TURN.backupMs), QUIET)]);
  assert.equal(first.actions.at(-1).reason, 'backup');
  const second = run([...blocks(10, SPEECH), ...blocks(quietBlocksFor(TURN.askAfterQuietMs), QUIET)], { state: first.state, startAt: first.at });
  assert.deepEqual(second.actions.at(-1), { type: 'ask', pause: 2 });
  assert.deepEqual(onVerdict(second.state, { pause: 1, probability: 0.99, at: 0 }).actions, []);
});

test('audio between the two thresholds neither counts as quiet nor as talking again', () => {
  const talking = run(blocks(10, SPEECH));
  const unsure = run(blocks(quietBlocksFor(TURN.backupMs) + 5, UNSURE), { state: talking.state, startAt: talking.at });
  assert.deepEqual(unsure.actions, []);
  assert.equal(unsure.state.inTurn, true);
});

test('the call goes back to silence mode if Smart Turn fails to load or is too slow', () => {
  assert.equal(shouldFallBack({ loadFailed: true }), true);
  assert.equal(shouldFallBack({ decisionMs: [230, 250, SLOW_DECISION_MS + 1] }), false, 'one slow decision can be a hiccup');
  assert.equal(shouldFallBack({ decisionMs: [SLOW_DECISION_MS + 1, 240, SLOW_DECISION_MS + 50] }), true);
  assert.equal(shouldFallBack({ decisionMs: [VERY_SLOW_DECISION_MS + 1] }), true);
  assert.equal(shouldFallBack({ decisionMs: [] }), false);
});
