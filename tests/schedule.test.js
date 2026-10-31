import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimeZone, localDay, localParts, nextCallTime } from '../server/schedule.js';

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
