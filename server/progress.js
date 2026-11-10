// Streaks. A day that isn't a call day in the user's schedule never breaks one.

import { isCallDay } from './schedule.js';

const LONGEST_GAP_DAYS = 400;
const KEEP_PRACTICE_DAYS = 14; // day numbers only, enough for Home's last 7 days
const WEEK_DAYS = 7;

function brokenSince(lastDay, today, settings) {
  if (today - lastDay > LONGEST_GAP_DAYS) return true;
  for (let day = lastDay + 1; day < today; day += 1) {
    if (isCallDay(day, settings)) return true;
  }
  return false;
}

// Streaks recorded before practice days were kept: the streak's days, counted back from its last day
// over the user's call days. Wrong only if they also called on a day off.
function estimatedDays(streak, settings) {
  if (streak.lastDay === null || !(streak.current > 0)) return [];
  const days = [streak.lastDay];
  for (let day = streak.lastDay - 1; days.length < Math.min(streak.current, KEEP_PRACTICE_DAYS) && streak.lastDay - day <= LONGEST_GAP_DAYS; day -= 1) {
    if (isCallDay(day, settings)) days.unshift(day);
  }
  return days;
}

const practiceDays = (streak, settings) => streak.days ?? estimatedDays(streak, settings);

export function recordCallDay(streak, today, settings) {
  if (streak.lastDay !== null && today <= streak.lastDay) return streak;
  const current = streak.lastDay !== null && !brokenSince(streak.lastDay, today, settings) ? streak.current + 1 : 1;
  const days = [...practiceDays(streak, settings), today].slice(-KEEP_PRACTICE_DAYS);
  return { current, best: Math.max(streak.best, current), lastDay: today, days };
}

// Home's row of the last 7 days, today last. weekday 0 is Sunday.
export function streakToShow(streak, today, settings) {
  const broken = streak.lastDay === null || brokenSince(streak.lastDay, today, settings);
  const practiced = new Set(practiceDays(streak, settings));
  const week = Array.from({ length: WEEK_DAYS }, (_, index) => {
    const day = today - (WEEK_DAYS - 1) + index;
    return { weekday: (day + 4) % 7, practiced: practiced.has(day), callDay: isCallDay(day, settings), today: day === today };
  });
  return { current: broken ? 0 : streak.current, best: streak.best, week };
}
