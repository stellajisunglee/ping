// One record per reply the contact gave, and one event per time the learner asked for help, worked out on the phone
// from the same timing events as the call's summary (turn-metrics.js). Numbers and short type names only, never words
// or audio. Lined up with the call's recording, these are labeled turn-taking data from Japanese learners.
// No browser code, so the server and tests can use it too.

import { SUSPECTED_CUTOFF_WINDOW_MS } from './turn-metrics.js';

export const MAX_TURNS = 200; // far above any real call (a 10-minute call has about 60), and within the request size limit
const MAX_MS = 3_600_000;

// What each reply record holds. Times are milliseconds; atMs counts from when the call connected.
export const TURN_FIELDS = [
  'index', // 0 for the contact's first reply (usually the greeting)
  'atMs', // when the contact's voice started
  'userSpeechMs', // how long the learner spoke in the turn before it
  'answerStartMs', // from the contact's previous reply ending to the learner starting to speak
  'endWaitMs', // estimated wait between the learner going quiet and the turn being called over
  'gapMs', // from the learner going quiet to the contact's voice: what the learner hears
  'replyMs', // how long the contact's voice played
  'endedBy', // what ended the learner's turn: 'vad' (OpenAI silence or semantic), 'smartTurn', 'backup', 'flux', 'model', or null
  'cutOff', // the learner started talking again within 1.5 s of the contact starting: probably cut off mid-thought
  'talkedOver', // the learner talked over this reply and it was stopped
  'aizuchi', // the learner's aizuchi during this reply that the contact carried on through
  'providerLatencyMs', // the engine's own reported latency for this reply (Deepgram), or null
];

// The kinds of help a learner can ask for, from the tools the contact calls.
export const HELP_TYPES = ['lookup', 'slower', 'faster', 'normal-speed', 'more-time', 'less-time', 'easier', 'harder', 'formality', 'stop-calls', 'start-calls', 'culture-question', 'end-call'];
const LEVELS = ['new', 'N5', 'N4', 'N3', 'N2', 'N1'];

// What one tool call asked for. update_settings can ask for several things at once.
export function helpTypes(name, args = {}, currentLevel = null) {
  if (name === 'add_to_stack') return ['lookup'];
  if (name === 'back_to_conversation') return ['culture-question'];
  if (name === 'end_call') return ['end-call'];
  if (name !== 'update_settings') return [];
  const types = [];
  if (args.speedChange === 'slower' || args.speedChange === 'much_slower') types.push('slower');
  if (args.speedChange === 'faster' || args.speedChange === 'much_faster') types.push('faster');
  if (args.speedChange === 'normal') types.push('normal-speed');
  if (args.thinkingTime === 'long') types.push('more-time');
  if (args.thinkingTime === 'short') types.push('less-time');
  if (LEVELS.includes(args.proficiency) && LEVELS.includes(currentLevel) && args.proficiency !== currentLevel) types.push(LEVELS.indexOf(args.proficiency) < LEVELS.indexOf(currentLevel) ? 'easier' : 'harder');
  if (args.formality) types.push('formality');
  if (args.callsEnabled === false) types.push('stop-calls');
  if (args.callsEnabled === true) types.push('start-calls');
  return types;
}

const ENDED_BY = { 'deepgram-agent': 'flux', 'gpt-live': 'model', elevenlabs: 'model' };

// events: the call's timing log. Returns { turns, help }.
export function turnRecords(events, { connectedAt = null, engine = 'gpt-realtime' } = {}) {
  const base = connectedAt ?? events[0]?.at ?? 0;
  const ms = (value) => (value === null || value === undefined ? null : Math.max(0, Math.min(MAX_MS, Math.round(value))));
  const turns = [];
  const help = [];
  let detection = { silenceMs: 0, paddingMs: 0 };
  let speechStart = null; // the current stretch of the learner's speech, as a speech_started event
  let userSpeechMs = 0; // the learner's speech since the contact's last reply
  let quietAt = null; // when the learner went quiet, best estimate
  let endWaitMs = null;
  let endedBy = null;
  let firstSpeechAt = null; // the learner's first speech since the contact's last reply ended
  let lastReplyEndedAt = null;
  let current = null; // the reply now playing
  let pendingLatency = null;

  for (const event of events) {
    const { type, at } = event;
    switch (type) {
      case 'turn-detection':
        detection = { silenceMs: event.silenceMs ?? 0, paddingMs: event.paddingMs ?? 0 };
        break;
      case 'input_audio_buffer.speech_started':
        speechStart = event;
        firstSpeechAt ??= at;
        if (current && current.playing) {
          if (at - current.startedAt <= SUSPECTED_CUTOFF_WINDOW_MS) current.record.cutOff = true;
          current.userSpokeOver = true;
        }
        break;
      case 'input_audio_buffer.speech_stopped': {
        endedBy = ENDED_BY[engine] ?? 'vad';
        // The same estimate as turn-metrics.js: OpenAI's audio clock against when the event arrived.
        if (speechStart?.audioMs !== undefined && event.audioMs !== undefined) {
          endWaitMs = Math.max(0, at - speechStart.at - (event.audioMs - speechStart.audioMs) + detection.silenceMs + detection.paddingMs);
          quietAt = at - endWaitMs;
        } else {
          endWaitMs = null;
          quietAt = at;
        }
        if (speechStart) userSpeechMs += Math.max(0, quietAt - speechStart.at);
        speechStart = null;
        break;
      }
      case 'smart-turn-end':
        quietAt = event.quietSince;
        endWaitMs = Math.max(0, at - event.quietSince);
        endedBy = event.reason === 'backup' ? 'backup' : 'smartTurn';
        if (speechStart) userSpeechMs += Math.max(0, event.quietSince - speechStart.at);
        speechStart = null;
        break;
      case 'output_audio_buffer.started': {
        const record = Object.fromEntries(TURN_FIELDS.map((field) => [field, null]));
        Object.assign(record, {
          index: turns.length,
          atMs: ms(at - base),
          userSpeechMs: turns.length ? ms(userSpeechMs) : null,
          answerStartMs: lastReplyEndedAt !== null && firstSpeechAt !== null ? ms(firstSpeechAt - lastReplyEndedAt) : null,
          endWaitMs: ms(endWaitMs),
          gapMs: quietAt !== null ? ms(at - quietAt) : null,
          endedBy: turns.length ? endedBy : null,
          cutOff: false,
          talkedOver: false,
          aizuchi: 0,
          providerLatencyMs: pendingLatency,
        });
        turns.push(record);
        current = { record, startedAt: at, playing: true, userSpokeOver: false };
        userSpeechMs = 0;
        quietAt = null;
        endWaitMs = null;
        endedBy = null;
        firstSpeechAt = null;
        pendingLatency = null;
        break;
      }
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (current?.playing) {
          current.playing = false;
          current.record.replyMs = ms(at - current.startedAt);
          if (type === 'output_audio_buffer.cleared' && current.userSpokeOver) current.record.talkedOver = true;
          lastReplyEndedAt = at;
        }
        break;
      case 'aizuchi':
        if (current) current.record.aizuchi += 1;
        break;
      case 'provider-latency':
        // Deepgram reports a reply's latency as it starts; attach it to that reply.
        if (Number.isFinite(event.totalMs)) {
          if (current && at - current.startedAt < 2000 && current.record.providerLatencyMs === null) current.record.providerLatencyMs = ms(event.totalMs);
          else pendingLatency = ms(event.totalMs);
        }
        break;
      case 'tool':
        for (const helpType of helpTypes(event.name, event.args, event.level)) help.push({ type: helpType, atMs: ms(at - base), turn: turns.length ? turns.length - 1 : 0 });
        break;
      default:
    }
  }
  if (current?.playing) current.record.replyMs = null; // still playing when the call ended
  return { turns: turns.slice(0, MAX_TURNS), help: help.slice(0, MAX_TURNS) };
}

const isMs = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= MAX_MS);
const ENDINGS = new Set(['vad', 'smartTurn', 'backup', 'flux', 'model', null]);

function cleanTurn(turn, position) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return null;
  if (Object.keys(turn).some((key) => !TURN_FIELDS.includes(key))) return null;
  if (turn.index !== position) return null;
  const msFields = ['atMs', 'userSpeechMs', 'answerStartMs', 'endWaitMs', 'gapMs', 'replyMs', 'providerLatencyMs'];
  if (!msFields.every((field) => isMs(turn[field] ?? null))) return null;
  if (!ENDINGS.has(turn.endedBy ?? null)) return null;
  if (typeof turn.cutOff !== 'boolean' || typeof turn.talkedOver !== 'boolean' || !Number.isInteger(turn.aizuchi) || turn.aizuchi < 0 || turn.aizuchi > 1000) return null;
  return Object.fromEntries(TURN_FIELDS.map((field) => [field, turn[field] ?? null]));
}

// The turns and help events as the phone sends them, if every one is well formed. Otherwise null.
export function cleanTurnData(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.turns) || !Array.isArray(body.help)) return null;
  if (body.turns.length > MAX_TURNS || body.help.length > MAX_TURNS) return null;
  const turns = body.turns.map(cleanTurn);
  if (turns.some((turn) => !turn)) return null;
  const help = body.help.map((event) =>
    event && HELP_TYPES.includes(event.type) && isMs(event.atMs) && Number.isInteger(event.turn) && event.turn >= 0 && event.turn <= MAX_TURNS ? { type: event.type, atMs: event.atMs, turn: event.turn } : null,
  );
  if (help.some((event) => !event)) return null;
  return { turns, help };
}
