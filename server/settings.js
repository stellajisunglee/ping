// What a user can change, by voice during a call or on the settings screen.

export const MIN_SPEED = 0.6;
export const MAX_SPEED = 1.5;
export const LANGUAGES = ['ja'];
export const PROFICIENCY_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const FORMALITY_LEVELS = ['formal', 'casual'];
export const FREQUENCIES = ['daily', 'every-other-day', 'weekdays', 'weekends', 'custom'];
export const DEFAULT_SETTINGS = {
  speed: 1.0,
  thinkingTime: 'normal',
  callsEnabled: true,
  language: 'ja',
  proficiency: 'beginner',
  formality: 'formal',
  frequency: 'daily',
  customDays: [1, 3, 5], // 0 is Sunday
  callStartHour: 10,
  callEndHour: 20,
};

const SPEED_CHANGES = { much_slower: -0.3, slower: -0.15, faster: 0.15, much_faster: 0.3 };
const NORMAL_SPEED = 1;
const SLOW_SPEED_PATIENCE = 1.5; // at 0.6x, the user gets 60% longer to pause before their turn ends

// How much silence ends the user's turn. Learners pause to think, so even "short" is patient.
export const SILENCE_MS = { short: 800, normal: 1300, long: 2500 };

// Someone who asks for slower speech usually needs longer gaps too.
export function silenceMs(thinkingTime, speed = NORMAL_SPEED) {
  const base = SILENCE_MS[thinkingTime] ?? SILENCE_MS.normal;
  return Math.round(base * (1 + Math.max(0, NORMAL_SPEED - speed) * SLOW_SPEED_PATIENCE));
}

const roundSpeed = (speed) => Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
const isHour = (value) => Number.isInteger(value) && value >= 0 && value <= 24;

export function applySettings(current, change = {}) {
  const next = { ...current };
  if (change.speedChange === 'normal') next.speed = NORMAL_SPEED;
  else if (SPEED_CHANGES[change.speedChange]) next.speed = roundSpeed(current.speed + SPEED_CHANGES[change.speedChange]);
  if (Number.isFinite(change.speed)) next.speed = roundSpeed(change.speed);
  if (SILENCE_MS[change.thinkingTime]) next.thinkingTime = change.thinkingTime;
  if (typeof change.callsEnabled === 'boolean') next.callsEnabled = change.callsEnabled;
  if (LANGUAGES.includes(change.language)) next.language = change.language;
  if (PROFICIENCY_LEVELS.includes(change.proficiency)) next.proficiency = change.proficiency;
  if (FORMALITY_LEVELS.includes(change.formality)) next.formality = change.formality;
  if (FREQUENCIES.includes(change.frequency)) next.frequency = change.frequency;
  if (Array.isArray(change.customDays)) {
    next.customDays = [...new Set(change.customDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  }
  const start = change.callStartHour ?? current.callStartHour;
  const end = change.callEndHour ?? current.callEndHour;
  if (isHour(start) && isHour(end) && start < end) {
    next.callStartHour = start;
    next.callEndHour = end;
  }
  return next;
}
