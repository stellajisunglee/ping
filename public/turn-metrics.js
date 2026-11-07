// Turns the timing of a call's turn-taking events into a few numbers, to measure how well
// Ping takes turns. It has no browser code, so the server and the tests can use it too.

// The user starting to talk this soon after Ping started suggests Ping took the turn
// while they were still thinking.
export const SUSPECTED_CUTOFF_WINDOW_MS = 1500;

const MAX_METRIC = 10_000_000; // far above any real call, so only broken or made-up numbers are rejected

// The data channel events whose timing the call records.
export const TIMED_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'response.created',
  'response.done',
  'output_audio_buffer.started',
  'output_audio_buffer.stopped',
  'output_audio_buffer.cleared',
]);

// Everything the phone sends. Numbers only, so no words or audio leave the phone this way.
export const METRIC_FIELDS = [
  'replyLatencyMedianMs',
  'replyLatencyP90Ms',
  'replyLatencyCount',
  'suspectedCutoffs',
  'bargeIns',
  'ignoredAizuchi',
  'userTurns',
  'agentTurns',
  'callSeconds',
];
const MAY_BE_EMPTY = new Set(['replyLatencyMedianMs', 'replyLatencyP90Ms']); // a call with no replies has no latency

// Nearest rank: the smallest value with at least that share of all values at or below it.
const percentile = (sorted, share) => (sorted.length ? sorted[Math.ceil(share * sorted.length) - 1] : null);

export function summarizeTurns(events, { connectedAt = null, endedAt }) {
  const latencies = [];
  let userTurns = 0;
  let agentTurns = 0;
  let suspectedCutoffs = 0;
  let bargeIns = 0;
  let userStoppedAt = null; // when the user's turn ended, until Ping's reply starts
  let agentStartedAt = null;
  let agentPlaying = false;
  let cutoffCounted = false;
  let userSpokeOver = false;

  for (const { type, at } of events) {
    switch (type) {
      case 'input_audio_buffer.speech_started':
        // Talking again before Ping replies means the earlier stop wasn't the end of their turn.
        userStoppedAt = null;
        if (agentPlaying) {
          userSpokeOver = true;
          if (!cutoffCounted && at - agentStartedAt <= SUSPECTED_CUTOFF_WINDOW_MS) {
            suspectedCutoffs += 1;
            cutoffCounted = true;
          }
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        userStoppedAt = at;
        break;
      case 'input_audio_buffer.committed':
        userTurns += 1;
        break;
      case 'output_audio_buffer.started':
        agentTurns += 1;
        agentPlaying = true;
        agentStartedAt = at;
        cutoffCounted = false;
        userSpokeOver = false;
        if (userStoppedAt !== null) latencies.push(Math.round(at - userStoppedAt));
        userStoppedAt = null;
        break;
      case 'output_audio_buffer.stopped':
        agentPlaying = false;
        break;
      // OpenAI clears Ping's audio when the user talks over it, so only count a clear that followed their speech.
      case 'output_audio_buffer.cleared':
        if (agentPlaying && userSpokeOver) bargeIns += 1;
        agentPlaying = false;
        break;
      default:
    }
  }

  const sorted = latencies.sort((a, b) => a - b);
  return {
    replyLatencyMedianMs: percentile(sorted, 0.5),
    replyLatencyP90Ms: percentile(sorted, 0.9),
    replyLatencyCount: sorted.length,
    suspectedCutoffs,
    bargeIns,
    ignoredAizuchi: 0,
    userTurns,
    agentTurns,
    callSeconds: connectedAt === null ? 0 : Math.max(0, Math.round((endedAt - connectedAt) / 1000)),
  };
}

// Returns the metrics if every known field is there as a whole number, and nothing else is. Otherwise null.
export function cleanMetrics(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== METRIC_FIELDS.length || !METRIC_FIELDS.every((field) => keys.includes(field))) return null;
  const valid = METRIC_FIELDS.every((field) => {
    const value = body[field];
    if (value === null) return MAY_BE_EMPTY.has(field);
    return Number.isInteger(value) && value >= 0 && value <= MAX_METRIC;
  });
  return valid ? Object.fromEntries(METRIC_FIELDS.map((field) => [field, body[field]])) : null;
}
