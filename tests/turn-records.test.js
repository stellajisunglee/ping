import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTurnData, helpTypes, TURN_FIELDS, turnRecords } from '../public/turn-records.js';

const SHORT = {
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  agentStarted: 'output_audio_buffer.started',
  agentStopped: 'output_audio_buffer.stopped',
  agentCleared: 'output_audio_buffer.cleared',
};
const timeline = (...steps) => steps.map(([name, at, extra = {}]) => ({ type: SHORT[name] ?? name, at, ...extra }));

test('each reply gets its own record: the wait, the gap, how long each side spoke, and when the learner started', () => {
  const { turns } = turnRecords(
    timeline(
      ['agentStarted', 1000], ['agentStopped', 4000], // the greeting
      ['speechStarted', 5500], ['speechStopped', 9300], // 1.5 s to start answering
      ['agentStarted', 10_000], ['agentStopped', 12_000],
    ),
    { connectedAt: 0 },
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(Object.keys(turns[1]), TURN_FIELDS);
  assert.deepEqual(
    [turns[0].index, turns[0].atMs, turns[0].replyMs, turns[0].endedBy],
    [0, 1000, 3000, null],
    'the greeting has nothing before it',
  );
  assert.deepEqual(
    [turns[1].atMs, turns[1].answerStartMs, turns[1].userSpeechMs, turns[1].gapMs, turns[1].endedBy, turns[1].cutOff, turns[1].talkedOver],
    [10_000, 1500, 3800, 700, 'vad', false, false],
  );
});

test('Smart Turn knows when the learner went quiet, and says whether it or the backup ended the turn', () => {
  const { turns } = turnRecords(
    timeline(
      ['agentStarted', 0], ['agentStopped', 2000],
      ['speechStarted', 3000], ['smart-turn-end', 6200, { quietSince: 5000, reason: 'backup' }],
      ['agentStarted', 6600], ['agentStopped', 8000],
    ),
    { connectedAt: 0 },
  );
  assert.deepEqual([turns[1].endWaitMs, turns[1].gapMs, turns[1].userSpeechMs, turns[1].endedBy], [1200, 1600, 2000, 'backup']);
});

test('a reply the learner cut into right away, and one they talked over, are marked', () => {
  const { turns } = turnRecords(
    timeline(
      ['agentStarted', 0], ['speechStarted', 900], ['agentCleared', 1100], ['speechStopped', 3000], // cut in within 1.5 s
      ['agentStarted', 4000], ['speechStarted', 6000], ['aizuchi', 6100], ['agentStopped', 7000],
    ),
    { connectedAt: 0 },
  );
  assert.deepEqual([turns[0].cutOff, turns[0].talkedOver], [true, true]);
  assert.deepEqual([turns[1].cutOff, turns[1].talkedOver, turns[1].aizuchi], [false, false, 1]);
});

test("on Deepgram, Flux ends turns and each reply carries Deepgram's own latency", () => {
  const { turns } = turnRecords(
    timeline(
      ['agentStarted', 0], ['agentStopped', 1000],
      ['speechStarted', 2000], ['speechStopped', 4000],
      ['provider-latency', 4900, { totalMs: 880, source: 'LatencyReport' }], ['agentStarted', 5000], ['agentStopped', 6000],
    ),
    { connectedAt: 0, engine: 'deepgram-agent' },
  );
  assert.deepEqual([turns[1].endedBy, turns[1].providerLatencyMs], ['flux', 880]);
});

test('each tool call is a kind of help, and asking for easier Japanese is told apart from harder', () => {
  assert.deepEqual(helpTypes('add_to_stack', { kana: 'さんぽ' }), ['lookup']);
  assert.deepEqual(helpTypes('back_to_conversation'), ['culture-question']);
  assert.deepEqual(helpTypes('update_settings', { speedChange: 'much_slower', thinkingTime: 'long' }), ['slower', 'more-time']);
  assert.deepEqual(helpTypes('update_settings', { proficiency: 'N5' }, 'N4'), ['easier']);
  assert.deepEqual(helpTypes('update_settings', { proficiency: 'N3' }, 'N4'), ['harder']);
  assert.deepEqual(helpTypes('update_settings', { callsEnabled: false }), ['stop-calls']);
  const { help } = turnRecords(
    timeline(['agentStarted', 0], ['agentStopped', 1000], ['tool', 2000, { name: 'add_to_stack', args: {} }], ['agentStarted', 3000], ['tool', 4000, { name: 'update_settings', args: { speedChange: 'slower' } }]),
    { connectedAt: 0 },
  );
  assert.deepEqual(help, [{ type: 'lookup', atMs: 2000, turn: 0 }, { type: 'slower', atMs: 4000, turn: 1 }]);
});

test('turn records must be the known fields, in order, as numbers and known types', () => {
  const good = turnRecords(timeline(['agentStarted', 0], ['agentStopped', 1000], ['speechStarted', 1500], ['speechStopped', 2500], ['agentStarted', 3000]), { connectedAt: 0 });
  assert.deepEqual(cleanTurnData(good), good);
  const bad = [
    { ...good, turns: [{ ...good.turns[0], words: 'こんにちは' }] },
    { ...good, turns: [{ ...good.turns[0], index: 3 }] },
    { ...good, turns: [{ ...good.turns[0], gapMs: -5 }] },
    { ...good, turns: [{ ...good.turns[0], endedBy: 'guess' }] },
    { ...good, help: [{ type: 'free-text', atMs: 0, turn: 0 }] },
    { turns: good.turns },
    null,
  ];
  for (const body of bad) assert.equal(cleanTurnData(body), null, JSON.stringify(body)?.slice(0, 80));
});
