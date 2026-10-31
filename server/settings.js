// What a user can change, by voice during a call or on the settings screen.

export const MIN_SPEED = 0.6;
export const MAX_SPEED = 1.5;
export const DEFAULT_SETTINGS = { speed: 0.9, thinkingTime: 'normal', callsEnabled: true };

const SPEED_CHANGES = { much_slower: -0.3, slower: -0.15, faster: 0.15, much_faster: 0.3 };
const NORMAL_SPEED = 1;

// How much silence ends the user's turn. Learners pause to think, so even "short" is patient.
export const SILENCE_MS = { short: 800, normal: 1300, long: 2500 };

const roundSpeed = (speed) => Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;

export function applySettings(current, change = {}) {
  const next = { ...current };
  if (change.speedChange === 'normal') next.speed = NORMAL_SPEED;
  else if (SPEED_CHANGES[change.speedChange]) next.speed = roundSpeed(current.speed + SPEED_CHANGES[change.speedChange]);
  if (Number.isFinite(change.speed)) next.speed = roundSpeed(change.speed);
  if (SILENCE_MS[change.thinkingTime]) next.thinkingTime = change.thinkingTime;
  if (typeof change.callsEnabled === 'boolean') next.callsEnabled = change.callsEnabled;
  return next;
}
