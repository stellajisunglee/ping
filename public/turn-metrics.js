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
  'turnEndWaitMedianMs',
  'turnEndWaitP90Ms',
  'replyGapMedianMs',
  'replyGapP90Ms',
  // Smart Turn mode only. Zero or empty in the other modes.
  'smartTurnEnds', // turns Smart Turn ended
  'backupEnds', // turns the 2.5-second backup ended because Smart Turn kept saying "still thinking"
  'smartTurnMedianMs', // how long one Smart Turn decision took on the phone
  'smartTurnP90Ms',
  'modelLoadMs', // how long the runtime and models took to load
  'smartTurnFallback', // 1 if the call went back to silence mode
];
// A call with no replies has no latency or gap to report, and only Smart Turn calls have decision times.
const MAY_BE_EMPTY = new Set([
  'replyLatencyMedianMs',
  'replyLatencyP90Ms',
  'turnEndWaitMedianMs',
  'turnEndWaitP90Ms',
  'replyGapMedianMs',
  'replyGapP90Ms',
  'smartTurnMedianMs',
  'smartTurnP90Ms',
  'modelLoadMs',
]);

// Nearest rank: the smallest value with at least that share of all values at or below it.
const percentile = (sorted, share) => (sorted.length ? sorted[Math.ceil(share * sorted.length) - 1] : null);
const spread = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
};

// OpenAI only tells the app a turn is over once it has decided so, which can be well after the user
// actually stopped talking. This estimates that hidden wait. Each speech event carries a time on
// OpenAI's audio clock (audio_start_ms, audio_end_ms) as well as the time it reached the phone, so
// the difference between the two durations is how long the decision took after the audio ended.
// In silence mode audio_end_ms already includes the silence wait and the start includes the prefix
// padding, so both are added back. It's an estimate, good to a few hundred milliseconds.
function hiddenWait(start, stop, detection) {
  if (start?.audioMs === undefined || stop.audioMs === undefined) return null;
  const wait = stop.at - start.at - (stop.audioMs - start.audioMs) + detection.silenceMs + detection.paddingMs;
  return Math.max(0, Math.round(wait));
}

export function summarizeTurns(events, { connectedAt = null, endedAt }) {
  const latencies = [];
  const waits = [];
  const gaps = [];
  let detection = { silenceMs: 0, paddingMs: 0 }; // the turn detection settings in use, from OpenAI
  let speechStart = null;
  let userStoppedTalkingAt = null; // estimated moment the user actually went quiet
  let userTurns = 0;
  let agentTurns = 0;
  let suspectedCutoffs = 0;
  let talkOvers = 0; // times the contact's audio was cut because the user spoke
  let ignoredAizuchi = 0;
  let userStoppedAt = null; // when the user's turn ended, until Ping's reply starts
  let agentStartedAt = null;
  let agentPlaying = false;
  let cutoffCounted = false;
  let userSpokeOver = false;
  const decisions = [];
  let smartTurnEnds = 0;
  let backupEnds = 0;
  let modelLoadMs = null;
  let smartTurnFallback = 0;

  for (const event of events) {
    const { type, at } = event;
    switch (type) {
      case 'turn-detection':
        detection = { silenceMs: event.silenceMs ?? 0, paddingMs: event.paddingMs ?? 0 };
        break;
      case 'input_audio_buffer.speech_started':
        speechStart = event;
        // Talking again before Ping replies means the earlier stop wasn't the end of their turn.
        userStoppedAt = null;
        userStoppedTalkingAt = null;
        if (agentPlaying) {
          userSpokeOver = true;
          if (!cutoffCounted && at - agentStartedAt <= SUSPECTED_CUTOFF_WINDOW_MS) {
            suspectedCutoffs += 1;
            cutoffCounted = true;
          }
        }
        break;
      case 'input_audio_buffer.speech_stopped': {
        userStoppedAt = at;
        const wait = hiddenWait(speechStart, event, detection);
        if (wait !== null) {
          waits.push(wait);
          userStoppedTalkingAt = at - wait;
        }
        break;
      }
      // In Smart Turn mode the phone knows exactly when the user went quiet, so nothing is estimated.
      case 'smart-turn-end':
        userStoppedAt = at;
        userStoppedTalkingAt = event.quietSince;
        waits.push(Math.max(0, Math.round(at - event.quietSince)));
        if (event.reason === 'backup') backupEnds += 1;
        else smartTurnEnds += 1;
        break;
      case 'smart-turn-decision':
        decisions.push(event.ms);
        break;
      case 'smart-turn-loaded':
        modelLoadMs = Math.round(event.loadMs);
        break;
      case 'smart-turn-fallback':
        smartTurnFallback = 1;
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
        if (userStoppedTalkingAt !== null) gaps.push(Math.round(at - userStoppedTalkingAt));
        userStoppedAt = null;
        userStoppedTalkingAt = null;
        break;
      case 'output_audio_buffer.stopped':
        agentPlaying = false;
        break;
      // OpenAI clears Ping's audio when the user talks over it, so only count a clear that followed their speech.
      case 'output_audio_buffer.cleared':
        if (agentPlaying && userSpokeOver) talkOvers += 1;
        agentPlaying = false;
        break;
      // Logged by the app when talking over Ping turned out to be aizuchi and Ping carried on.
      case 'aizuchi':
        ignoredAizuchi += 1;
        break;
      default:
    }
  }

  const sorted = latencies.sort((a, b) => a - b);
  const wait = spread(waits);
  const gap = spread(gaps);
  const decision = spread(decisions);
  return {
    replyLatencyMedianMs: percentile(sorted, 0.5),
    replyLatencyP90Ms: percentile(sorted, 0.9),
    replyLatencyCount: sorted.length,
    suspectedCutoffs,
    bargeIns: Math.max(0, talkOvers - ignoredAizuchi), // real interruptions only
    ignoredAizuchi,
    userTurns,
    agentTurns,
    callSeconds: connectedAt === null ? 0 : Math.max(0, Math.round((endedAt - connectedAt) / 1000)),
    turnEndWaitMedianMs: wait.median,
    turnEndWaitP90Ms: wait.p90,
    replyGapMedianMs: gap.median, // what the user hears: from going quiet to Ping's voice
    replyGapP90Ms: gap.p90,
    smartTurnEnds,
    backupEnds,
    smartTurnMedianMs: decision.median,
    smartTurnP90Ms: decision.p90,
    modelLoadMs,
    smartTurnFallback,
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
