// Picks when Mina calls next, in the user's own time zone.

export const WINDOW_START_HOUR = 10;
export const WINDOW_END_HOUR = 20;
const MIN_NOTICE_MS = 60_000;
const DAY_MS = 86_400_000;

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

export function nextCallTime({ now, timeZone, skipToday = false, random = Math.random }) {
  const today = localParts(now, timeZone);
  for (let daysAhead = skipToday ? 1 : 0; daysAhead < 3; daysAhead += 1) {
    const start = localToUtc(today.year, today.month, today.day + daysAhead, WINDOW_START_HOUR, timeZone);
    const end = localToUtc(today.year, today.month, today.day + daysAhead, WINDOW_END_HOUR, timeZone);
    const earliest = Math.max(start, now + MIN_NOTICE_MS);
    if (earliest < end) return Math.floor(earliest + random() * (end - earliest));
  }
  return now + DAY_MS;
}
