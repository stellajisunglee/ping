// Streaks. A day that isn't a call day in the user's schedule never breaks one.

import { isCallDay } from './schedule.js';

const LONGEST_GAP_DAYS = 400;

function brokenSince(lastDay, today, settings) {
  if (today - lastDay > LONGEST_GAP_DAYS) return true;
  for (let day = lastDay + 1; day < today; day += 1) {
    if (isCallDay(day, settings)) return true;
  }
  return false;
}

export function recordCallDay(streak, today, settings) {
  if (streak.lastDay !== null && today <= streak.lastDay) return streak;
  const current = streak.lastDay !== null && !brokenSince(streak.lastDay, today, settings) ? streak.current + 1 : 1;
  return { current, best: Math.max(streak.best, current), lastDay: today };
}

export function streakToShow(streak, today, settings) {
  const broken = streak.lastDay === null || brokenSince(streak.lastDay, today, settings);
  return { current: broken ? 0 : streak.current, best: streak.best };
}
