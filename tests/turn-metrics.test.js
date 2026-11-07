import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMetrics, METRIC_FIELDS, SUSPECTED_CUTOFF_WINDOW_MS, summarizeTurns } from '../public/turn-metrics.js';

const SHORT = {
  speechStarted: 'input_audio_buffer.speech_started',
  speechStopped: 'input_audio_buffer.speech_stopped',
  committed: 'input_audio_buffer.committed',
  agentStarted: 'output_audio_buffer.started',
  agentStopped: 'output_audio_buffer.stopped',
  agentCleared: 'output_audio_buffer.cleared',
};

// Builds an event log from [name, time] pairs, so each test reads like a timeline.
const timeline = (...steps) => steps.map(([name, at]) => ({ type: SHORT[name] ?? name, at }));
const summarize = (events) => summarizeTurns(events, { connectedAt: 0, endedAt: 60_000 });

test('reply latency runs from the end of the user turn to the start of the reply', () => {
  const summary = summarize(
    timeline(
      ['speechStopped', 1000], ['committed', 1010], ['agentStarted', 1600], ['agentStopped', 3000],
      ['speechStopped', 5000], ['committed', 5010], ['agentStarted', 5900], ['agentStopped', 7000],
      ['speechStopped', 9000], ['committed', 9010], ['agentStarted', 9300], ['agentStopped', 9900],
    ),
  );
  assert.equal(summary.replyLatencyCount, 3);
  assert.equal(summary.replyLatencyMedianMs, 600);
  assert.equal(summary.replyLatencyP90Ms, 900);
});

test('a user who starts talking again before the reply is still on the same turn', () => {
  const summary = summarize(timeline(['speechStopped', 1000], ['speechStarted', 1400], ['speechStopped', 3000], ['agentStarted', 3500]));
  assert.equal(summary.replyLatencyCount, 1);
  assert.equal(summary.replyLatencyMedianMs, 500);
});

test('the greeting has no latency, and a call with no replies has none at all', () => {
  const summary = summarize(timeline(['agentStarted', 200], ['agentStopped', 2000]));
  assert.equal(summary.replyLatencyCount, 0);
  assert.equal(summary.replyLatencyMedianMs, null);
  assert.equal(summary.replyLatencyP90Ms, null);
});

test('talking soon after Ping starts counts as a suspected cut-off, at most once per reply', () => {
  const summary = summarize(
    timeline(
      ['agentStarted', 0], ['speechStarted', 1200], ['speechStarted', 1300], ['agentCleared', 1400],
      ['agentStarted', 5000], ['speechStarted', 5000 + SUSPECTED_CUTOFF_WINDOW_MS], ['agentCleared', 6600],
      ['agentStarted', 10_000], ['speechStarted', 10_000 + SUSPECTED_CUTOFF_WINDOW_MS + 1], ['agentStopped', 12_000],
    ),
  );
  assert.equal(summary.suspectedCutoffs, 2);
});

test('talking after Ping has finished is not a cut-off', () => {
  const summary = summarize(timeline(['agentStarted', 0], ['agentStopped', 500], ['speechStarted', 900]));
  assert.equal(summary.suspectedCutoffs, 0);
});

test('only audio cleared after the user spoke counts as a barge-in', () => {
  const summary = summarize(
    timeline(
      ['agentStarted', 0], ['speechStarted', 3000], ['agentCleared', 3100],
      ['agentStarted', 6000], ['agentCleared', 6500],
      ['agentStarted', 9000], ['agentStopped', 11_000],
    ),
  );
  assert.equal(summary.bargeIns, 1);
});

test('turns and call length are counted, and the summary holds exactly the known fields', () => {
  const summary = summarizeTurns(timeline(['agentStarted', 100], ['committed', 4000], ['agentStarted', 5000], ['committed', 9000]), {
    connectedAt: 0,
    endedAt: 61_600,
  });
  assert.deepEqual([summary.userTurns, summary.agentTurns, summary.callSeconds, summary.ignoredAizuchi], [2, 2, 62, 0]);
  assert.deepEqual(Object.keys(summary), METRIC_FIELDS);
  assert.ok(Object.values(summary).every((value) => value === null || typeof value === 'number'));
});

test('a call that never connected has no length', () => {
  assert.equal(summarizeTurns([], { endedAt: 5000 }).callSeconds, 0);
});

test('metrics are only accepted as the known fields, all whole numbers', () => {
  const good = summarize(timeline(['speechStopped', 1000], ['agentStarted', 1600]));
  assert.deepEqual(cleanMetrics(good), good);
  assert.deepEqual(cleanMetrics({ ...good, replyLatencyMedianMs: null, replyLatencyP90Ms: null }), { ...good, replyLatencyMedianMs: null, replyLatencyP90Ms: null });

  const { bargeIns, ...missing } = good;
  for (const bad of [
    null,
    [],
    'numbers',
    missing,
    { ...good, transcript: 1 },
    { ...good, bargeIns: '1' },
    { ...good, bargeIns: -1 },
    { ...good, bargeIns: 1.5 },
    { ...good, bargeIns: null },
    { ...good, callSeconds: 1e12 },
  ]) {
    assert.equal(cleanMetrics(bad), null, JSON.stringify(bad));
  }
});
