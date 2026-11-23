// Each saved word's progress, so incidental learning on calls can be measured: a word is met (saved on a call),
// comes back (the contact uses it on a later call), is understood (it came back and they didn't ask what it means
// again), and is used (the learner said it themselves). Ping brings back up to WORDS_PER_CALL due words a call, on a
// spaced schedule. Stages only go forward.

export const STAGES = ['met', 'came-back', 'understood', 'used'];
export const WORDS_PER_CALL = 2;
const DAY_MS = 86_400_000;
// Days until a word is due again, after it was met or after each time it came back.
export const COMEBACK_DAYS = [1, 3, 7, 14, 30];

export function wordProgress(word) {
  return {
    stage: 'met',
    comebacks: 0,
    lastComebackAt: null,
    usedCount: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    lookedUpAgain: 0,
    nextDueAt: (word.at ?? 0) + COMEBACK_DAYS[0] * DAY_MS,
    ...word.progress,
  };
}

const later = (stage, next) => (STAGES.indexOf(next) > STAGES.indexOf(stage) ? next : stage);

// The words Ping should bring back on a call now: due, oldest due first, at most WORDS_PER_CALL.
export function dueWords(words, now) {
  return words
    .map((word) => ({ word, progress: wordProgress(word) }))
    .filter(({ progress }) => progress.nextDueAt <= now)
    .sort((a, b) => a.progress.nextDueAt - b.progress.nextDueAt)
    .slice(0, WORDS_PER_CALL)
    .map(({ word }) => word);
}

// What happened to saved words on one call, as the phone saw it: ids of words the contact said (cameBack), the learner
// said (used), and the learner asked about again (lookedUp). Updates each word and returns the events, for the log.
export function applyWordEvents(words, { cameBack = [], used = [], lookedUp = [] }, now) {
  const events = [];
  for (const word of words) {
    const progress = wordProgress(word);
    const came = cameBack.includes(word.id);
    const said = used.includes(word.id);
    const asked = lookedUp.includes(word.id);
    if (!came && !said && !asked) continue;
    if (asked) {
      progress.lookedUpAgain += 1;
      events.push({ wordId: word.id, event: 'looked-up-again' });
    }
    if (came) {
      progress.comebacks += 1;
      progress.lastComebackAt = now;
      progress.stage = later(progress.stage, asked ? 'came-back' : 'understood');
      progress.nextDueAt = now + COMEBACK_DAYS[Math.min(progress.comebacks, COMEBACK_DAYS.length - 1)] * DAY_MS;
      events.push({ wordId: word.id, event: asked ? 'came-back' : 'understood' });
    }
    if (said) {
      progress.usedCount += 1;
      progress.firstUsedAt ??= now;
      progress.lastUsedAt = now;
      progress.stage = 'used';
      events.push({ wordId: word.id, event: 'used' });
    }
    word.progress = progress;
  }
  return events;
}
