// Which engine and turn detection each call uses. Every caller is assigned a combination at random,
// balanced per person: each call goes to a combination they've had least, so even a few calls each
// compare fairly. Admins can switch that off and pick one themselves (Manage Plan).

import { TURN_MODES } from './tutor.js';

// The engines Ping can run. turnModes is the turn detection an engine supports, or [] for an engine
// that decides turns itself (full duplex, or its own end-of-turn model), where the turn mode is blank.
export const ENGINES = {
  'gpt-realtime': { name: 'OpenAI gpt-realtime', turnModes: TURN_MODES },
};

// What every caller is randomized across. A new engine or mode joins only after a few admin test calls.
// Semantic hasn't had those yet.
export const RANDOM_MIX = [
  { engine: 'gpt-realtime', turnMode: 'silence' },
  { engine: 'gpt-realtime', turnMode: 'smartTurn' },
];

export const comboKey = ({ engine, turnMode }) => `${engine}|${turnMode ?? ''}`;

export function validCombo({ engine, turnMode }) {
  const spec = ENGINES[engine];
  if (!spec) return false;
  return spec.turnModes.length ? spec.turnModes.includes(turnMode) : turnMode == null;
}

// counts: how many calls this person has had with each combination, by comboKey.
export function pickCombo(counts = {}, random = Math.random, mix = RANDOM_MIX) {
  const fewest = Math.min(...mix.map((combo) => counts[comboKey(combo)] ?? 0));
  const leastUsed = mix.filter((combo) => (counts[comboKey(combo)] ?? 0) === fewest);
  return { ...leastUsed[Math.min(leastUsed.length - 1, Math.floor(random() * leastUsed.length))] };
}
