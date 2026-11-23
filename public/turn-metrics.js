// Turns the timing of a call's turn-taking events into a few numbers, to measure how well
// Ping takes turns. It has no browser code, so the server and the tests can use it too.

// The user starting to talk this soon after Ping started suggests Ping took the turn
// while they were still thinking.
export const SUSPECTED_CUTOFF_WINDOW_MS = 1500;

// The largest value each kind of number can take: far above any real call (the longest is 10 minutes),
// so only broken or made-up numbers are rejected.
const MAX_MS = 3_600_000; // an hour, for times in milliseconds
const MAX_CALL_SECONDS = 86_400;
const MAX_COUNT = 100_000;

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
  'smartTurnFallback', // why the call went back to silence mode: 0 it didn't, 1 couldn't load, 2 too slow, 3 audio stopped
  'audioRestarts', // times the phone paused the microphone audio Smart Turn hears, and it was restarted
  // Added after the fields above, so older phones don't send them.
  'talkOvers', // times the contact's voice was cut off because the user started talking, aizuchi included
  // Deepgram only, as Deepgram reports it: total_latency, from the end of the user's utterance (as Deepgram
  // judged it) to its first audio byte. Not measured by the phone, so not the same thing as replyGap.
  'providerLatencyMedianMs',
  'providerLatencyP90Ms',
  'providerLatencyCount',
  // Added for learning progress. Estimates from the same events: how long the user and the contact each spoke,
  // and how long the user took to start answering after the contact finished a turn.
  'userSpeechMs',
  'agentSpeechMs',
  'answerStartMedianMs',
];

// What every phone has sent since metrics began. Fields added later are optional, so a phone still running an
// older version of the app is accepted, and whatever it didn't send is saved as null (not reported), never 0.
const CORE_FIELDS = METRIC_FIELDS.slice(0, METRIC_FIELDS.indexOf('callSeconds') + 1);

// What each engine lets the phone measure. Deepgram decides turns itself and answers aizuchi like any other
// turn, so the phone can't tell aizuchi from a real interruption there; it does report its own latency.
const ENGINE_MEASURES = {
  'gpt-realtime': { aizuchi: true, providerLatency: false },
  'deepgram-agent': { aizuchi: false, providerLatency: true },
  // These decide turns themselves and send no aizuchi or latency signals the phone can use.
  'gpt-live': { aizuchi: false, providerLatency: false },
  elevenlabs: { aizuchi: false, providerLatency: false },
};

export const FALLBACK_CODES = { load: 1, slow: 2, 'no-audio': 3 };
// A call with no replies has no latency or gap to report, and only Smart Turn calls have decision times.
// The aizuchi counts don't apply on Deepgram, nor the provider's latency on OpenAI.
const MAY_BE_EMPTY = new Set([
  'bargeIns',
  'ignoredAizuchi',
  'providerLatencyMedianMs',
  'providerLatencyP90Ms',
  'providerLatencyCount',
  'replyLatencyMedianMs',
  'replyLatencyP90Ms',
  'turnEndWaitMedianMs',
  'turnEndWaitP90Ms',
  'replyGapMedianMs',
  'replyGapP90Ms',
  'smartTurnMedianMs',
  'smartTurnP90Ms',
  'modelLoadMs',
  'answerStartMedianMs',
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

// engine says what the call's engine lets the phone measure (ENGINE_MEASURES). What it can't measure is null.
export function summarizeTurns(events, { connectedAt = null, endedAt, engine = 'gpt-realtime' }) {
  const measures = ENGINE_MEASURES[engine] ?? ENGINE_MEASURES['gpt-realtime'];
  const latencies = [];
  const providerLatencies = { LatencyReport: [], AgentStartedSpeaking: [] }; // by the Deepgram message they came in
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
  let audioRestarts = 0;
  let userSpeechMs = 0;
  let agentSpeechMs = 0;
  let userSpeakingSince = null; // when the user's current stretch of speech started
  let agentSpeakingSince = null;
  let contactFinishedAt = null; // when the contact last finished a turn, until the user starts answering
  const answerStarts = [];
  // A stretch of the user's speech ends when they went quiet: the estimate where there is one, else when it was noticed.
  const userStopped = (quietAt) => {
    if (userSpeakingSince !== null) userSpeechMs += Math.max(0, Math.round(quietAt - userSpeakingSince));
    userSpeakingSince = null;
  };
  const agentStopped = (at) => {
    if (agentSpeakingSince !== null) agentSpeechMs += Math.max(0, Math.round(at - agentSpeakingSince));
    agentSpeakingSince = null;
  };

  for (const event of events) {
    const { type, at } = event;
    switch (type) {
      case 'turn-detection':
        detection = { silenceMs: event.silenceMs ?? 0, paddingMs: event.paddingMs ?? 0 };
        break;
      case 'input_audio_buffer.speech_started':
        speechStart = event;
        if (userSpeakingSince === null) userSpeakingSince = at;
        if (contactFinishedAt !== null && !agentPlaying) answerStarts.push(Math.max(0, Math.round(at - contactFinishedAt)));
        contactFinishedAt = null;
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
        userStopped(userStoppedTalkingAt ?? at);
        break;
      }
      // In Smart Turn mode the phone knows exactly when the user went quiet, so nothing is estimated.
      case 'smart-turn-end':
        userStoppedAt = at;
        userStoppedTalkingAt = event.quietSince;
        waits.push(Math.max(0, Math.round(at - event.quietSince)));
        userStopped(event.quietSince);
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
        smartTurnFallback = FALLBACK_CODES[event.reason] ?? FALLBACK_CODES.load;
        break;
      case 'smart-turn-audio-restart':
        audioRestarts += 1;
        break;
      case 'input_audio_buffer.committed':
        userTurns += 1;
        break;
      case 'output_audio_buffer.started':
        agentTurns += 1;
        agentPlaying = true;
        agentStartedAt = at;
        agentSpeakingSince ??= at;
        contactFinishedAt = null;
        cutoffCounted = false;
        userSpokeOver = false;
        if (userStoppedAt !== null) latencies.push(Math.round(at - userStoppedAt));
        if (userStoppedTalkingAt !== null) gaps.push(Math.round(at - userStoppedTalkingAt));
        userStoppedAt = null;
        userStoppedTalkingAt = null;
        break;
      case 'output_audio_buffer.stopped':
        agentPlaying = false;
        agentStopped(at);
        contactFinishedAt = at;
        break;
      // OpenAI clears Ping's audio when the user talks over it, so only count a clear that followed their speech.
      case 'output_audio_buffer.cleared':
        if (agentPlaying && userSpokeOver) talkOvers += 1;
        agentPlaying = false;
        agentStopped(at);
        break;
      // Logged by the app when talking over Ping turned out to be aizuchi and Ping carried on.
      case 'aizuchi':
        ignoredAizuchi += 1;
        break;
      // Deepgram's own latency for one reply, in milliseconds. Missing values were never added.
      case 'provider-latency':
        if (Number.isFinite(event.totalMs) && providerLatencies[event.source]) providerLatencies[event.source].push(event.totalMs);
        break;
      default:
    }
  }

  const sorted = latencies.sort((a, b) => a - b);
  const wait = spread(waits);
  const gap = spread(gaps);
  const decision = spread(decisions);
  // Deepgram documents LatencyReport and has also sent AgentStartedSpeaking with the same total_latency.
  // If a call got both, only LatencyReport counts, so no reply is counted twice.
  const reported = providerLatencies.LatencyReport.length ? providerLatencies.LatencyReport : providerLatencies.AgentStartedSpeaking;
  const provider = spread(reported);
  // Still talking when the call ended.
  if (endedAt !== undefined) {
    userStopped(endedAt);
    agentStopped(endedAt);
  }
  const answerStart = spread(answerStarts);
  return {
    replyLatencyMedianMs: percentile(sorted, 0.5),
    replyLatencyP90Ms: percentile(sorted, 0.9),
    replyLatencyCount: sorted.length,
    suspectedCutoffs,
    bargeIns: measures.aizuchi ? Math.max(0, talkOvers - ignoredAizuchi) : null, // real interruptions only
    ignoredAizuchi: measures.aizuchi ? ignoredAizuchi : null,
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
    audioRestarts,
    talkOvers,
    providerLatencyMedianMs: measures.providerLatency ? provider.median : null,
    providerLatencyP90Ms: measures.providerLatency ? provider.p90 : null,
    providerLatencyCount: measures.providerLatency ? reported.length : null,
    userSpeechMs,
    agentSpeechMs,
    answerStartMedianMs: answerStart.median,
  };
}

const maxFor = (field) => (field === 'callSeconds' ? MAX_CALL_SECONDS : field === 'smartTurnFallback' ? Math.max(...Object.values(FALLBACK_CODES)) : field.endsWith('Ms') ? MAX_MS : MAX_COUNT);
const validValue = (field, value) => (value === null ? MAY_BE_EMPTY.has(field) : Number.isInteger(value) && value >= 0 && value <= maxFor(field));
const isObject = (body) => Boolean(body) && typeof body === 'object' && !Array.isArray(body);

// Why a set of metrics was rejected, for the server log: the names of fields every phone sends that are missing,
// fields that aren't whole numbers in range, and how many unknown fields came with them. Never the values themselves.
export function metricsProblems(body) {
  if (!isObject(body)) return { notAnObject: true };
  const missing = CORE_FIELDS.filter((field) => !Object.hasOwn(body, field));
  const invalid = METRIC_FIELDS.filter((field) => Object.hasOwn(body, field) && !validValue(field, body[field]));
  const unknown = Object.keys(body).filter((key) => !METRIC_FIELDS.includes(key)).length;
  return { missing, invalid, unknown };
}

// Returns every known field, if the fields every phone sends are there, everything sent is a whole number in
// range (or null where nothing can be measured), and nothing else came with them. Fields a phone on an older
// version didn't send come back as null. Otherwise returns null.
export function cleanMetrics(body) {
  if (!isObject(body)) return null;
  const { missing, invalid, unknown } = metricsProblems(body);
  if (missing.length || invalid.length || unknown) return null;
  return Object.fromEntries(METRIC_FIELDS.map((field) => [field, Object.hasOwn(body, field) ? body[field] : null]));
}
