// Picks when Ping calls next, in the user's own time zone.

export const WINDOW_START_HOUR = 10;
export const WINDOW_END_HOUR = 20;
const MIN_NOTICE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAYS_TO_SEARCH = 15; // every frequency has a call day within two weeks, unless no days are picked

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(ms);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

export function localDay(ms, timeZone) {
  const { year, month, day } = localParts(ms, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Counts calendar days, so "in a row" and "every other day" work across month ends.
export function localDayNumber(ms, timeZone) {
  const { year, month, day } = localParts(ms, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function isCallDay(dayNumber, { frequency = 'daily', customDays = [] } = {}) {
  const weekday = (dayNumber + 4) % 7; // day 0 was a Thursday
  if (frequency === 'every-other-day') return dayNumber % 2 === 0;
  if (frequency === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (frequency === 'weekends') return weekday === 0 || weekday === 6;
  if (frequency === 'custom') return customDays.includes(weekday);
  return true;
}

function offsetAt(ms, timeZone) {
  const { year, month, day, hour, minute, second } = localParts(ms, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000;
}

// Checking the offset twice lands on the right side of a daylight saving change.
function localToUtc(year, month, day, hour, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

// A moment between earliest and end. hourWeights ({ localHour: weight }) makes some hours of the window likelier than
// others, in proportion to how much of each hour is left; without it, every moment is as likely. Equal weights give
// exactly the same moment as none, for the same random number.
function momentInWindow(earliest, end, random, timeZone, hourWeights) {
  if (!hourWeights) return Math.floor(earliest + random() * (end - earliest));
  const pieces = [];
  for (let from = earliest; from < end; ) {
    const { hour, minute, second } = localParts(from, timeZone);
    const to = Math.min(end, from + (60 - minute) * 60_000 - second * 1000 - (from % 1000));
    pieces.push({ from, to, weight: (hourWeights[hour] ?? DEFAULT_HOUR_WEIGHT) * (to - from) });
    from = to;
  }
  const total = pieces.reduce((sum, piece) => sum + piece.weight, 0);
  if (!(total > 0)) return Math.floor(earliest + random() * (end - earliest));
  let left = random() * total;
  for (const piece of pieces) {
    if (left < piece.weight) return Math.floor(piece.from + (left / piece.weight) * (piece.to - piece.from));
    left -= piece.weight;
  }
  return Math.floor(pieces.at(-1).to - 1);
}

// How likely the learner is to answer in an hour with no history, out of 1: the same prior every hour starts from.
export const DEFAULT_HOUR_WEIGHT = 0.5;

// Each hour's chance of being answered, from Ping's calls in it: (answered + 1) / (rang + 2), so an hour with no
// calls stays at 0.5 and one missed call only nudges it. Returns null until there are minCalls calls to learn from.
export function hourWeights(answeredHours = {}, minCalls = 3) {
  const calls = Object.values(answeredHours).reduce((total, hour) => total + hour.rang, 0);
  if (calls < minCalls) return null;
  return Object.fromEntries(Object.entries(answeredHours).map(([hour, { rang, answered }]) => [hour, (answered + 1) / (rang + 2)]));
}

// Returns null when no day qualifies, which means a custom schedule with no days picked.
export function nextCallTime({ now, timeZone, skipToday = false, random = Math.random, settings = {}, hourWeights = null }) {
  const { callStartHour = WINDOW_START_HOUR, callEndHour = WINDOW_END_HOUR } = settings;
  const today = localParts(now, timeZone);
  const todayNumber = localDayNumber(now, timeZone);
  for (let daysAhead = skipToday ? 1 : 0; daysAhead < DAYS_TO_SEARCH; daysAhead += 1) {
    if (!isCallDay(todayNumber + daysAhead, settings)) continue;
    const start = localToUtc(today.year, today.month, today.day + daysAhead, callStartHour, timeZone);
    const end = localToUtc(today.year, today.month, today.day + daysAhead, callEndHour, timeZone);
    const earliest = Math.max(start, now + MIN_NOTICE_MS);
    if (earliest < end) return momentInWindow(earliest, end, random, timeZone, hourWeights);
  }
  return null;
}
