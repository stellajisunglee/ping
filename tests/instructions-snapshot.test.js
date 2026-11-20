// Golden copies of the contact's instructions, so a change to how they're put together can't change
// what a contact is told without someone seeing it. Each case is saved word for word in
// tests/fixtures/instructions/. After an intended change, rewrite them with
//   UPDATE_SNAPSHOTS=1 node --test tests/instructions-snapshot.test.js
// and read the diff before committing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildInstructions, openingWords, PROMPT_VERSION, questionById } from '../server/tutor.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const DIR = new URL('./fixtures/instructions/', import.meta.url);
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// A fixed date, so Ping's day (server/persona.js) is the same on every run. 15 November 2026 is a Sunday.
const LOCAL_DATE = { year: 2026, month: 11, day: 15 };
const YUKI = { id: 'custom-yuki', name: 'Yuki', spokenName: 'ユキ', topic: 'cooking and recipes', voice: 'cedar', plan: 'platinum' };
const MEMORIES = ['週末は友達と京都に行きます。お寺を見たいです。', 'ラーメンが好きです。昨日は味噌ラーメンを食べました。'];
const settings = (change) => ({ ...DEFAULT_SETTINGS, ...change });
// A fingerprint of every case's instructions and opening words, for each PROMPT_VERSION. Calls are compared by
// prompt version in the call log, so the version has to change whenever the words do.
const FINGERPRINTS = { 1: '7a173835eec3dd0a8458a1359fe44bdeab6ef07fcbc036eca1c371d79e289a85', 2: '83e4338da6407d17aeb67f92e8d0b79d7d8b14e5a53dfc9daae70b930fd98154' };

// Between them: Ping and a custom contact, every JLPT level and speech style, the contact calling or being
// called back at each time of day (including after midnight), and memories or none.
export const CASES = [
  { name: 'ping-n5-formal-incoming-morning', question: 'day', localHour: 9, calledBack: false, settings: settings({ proficiency: 'N5', formality: 'formal' }) },
  { name: 'ping-n4-formal-callback-afternoon', question: 'eat', localHour: 14, calledBack: true, settings: settings({ proficiency: 'N4', formality: 'formal' }) },
  { name: 'ping-n3-casual-incoming-evening', question: 'weekend', localHour: 19, calledBack: false, settings: settings({ proficiency: 'N3', formality: 'casual' }) },
  { name: 'ping-n1-casual-callback-after-midnight', question: 'lately', localHour: 2, calledBack: true, settings: settings({ proficiency: 'N1', formality: 'casual' }) },
  { name: 'ping-n2-formal-incoming-night', question: 'doing', localHour: 23, calledBack: false, settings: settings({ proficiency: 'N2', formality: 'formal' }) },
  { name: 'ping-n3-formal-callback-memories', question: 'did', localHour: 15, calledBack: true, settings: settings({ proficiency: 'N3', formality: 'formal' }), memories: MEMORIES },
  { name: 'custom-n5-formal-incoming', question: 'day', localHour: 10, calledBack: false, contact: YUKI, settings: settings({ proficiency: 'N5', formality: 'formal' }) },
  { name: 'custom-n1-casual-callback-memories', question: 'eat', localHour: 20, calledBack: true, contact: YUKI, settings: settings({ proficiency: 'N1', formality: 'casual' }), memories: MEMORIES },
];

const inputsFor = ({ question, localHour, calledBack, contact, settings: caseSettings, memories }) => ({
  question: questionById(question),
  localHour,
  localDate: LOCAL_DATE,
  calledBack,
  ...(contact ? { contact } : {}),
  settings: caseSettings,
  ...(memories ? { memories } : {}),
});

function matchesSaved(file, actual) {
  const url = new URL(file, DIR);
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(url, actual);
    return;
  }
  assert.equal(actual, readFileSync(url, 'utf8'), `${file} changed. If that was intended, rewrite it with UPDATE_SNAPSHOTS=1.`);
}

for (const testCase of CASES) {
  test(`the instructions are unchanged: ${testCase.name}`, () => {
    matchesSaved(`${testCase.name}.txt`, buildInstructions(inputsFor(testCase)));
  });
}

// Deepgram speaks these itself, so they're part of what the contact says too.
test('the opening words are unchanged', () => {
  const words = Object.fromEntries(
    CASES.map((testCase) => {
      const { question, contact, settings: caseSettings, calledBack, localHour } = inputsFor(testCase);
      return [testCase.name, openingWords({ question, contact, formality: caseSettings.formality, calledBack, localHour })];
    }),
  );
  matchesSaved('opening-words.json', `${JSON.stringify(words, null, 2)}\n`);
});

test('a default call with no memories still gets no memory section', () => {
  assert.ok(!buildInstructions(inputsFor(CASES[0])).includes('WHAT YOU REMEMBER'));
  assert.ok(buildInstructions(inputsFor(CASES[5])).includes('WHAT YOU REMEMBER'));
});

test('the prompt version changes whenever the instructions do', () => {
  const hash = createHash('sha256');
  for (const testCase of CASES) {
    const { question, contact, settings: caseSettings, calledBack, localHour } = inputsFor(testCase);
    hash.update(`${buildInstructions(inputsFor(testCase))}\0${openingWords({ question, contact, formality: caseSettings.formality, calledBack, localHour })}\0`);
  }
  const fingerprint = hash.digest('hex');
  assert.equal(
    FINGERPRINTS[PROMPT_VERSION],
    fingerprint,
    `The instructions changed. Raise PROMPT_VERSION in server/prompt.js and add { ${PROMPT_VERSION + 1}: '${fingerprint}' } to FINGERPRINTS here.`,
  );
});
