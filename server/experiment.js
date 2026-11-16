// Which engine and turn detection each call uses. Every caller is assigned a combination at random,
// balanced per person: each call goes to a combination they've had least, so even a few calls each
// compare fairly. Admins can switch that off and pick one themselves (Manage Plan).

import { TURN_MODES } from './tutor.js';

// The engines Ping can run. turnModes is the turn detection an engine supports, or [] for an engine
// that decides turns itself (full duplex, or its own end-of-turn model), where the turn mode is blank.
export const ENGINES = {
  'gpt-realtime': { name: 'OpenAI gpt-realtime', turnModes: TURN_MODES },
  // Cascaded: Deepgram Flux hears and decides turns, an OpenAI model thinks, a Deepgram Flux voice speaks.
  'deepgram-agent': { name: 'Deepgram Voice Agent', turnModes: [] },
};

// What every caller is randomized across: the beta's four-way comparison. A new engine or mode joins only
// after a few admin test calls and, for a new company, a Privacy Policy update. Deepgram is left out on a
// server without its key (engineReady in calls.js).
export const RANDOM_MIX = [
  { engine: 'gpt-realtime', turnMode: 'silence' },
  { engine: 'gpt-realtime', turnMode: 'smartTurn' },
  { engine: 'gpt-realtime', turnMode: 'semantic' },
  { engine: 'deepgram-agent', turnMode: null },
];

// What a call falls back to when its engine can't start, so the caller still gets a call.
export const FALLBACK_COMBO = { engine: 'gpt-realtime', turnMode: 'silence' };

export const comboKey = ({ engine, turnMode }) => `${engine}|${turnMode ?? ''}`;

export function validCombo({ engine, turnMode }) {
  const spec = ENGINES[engine];
  if (!spec) return false;
  return spec.turnModes.length ? spec.turnModes.includes(turnMode) : turnMode == null;
}

// What a call actually ran on, read from the session sent to its engine rather than from defaults: an OpenAI
// realtime session, or Deepgram's Settings message. Every field is there for both engines, null where it
// doesn't apply. smartTurn is the phone's Smart Turn patience, for Smart Turn calls only.
// Model and voice names and turn detection numbers only: never the instructions, keys or tokens.
export function callConfig({ session, smartTurn = null }) {
  const config = {
    realtimeModel: null,
    transcriptionModel: null,
    thinkModel: null,
    listenModel: null,
    voice: null,
    voiceSpeed: null,
    turnDetection: null, // server_vad (silence, and Smart Turn until it takes over), semantic_vad or flux
    silenceMs: null,
    eagerness: null,
    smartTurnDoneAt: null,
    smartTurnBackupMs: null,
    eotThreshold: null,
    eotTimeoutMs: null,
  };
  if (session?.type === 'Settings') {
    const { listen, think, speak } = session.agent ?? {};
    return {
      ...config,
      thinkModel: think?.provider?.model ?? null,
      listenModel: listen?.provider?.model ?? null,
      voice: speak?.provider?.model ?? null,
      voiceSpeed: speak?.provider?.speed ?? null,
      turnDetection: 'flux',
      eotThreshold: listen?.provider?.eot_threshold ?? null,
      eotTimeoutMs: listen?.provider?.eot_timeout_ms ?? null,
    };
  }
  const detection = session?.audio?.input?.turn_detection ?? {};
  return {
    ...config,
    realtimeModel: session?.model ?? null,
    transcriptionModel: session?.audio?.input?.transcription?.model ?? null,
    voice: session?.audio?.output?.voice ?? null,
    voiceSpeed: session?.audio?.output?.speed ?? null,
    turnDetection: detection.type ?? null,
    silenceMs: detection.silence_duration_ms ?? null,
    eagerness: detection.eagerness ?? null,
    smartTurnDoneAt: smartTurn?.doneAt ?? null,
    smartTurnBackupMs: smartTurn?.backupMs ?? null,
  };
}

// counts: how many calls this person has had with each combination, by comboKey.
export function pickCombo(counts = {}, random = Math.random, mix = RANDOM_MIX) {
  const fewest = Math.min(...mix.map((combo) => counts[comboKey(combo)] ?? 0));
  const leastUsed = mix.filter((combo) => (counts[comboKey(combo)] ?? 0) === fewest);
  return { ...leastUsed[Math.min(leastUsed.length - 1, Math.floor(random() * leastUsed.length))] };
}
