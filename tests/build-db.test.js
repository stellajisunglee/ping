import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDatabase } from '../scripts/build-db.js';

const DAY = 86_400_000;
const joined = Date.UTC(2026, 10, 23);
const exported = {
  exportedAt: joined + 20 * DAY,
  data: {
    users: [{
      id: 'u1', role: 'beta', joinedWith: 'beta', plan: 'free', joinedAt: joined, timeZone: 'America/Los_Angeles', hasSubscription: true,
      settings: { proficiency: 'N4', formality: 'formal', speed: 1, thinkingTime: 'normal', callStartHour: 18, callEndHour: 21, frequency: 'daily', callsEnabled: true },
      name: 'Stella', nameReading: 'ステラ', onboarded: true, onboardedAt: joined + 60_000, levelChosenAt: joined + 50_000,
      settingsChanges: [
        { at: joined + 40_000, field: 'callStartHour', from: 10, to: 18, duringCall: false },
        { at: joined + 50_000, field: 'proficiency', from: 'N5', to: 'new', duringCall: false },
        { at: joined + 9 * DAY, field: 'proficiency', from: 'new', to: 'N4', duringCall: true },
      ],
      callHistory: [
        { callId: 'c1', contactId: 'ping', direction: 'incoming', at: joined + DAY, localHour: 18, selfLevel: 'N4', outcome: 'connected', seconds: 150, pickupSeconds: 5 },
        { callId: 'c2', contactId: 'ping', direction: 'incoming', at: joined + 2 * DAY, localHour: 11, selfLevel: 'N4', outcome: 'missed', seconds: null, pickupSeconds: null },
        { callId: 'c3', contactId: 'ping', direction: 'outgoing', at: joined + 9 * DAY, localHour: 19, selfLevel: 'N4', outcome: 'connected', seconds: 90, pickupSeconds: null },
        { callId: 't1', contactId: 'ping', direction: 'incoming', at: joined + 9 * DAY, localHour: 12, selfLevel: 'N4', outcome: 'missed', test: true },
      ],
      ratings: [{ callId: 'c1', at: joined + DAY, engine: 'gpt-realtime', turnMode: 'silence', speakingConfidence: 3, cutOffs: 1, naturalness: 4, comment: 'Natural!' }],
      goal: 'travel',
      checkIns: [
        { at: joined + 60_000, source: 'start', comfort: 2, outside: 0 },
        { at: joined + 8 * DAY, source: 'weekly', comfort: 3, outside: 1 },
        { at: joined + 15 * DAY, source: 'weekly', comfort: 4, outside: 1 },
      ],
      levelEstimates: [{ callId: 'c1', at: joined + DAY, level: 'N4', vocabulary: 'N4', grammar: 'N5', confidence: 'medium', reason: 'Complete sentences.' }],
      words: [{ id: 'w1', kanji: '予定', kana: 'よてい', romaji: 'yotei', english: 'plan', at: joined + DAY }],
      sentences: [],
      progress: [],
    }],
    callLog: [
      { callId: 'c1', userId: 'u1', joinedWith: 'beta', at: joined + DAY, direction: 'incoming', engine: 'gpt-realtime', turnMode: 'silence', proficiency: 'N4', callStartHour: 18, callEndHour: 21, frequency: 'daily', seconds: 150, userSpeechMs: 60_000, agentSpeechMs: 60_000, userTurns: 6, replyGapMedianMs: 2000, suspectedCutoffs: 0, englishTurnPercent: 25, japaneseChars: 120, naturalness: 4, cutOffs: 1, estimatedLevel: 'N4', userCallSharePercent: 50 },
      { callId: 'c3', userId: 'u1', joinedWith: 'beta', help_lookup: 1, helpRequestsByTools: 1,
        turns: [{ index: 0, atMs: 500, userSpeechMs: null, answerStartMs: null, endWaitMs: null, gapMs: null, replyMs: 2000, endedBy: null, cutOff: false, talkedOver: false, aizuchi: 0, providerLatencyMs: 900 }],
        help: [{ type: 'lookup', atMs: 4000, turn: 0 }],
        at: joined + 9 * DAY, direction: 'outgoing', engine: 'deepgram-agent', turnMode: null, proficiency: 'N4', seconds: 90, userSpeechMs: 30_000, agentSpeechMs: 30_000, userTurns: 4, englishTurnPercent: 0 },
      { callId: 'old', userId: 'u1', joinedWith: 'beta', at: joined + 3 * DAY, direction: 'incoming', engine: 'gpt-realtime', turnMode: 'smartTurn', proficiency: 'beginner', seconds: 60 },
    ],
    scenarioChecks: [],
    feedback: [{ at: joined, text: 'Love it' }],
  },
  recordings: [{ userId: 'u1', callId: 'c1', audio: 'm4a', lines: [{ from: 'contact', text: '今日は何をしましたか？' }, { from: 'you', text: '映画を見ました。' }] }],
};

test('each fact is stored once, in its own table, joined by ids', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ping-db-')), 'ping.sqlite');
  const counts = buildDatabase(exported, path, { audioPath: () => '/audio/u1/c1.m4a' });
  assert.deepEqual([counts.learners, counts.calls, counts.call_setup, counts.ratings, counts.transcript_lines], [1, 5, 3, 1, 2]);
  const db = new DatabaseSync(path);
  const setupColumns = db.prepare('PRAGMA table_info(call_setup)').all().map((column) => column.name);
  assert.ok(setupColumns.includes('engine') && !setupColumns.includes('naturalness') && !setupColumns.includes('userSpeechMs') && !setupColumns.includes('seconds'), 'ratings, metrics and length live in their own tables');
  const old = db.prepare("SELECT outcome, connected, selfLevel FROM calls WHERE callId = 'old'").get();
  assert.deepEqual({ ...old }, { outcome: 'connected', connected: 1, selfLevel: 'beginner' }, 'calls from before the Calls tab come from the call log');
  const c1 = db.prepare("SELECT naturalness, estimatedLevel, japaneseMs, userCallSharePercent, avgTurnMs, startedBy FROM call_facts WHERE callId = 'c1'").get();
  assert.deepEqual({ ...c1 }, { naturalness: 4, estimatedLevel: 'N4', japaneseMs: 45_000, userCallSharePercent: 50, avgTurnMs: 10_000, startedBy: 'ping' });
  const weeks = db.prepare('SELECT week, pingCalls, pingCallsAnswered, learnerCalls, unplannedJapaneseMinutes FROM learner_weeks ORDER BY week').all().map((row) => ({ ...row }));
  assert.deepEqual(weeks, [
    { week: 1, pingCalls: 3, pingCallsAnswered: 2, learnerCalls: 0, unplannedJapaneseMinutes: 0.8 },
    { week: 2, pingCalls: 0, pingCallsAnswered: 0, learnerCalls: 1, unplannedJapaneseMinutes: 0 },
  ], 'the test ring is left out; only Ping-started calls count as unplanned');
  assert.equal(db.prepare("SELECT audioFile FROM recordings WHERE callId = 'c1'").get().audioFile, '/audio/u1/c1.m4a');
  db.close();
});

test('the call window, level changes and onboarding come out cleanly, with levels as numbers and no names', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ping-db-')), 'ping.sqlite');
  const counts = buildDatabase(exported, path);
  assert.equal(counts.settings_changes, 3);
  const db = new DatabaseSync(path);
  const learner = { ...db.prepare('SELECT * FROM learners').get() };
  assert.deepEqual([learner.selfLevel, learner.selfLevelRank, learner.callStartHour, learner.onboarded, learner.nameGiven], ['N4', 2, 18, 1, 1]);
  assert.ok(learner.onboardedAt && learner.levelChosenAt);
  assert.ok(!JSON.stringify(learner).includes('Stella') && !JSON.stringify(learner).includes('ステラ'), "the learner's name stays out of the analysis file");
  const changes = db.prepare("SELECT fromValue, toValue, duringCall FROM settings_changes WHERE field = 'proficiency' ORDER BY at").all().map((row) => ({ ...row }));
  assert.deepEqual(changes, [{ fromValue: 'N5', toValue: 'new', duringCall: 0 }, { fromValue: 'new', toValue: 'N4', duringCall: 1 }]);
  const setup = { ...db.prepare("SELECT callStartHour, callEndHour, frequency FROM call_setup WHERE callId = 'c1'").get() };
  assert.deepEqual(setup, { callStartHour: 18, callEndHour: 21, frequency: 'daily' });
  assert.equal(db.prepare("SELECT selfLevelRank FROM calls WHERE callId = 'old'").get().selfLevelRank, 1, 'beginner, from before JLPT, ranks with N5');
  assert.equal(db.prepare("SELECT estimatedLevelRank FROM call_facts WHERE callId = 'c1'").get().estimatedLevelRank, 2);
  db.close();
});

test('per-turn records and help events get their own tables, out of call_setup', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ping-db-')), 'ping.sqlite');
  const counts = buildDatabase(exported, path);
  assert.deepEqual([counts.turns, counts.help_events], [1, 1]);
  const db = new DatabaseSync(path);
  assert.deepEqual({ ...db.prepare('SELECT callId, replyMs, providerLatencyMs, cutOff FROM turns').get() }, { callId: 'c3', replyMs: 2000, providerLatencyMs: 900, cutOff: 0 });
  assert.deepEqual({ ...db.prepare('SELECT type, turn FROM help_events').get() }, { type: 'lookup', turn: 0 });
  const setupColumns = db.prepare('PRAGMA table_info(call_setup)').all().map((column) => column.name);
  assert.ok(!setupColumns.includes('turns') && !setupColumns.includes('help_lookup'));
  db.close();
});

test('goals and check-ins come out for confidence research: each answer, and each learner from first to latest', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ping-db-')), 'ping.sqlite');
  const counts = buildDatabase(exported, path);
  assert.equal(counts.check_ins, 3);
  const db = new DatabaseSync(path);
  const learner = db.prepare('SELECT goal, formality, speed, thinkingTime FROM learners').get();
  assert.deepEqual({ ...learner }, { goal: 'travel', formality: 'formal', speed: 1, thinkingTime: 'normal' }, 'the settings a comment used to swallow are back');
  assert.deepEqual(db.prepare('SELECT source, comfort, outside, daysSinceJoining FROM check_ins ORDER BY at').all().map((row) => ({ ...row })), [
    { source: 'start', comfort: 2, outside: 0, daysSinceJoining: 0 },
    { source: 'weekly', comfort: 3, outside: 1, daysSinceJoining: 8 },
    { source: 'weekly', comfort: 4, outside: 1, daysSinceJoining: 15 },
  ]);
  const trend = db.prepare('SELECT checkIns, firstComfort, latestComfort, comfortChange, firstOutside, latestOutside, daysBetween FROM learner_confidence').get();
  assert.deepEqual({ ...trend }, { checkIns: 3, firstComfort: 2, latestComfort: 4, comfortChange: 2, firstOutside: 0, latestOutside: 1, daysBetween: 15 });
  assert.equal(db.prepare("SELECT speakingConfidence FROM call_facts WHERE callId = 'c1'").get().speakingConfidence, 3);
  db.close();
});
