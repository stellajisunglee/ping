import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMetrics, METRIC_FIELDS, metricsProblems, SUSPECTED_CUTOFF_WINDOW_MS, summarizeTurns } from '../public/turn-metrics.js';

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
    { ...good, userTurns: null }, // only what an engine can't measure may be null
    { ...good, callSeconds: 1e12 },
  ]) {
    assert.equal(cleanMetrics(bad), null, JSON.stringify(bad));
  }
});

test('talking over Ping with aizuchi counts as ignored aizuchi, not a barge-in', () => {
  const summary = summarize(
    timeline(
      ['agentStarted', 0], ['speechStarted', 3000], ['agentCleared', 3000], ['aizuchi', 3800],
      ['agentStarted', 4200], ['speechStarted', 7000], ['agentCleared', 7000],
    ),
  );
  assert.equal(summary.ignoredAizuchi, 1);
  assert.equal(summary.bargeIns, 1);
});

// Real timings from two test calls: [arrival time on the phone, OpenAI audio time].
const turn = (started, stopped, replyAt) => [
  { type: 'input_audio_buffer.speech_started', at: started[0], audioMs: started[1] },
  { type: 'input_audio_buffer.speech_stopped', at: stopped[0], audioMs: stopped[1] },
  { type: 'input_audio_buffer.committed', at: stopped[0] },
  { type: 'output_audio_buffer.started', at: replyAt },
  { type: 'output_audio_buffer.stopped', at: replyAt + 2000 },
];

test('in silence mode, the hidden wait is the silence setting', () => {
  const summary = summarize([
    { type: 'turn-detection', at: 0, silenceMs: 1300, paddingMs: 300 },
    ...turn([9253, 7380], [15256, 13792], 15616),
    ...turn([37868, 36084], [39678, 38208], 40552),
  ]);
  assert.equal(summary.turnEndWaitMedianMs, 1191);
  assert.equal(summary.turnEndWaitP90Ms, 1286);
  assert.equal(summary.replyGapMedianMs, 1551);
  assert.equal(summary.replyGapP90Ms, 2160);
});

test('in semantic mode, a turn that sounded unfinished shows its long hidden wait', () => {
  const summary = summarize([
    { type: 'turn-detection', at: 0, silenceMs: 0, paddingMs: 0 },
    ...turn([10830, 8940], [14411, 13040], 14791),
    ...turn([18528, 16620], [27020, 18340], 27914),
    ...turn([67925, 65996], [78171, 69100], 78566),
  ]);
  assert.equal(summary.turnEndWaitMedianMs, 6772);
  assert.equal(summary.turnEndWaitP90Ms, 7142);
  assert.equal(summary.replyGapMedianMs, 7537);
  assert.equal(summary.replyGapP90Ms, 7666);
  assert.ok(summary.replyLatencyMedianMs < 1000, 'reply latency alone hides the wait');
});

test('the hidden wait is never negative, and is left out when OpenAI sends no audio times', () => {
  const quick = summarize(turn([10830, 8940], [14411, 13040], 14791));
  assert.equal(quick.turnEndWaitMedianMs, 0);
  const noAudioTimes = summarize(timeline(['speechStarted', 0], ['speechStopped', 1000], ['agentStarted', 1500]));
  assert.equal(noAudioTimes.turnEndWaitMedianMs, null);
  assert.equal(noAudioTimes.replyGapMedianMs, null);
  assert.equal(noAudioTimes.replyLatencyMedianMs, 500);
});

test('in Smart Turn mode the wait is measured on the phone, and each kind of turn end is counted', () => {
  const events = [
    { type: 'smart-turn-loaded', at: 0, loadMs: 3012.4 },
    { type: 'input_audio_buffer.speech_started', at: 1000 },
    { type: 'smart-turn-decision', at: 3430, ms: 230 },
    { type: 'smart-turn-end', at: 3430, quietSince: 3000, reason: 'smartTurn' },
    { type: 'input_audio_buffer.committed', at: 3470 },
    { type: 'output_audio_buffer.started', at: 4000 },
    { type: 'output_audio_buffer.stopped', at: 7000 },
    { type: 'input_audio_buffer.speech_started', at: 8000 },
    { type: 'smart-turn-decision', at: 9440, ms: 250 },
    { type: 'smart-turn-end', at: 11_500, quietSince: 9000, reason: 'backup' },
    { type: 'output_audio_buffer.started', at: 12_100 },
  ];
  const summary = summarize(events);
  assert.deepEqual([summary.smartTurnEnds, summary.backupEnds, summary.modelLoadMs, summary.smartTurnFallback], [1, 1, 3012, 0]);
  assert.deepEqual([summary.turnEndWaitMedianMs, summary.turnEndWaitP90Ms], [430, 2500]);
  assert.deepEqual([summary.replyGapMedianMs, summary.replyGapP90Ms], [1000, 3100]);
  assert.deepEqual([summary.replyLatencyMedianMs, summary.replyLatencyP90Ms], [570, 600]);
  assert.deepEqual([summary.smartTurnMedianMs, summary.smartTurnP90Ms], [230, 250]);
  assert.deepEqual(cleanMetrics(summary), summary);
});

test('a call that fell back to silence mode says why, and other modes report no Smart Turn numbers', () => {
  const fallback = (reason) => summarize([{ type: 'smart-turn-fallback', at: 10, reason }]).smartTurnFallback;
  assert.deepEqual([fallback('load'), fallback('slow'), fallback('no-audio')], [1, 2, 3]);
  const restarts = summarize([{ type: 'smart-turn-audio-restart', at: 1 }, { type: 'smart-turn-audio-restart', at: 2 }]);
  assert.deepEqual([restarts.audioRestarts, restarts.smartTurnFallback], [2, 0]);
  const plain = summarize(timeline(['speechStopped', 1000], ['agentStarted', 1600]));
  assert.deepEqual(
    [plain.smartTurnEnds, plain.backupEnds, plain.smartTurnMedianMs, plain.smartTurnP90Ms, plain.modelLoadMs, plain.smartTurnFallback, plain.audioRestarts],
    [0, 0, null, null, null, 0, 0],
  );
});

test('a rejected set of metrics is explained by field names only, never values', () => {
  const good = summarize(timeline(['speechStopped', 1000], ['agentStarted', 1600]));
  const { bargeIns, ...missing } = good;
  assert.deepEqual(metricsProblems({ ...missing, callSeconds: 1.5, transcript: 'こんにちは' }), { missing: ['bargeIns'], invalid: ['callSeconds'], unknown: 1 });
  assert.deepEqual(metricsProblems({ ...good, replyGapMedianMs: null }), { missing: [], invalid: [], unknown: 0 });
  assert.deepEqual(metricsProblems('words'), { notAnObject: true });
});

// Phones running older versions of the app, and engines that can't measure everything

// METRIC_FIELDS as each earlier version of the app sent them, oldest first.
const OLDER_SCHEMAS = [
  METRIC_FIELDS.slice(0, METRIC_FIELDS.indexOf('callSeconds') + 1), // turn timing began
  METRIC_FIELDS.slice(0, METRIC_FIELDS.indexOf('replyGapP90Ms') + 1), // + the hidden wait and the gap
  METRIC_FIELDS.slice(0, METRIC_FIELDS.indexOf('smartTurnFallback') + 1), // + Smart Turn
  METRIC_FIELDS.slice(0, METRIC_FIELDS.indexOf('audioRestarts') + 1), // + audio restarts: phones on 2f52ca9
];

test('metrics from phones still on an older version are accepted, with what they never sent saved as null, not 0', () => {
  const current = summarize(timeline(['speechStopped', 1000], ['agentStarted', 1600], ['speechStarted', 2000], ['agentCleared', 2100]));
  assert.deepEqual(cleanMetrics(current), current, 'the current app');
  for (const fields of OLDER_SCHEMAS) {
    const sent = Object.fromEntries(fields.map((field) => [field, current[field]]));
    const saved = cleanMetrics(sent);
    assert.ok(saved, `${fields.length} fields`);
    assert.deepEqual(Object.keys(saved), METRIC_FIELDS);
    for (const field of METRIC_FIELDS) assert.equal(saved[field], fields.includes(field) ? current[field] : null, field);
  }
  assert.equal(cleanMetrics(Object.fromEntries(OLDER_SCHEMAS[0].map((field) => [field, current[field]]))).talkOvers, null);
  // Partly filled: the first fields plus a few later ones.
  const partial = { ...Object.fromEntries(OLDER_SCHEMAS[0].map((field) => [field, current[field]])), talkOvers: 1, audioRestarts: 0 };
  assert.deepEqual([cleanMetrics(partial).talkOvers, cleanMetrics(partial).audioRestarts, cleanMetrics(partial).replyGapMedianMs], [1, 0, null]);
});

test('malformed or unreasonable metrics are still rejected whole', () => {
  const good = summarize(timeline(['speechStopped', 1000], ['agentStarted', 1600]));
  const { callSeconds, ...noCallSeconds } = good;
  for (const bad of [
    noCallSeconds, // a field every version sends
    {},
    { ...good, extra: 1 },
    JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(good).slice(1)}`),
    { ...good, talkOvers: null }, // the phone always counts these, so null isn't a real value
    { ...good, talkOvers: '1' },
    { ...good, providerLatencyMedianMs: 1.5 },
    { ...good, replyGapMedianMs: 3_600_001 }, // over an hour
    { ...good, callSeconds: 86_401 },
    { ...good, userTurns: 100_001 },
    { ...good, smartTurnFallback: 4 },
    { ...good, smartTurnFallback: null },
  ]) {
    assert.equal(cleanMetrics(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(metricsProblems({ ...good, talkOvers: null, extra: 2 }), { missing: [], invalid: ['talkOvers'], unknown: 1 });
});

test("OpenAI calls keep their aizuchi counts and report no provider latency; Deepgram's counts what it can and nothing it can't", () => {
  const events = timeline(['agentStarted', 0], ['speechStarted', 3000], ['agentCleared', 3000], ['aizuchi', 3800], ['agentStarted', 4000], ['speechStarted', 7000], ['agentCleared', 7000]);
  const openai = summarize(events);
  assert.deepEqual([openai.talkOvers, openai.bargeIns, openai.ignoredAizuchi], [2, 1, 1]);
  assert.deepEqual([openai.providerLatencyMedianMs, openai.providerLatencyP90Ms, openai.providerLatencyCount], [null, null, null]);

  const latency = (source, totalMs, at) => ({ type: 'provider-latency', source, totalMs, at });
  const deepgram = summarizeTurns([...events, latency('AgentStartedSpeaking', 800, 1), latency('AgentStartedSpeaking', null, 2), latency('AgentStartedSpeaking', 1500, 3)], {
    connectedAt: 0,
    endedAt: 60_000,
    engine: 'deepgram-agent',
  });
  assert.deepEqual([deepgram.talkOvers, deepgram.bargeIns, deepgram.ignoredAizuchi], [2, null, null]);
  assert.deepEqual([deepgram.providerLatencyMedianMs, deepgram.providerLatencyP90Ms, deepgram.providerLatencyCount], [800, 1500, 2]);
  assert.deepEqual(cleanMetrics(deepgram), deepgram);

  // A call that got both of Deepgram's messages counts each reply once, from LatencyReport.
  const both = summarizeTurns([latency('AgentStartedSpeaking', 800, 1), latency('LatencyReport', 820, 1), latency('AgentStartedSpeaking', 1500, 2), latency('LatencyReport', 1490, 2)], { endedAt: 1, engine: 'deepgram-agent' });
  assert.deepEqual([both.providerLatencyMedianMs, both.providerLatencyP90Ms, both.providerLatencyCount], [820, 1490, 2]);
  const none = summarizeTurns([], { endedAt: 1, engine: 'deepgram-agent' });
  assert.deepEqual([none.providerLatencyMedianMs, none.providerLatencyCount], [null, 0]);
});

test('the admin call log says n/a for what an engine cannot measure, and - for what was not reported', async () => {
  const { turnFacts } = await import('../public/settings.js');
  const facts = (entry) => Object.fromEntries(turnFacts(entry));
  const openai = facts({ engine: 'gpt-realtime', replyGapMedianMs: 1900, talkOvers: 3, ignoredAizuchi: 1, suspectedCutoffs: 0 });
  assert.deepEqual(openai, { 'Gap before reply': '1.9 s', 'Talked over Ping': '3 (1 aizuchi)', 'Suspected cut-offs': 0 });
  const deepgram = facts({ engine: 'deepgram-agent', replyGapMedianMs: null, talkOvers: 3, ignoredAizuchi: null, providerLatencyMedianMs: 1100, providerLatencyP90Ms: 1640, suspectedCutoffs: 1 });
  assert.deepEqual(deepgram, { 'Gap before reply': 'n/a', 'Deepgram-reported latency': '1.1 s, P90 1.6 s', 'Talked over Ping': '3 (aizuchi: n/a)', 'Suspected cut-offs': 1 });
  // Entries from before this change, and a call that never sent its numbers.
  assert.deepEqual(facts({ engine: 'gpt-realtime', replyGapMedianMs: 2100, bargeIns: 0, ignoredAizuchi: 0, suspectedCutoffs: 2 }), { 'Gap before reply': '2.1 s', 'Talked over Ping': '-', 'Suspected cut-offs': 2 });
  assert.deepEqual(facts({ engine: 'deepgram-agent' }), { 'Gap before reply': 'n/a', 'Deepgram-reported latency': '-', 'Talked over Ping': '-', 'Suspected cut-offs': '-' });
  assert.deepEqual(facts({}), { 'Gap before reply': '-', 'Talked over Ping': '-', 'Suspected cut-offs': '-' });
});

test('speaking time adds up each side, and time to answer runs from the contact finishing to the user starting', () => {
  const summary = summarize(
    timeline(
      ['agentStarted', 0], ['agentStopped', 3000], // the contact asks: 3 s
      ['speechStarted', 4200], ['speechStopped', 7000], ['committed', 7010], // 1.2 s to start; 2.8 s of speech (no silence wait known)
      ['agentStarted', 8000], ['agentStopped', 10_000], // 2 s
      ['speechStarted', 12_000], ['speechStopped', 16_000], ['committed', 16_010], // 2 s to start; 4 s
      ['agentStarted', 17_000], ['speechStarted', 17_500], ['agentCleared', 17_600], ['speechStopped', 18_500], // talked over: no answer time
    ),
  );
  assert.equal(summary.agentSpeechMs, 3000 + 2000 + 600);
  assert.equal(summary.userSpeechMs, 2800 + 4000 + 1000);
  assert.equal(summary.answerStartMedianMs, 1200, 'the median of 1.2 s and 2 s, by nearest rank');
});

test('speech still going when the call ends counts up to the end, and a call with no answers has no answer time', () => {
  const summary = summarizeTurns(timeline(['agentStarted', 0], ['agentStopped', 2000], ['speechStarted', 59_000]), { connectedAt: 0, endedAt: 60_000 });
  assert.equal(summary.userSpeechMs, 1000);
  assert.equal(summary.answerStartMedianMs, 57_000);
  assert.equal(summarize(timeline(['agentStarted', 0], ['agentStopped', 2000])).answerStartMedianMs, null);
});
