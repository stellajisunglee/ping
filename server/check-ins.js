// What learners tell Ping about themselves, so their progress can be measured against where they started, not only
// from what happens on calls: why they're learning (once), and a check-in, first before they reach Home and then
// once a week, of two taps:
//   comfort: how comfortable they feel speaking Japanese with another person, 1 (very nervous) to 5 (very comfortable)
//   outside: in the past week, how much they spoke Japanese with someone outside Ping: 0 not at all, 1 a little, 2 a lot
// Comfort is the confidence measure; outside is whether Ping's practice carries into real life. Numbers and one goal
// word only. YC reviewers are only looking around, so they're never asked.

const DAY_MS = 86_400_000;
export const GOALS = ['school', 'work', 'travel', 'partner', 'family', 'culture', 'other'];
export const CHECK_IN_EVERY_DAYS = 7;
export const CHECK_IN_SNOOZE_DAYS = 2; // after "Not now", asked again this much later
export const MAX_CHECK_INS = 520; // ten years of weekly check-ins

const comfortValue = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
const outsideValue = (value) => Number.isInteger(value) && value >= 0 && value <= 2;

// Both answers, each on its scale, or null.
export function cleanCheckIn(body) {
  return comfortValue(body?.comfort) && outsideValue(body?.outside) ? { comfort: body.comfort, outside: body.outside } : null;
}

export const cleanGoal = (value) => (GOALS.includes(value) ? value : null);

const asked = (user) => user.joinedWith !== 'yc';

// Everyone else answers the goal and their first check-in once, before Home: new accounts after picking a level,
// and accounts from before this on their next visit.
export const needsBaseline = (user) => asked(user) && (!user.goal || !(user.checkIns ?? []).length);

// The weekly check-in is due a week after the last one, unless they said "Not now" in the last two days.
export function checkInDue(user, now) {
  const last = (user.checkIns ?? []).at(-1);
  if (!asked(user) || !last || needsBaseline(user)) return false;
  if (user.checkInSnoozedAt && now - user.checkInSnoozedAt < CHECK_IN_SNOOZE_DAYS * DAY_MS) return false;
  return now - last.at >= CHECK_IN_EVERY_DAYS * DAY_MS;
}
