import test from 'node:test';
import assert from 'node:assert/strict';
import { isCallDay, isValidTimeZone, localDay, localDayNumber, localParts, nextCallTime } from '../server/schedule.js';

const hourIn = (ms, timeZone) => localParts(ms, timeZone).hour;

test('a call is always between 10:00 and 20:00 in the user time zone', () => {
  const now = Date.UTC(2026, 9, 31, 3);
  for (const timeZone of ['Asia/Tokyo', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
      const hour = hourIn(nextCallTime({ now, timeZone, skipToday: true, random: () => value }), timeZone);
      assert.ok(hour >= 10 && hour < 20, `${timeZone} got ${hour}`);
    }
  }
});

test('the time spreads across the whole window', () => {
  const now = Date.UTC(2026, 9, 31, 3);
  const earliest = nextCallTime({ now, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0 });
  const latest = nextCallTime({ now, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0.999 });
  assert.equal(hourIn(earliest, 'Asia/Tokyo'), 10);
  assert.equal(hourIn(latest, 'Asia/Tokyo'), 19);
});

test('a new user can be called today if the window is still open', () => {
  const noonInTokyo = Date.UTC(2026, 9, 31, 3);
  const at = nextCallTime({ now: noonInTokyo, timeZone: 'Asia/Tokyo', random: () => 0.5 });
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-10-31');
  assert.ok(at > noonInTokyo);
});

test('after the window closes the call moves to tomorrow', () => {
  const tenPmInTokyo = Date.UTC(2026, 9, 31, 13);
  const at = nextCallTime({ now: tenPmInTokyo, timeZone: 'Asia/Tokyo', random: () => 0.5 });
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-11-01');
});

test('skipToday moves past today, across a month end', () => {
  const noonInTokyo = Date.UTC(2026, 9, 31, 3);
  const at = nextCallTime({ now: noonInTokyo, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0 });
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-11-01');
});

test('the window holds across a daylight saving change', () => {
  // US clocks go back on 2026-11-01.
  const now = Date.UTC(2026, 9, 31, 16);
  const earliest = nextCallTime({ now, timeZone: 'America/New_York', skipToday: true, random: () => 0 });
  assert.deepEqual([localDay(earliest, 'America/New_York'), hourIn(earliest, 'America/New_York')], ['2026-11-01', 10]);
});

test('bad time zones are rejected', () => {
  assert.equal(isValidTimeZone('Asia/Tokyo'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(42), false);
});

const NOON_SATURDAY_IN_TOKYO = Date.UTC(2026, 9, 31, 3);
const weekdayIn = (ms, timeZone) => (localDayNumber(ms, timeZone) + 4) % 7;

test('calls stay inside the hours the user set', () => {
  const settings = { callStartHour: 7, callEndHour: 9 };
  for (const value of [0, 0.5, 0.999]) {
    const hour = hourIn(nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', random: () => value, settings }), 'Asia/Tokyo');
    assert.ok(hour >= 7 && hour < 9, `got ${hour}`);
  }
});

test('hours can run to midnight', () => {
  const at = nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', random: () => 0.999, settings: { callStartHour: 22, callEndHour: 24 } });
  assert.equal(hourIn(at, 'Asia/Tokyo'), 23);
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-10-31');
});

test('weekdays only skips the weekend', () => {
  const at = nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', random: () => 0.5, settings: { frequency: 'weekdays' } });
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-11-02');
});

test('weekends only skips to Saturday', () => {
  const at = nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0.5, settings: { frequency: 'weekends' } });
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-11-01');
  const afterSunday = nextCallTime({ now: at, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0.5, settings: { frequency: 'weekends' } });
  assert.equal(localDay(afterSunday, 'Asia/Tokyo'), '2026-11-07');
});

test('custom days are followed, and no days means no call', () => {
  const at = nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', skipToday: true, random: () => 0.5, settings: { frequency: 'custom', customDays: [3] } });
  assert.equal(weekdayIn(at, 'Asia/Tokyo'), 3);
  assert.equal(nextCallTime({ now: NOON_SATURDAY_IN_TOKYO, timeZone: 'Asia/Tokyo', settings: { frequency: 'custom', customDays: [] } }), null);
});

test('every other day alternates, across a month end', () => {
  const start = localDayNumber(NOON_SATURDAY_IN_TOKYO, 'Asia/Tokyo');
  const settings = { frequency: 'every-other-day' };
  assert.notEqual(isCallDay(start, settings), isCallDay(start + 1, settings));
  assert.equal(isCallDay(start, settings), isCallDay(start + 2, settings));
});
