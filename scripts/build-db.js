// Builds one SQLite file for analysis from a data export (GET /api/export, or readDataDir below for a local DATA_DIR).
// The server keeps some facts in more than one place (a call's length is in the call log and the Calls tab history);
// here each fact is stored once, in one table per kind of thing, joined by ids, with views that do the usual joins.
// Uses Node's built-in SQLite, so there's nothing to install.
//
// Tables: learners, calls (every call, connected or not), call_setup, turn_metrics, learning_metrics, ratings,
// level_estimates, words, sentences, scenario_checks, recordings, transcript_lines, feedback.
// Views: call_facts (one row per call with everything joined), learner_weeks (each learner's weeks since joining).

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { METRIC_FIELDS } from '../public/turn-metrics.js';
import { LEARNING_FIELDS } from '../public/learning-metrics.js';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const value = (v) => (v === undefined || v === null ? null : typeof v === 'boolean' ? Number(v) : typeof v === 'object' ? JSON.stringify(v) : v);

// Fields of a call log entry that belong to other tables (or are worked out in call_facts), so call_setup is
// only how the call was set up.
const NOT_SETUP = new Set([
  'callId', 'userId', 'joinedWith', 'at', 'direction', 'seconds',
  ...METRIC_FIELDS, ...LEARNING_FIELDS,
  'cutOffs', 'naturalness', 'commented',
  'estimatedLevel', 'estimatedVocabulary', 'estimatedGrammar', 'levelConfidence',
  'userCallSharePercent', 'avgTurnMs',
]);

function table(db, name, columns, rows, key = null) {
  db.exec(`CREATE TABLE ${name} (${columns.map((column) => `"${column}"${column === key ? ' PRIMARY KEY' : ''}`).join(', ')})`);
  const insert = db.prepare(`INSERT OR REPLACE INTO ${name} VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of rows) insert.run(...columns.map((column) => value(row[column])));
  return rows.length;
}

// A local DATA_DIR (the simulation, or a copy of Render's disk) in the same shape the export endpoint sends.
export function readDataDir(dataDir) {
  const store = JSON.parse(readFileSync(join(dataDir, 'ping.json'), 'utf8'));
  const users = Object.values(store.users).map(({ tokenHash, subscription, ...user }) => ({ ...user, hasSubscription: Boolean(subscription) }));
  const recordings = [];
  const folder = join(dataDir, 'recordings');
  if (existsSync(folder)) {
    for (const userId of readdirSync(folder)) {
      for (const file of readdirSync(join(folder, userId)).filter((name) => name.endsWith('.json'))) recordings.push(JSON.parse(readFileSync(join(folder, userId, file), 'utf8')));
    }
  }
  return { exportedAt: Date.now(), data: { users, calls: Object.values(store.calls ?? {}), callLog: store.callLog ?? [], scenarioChecks: store.scenarioChecks ?? [], feedback: store.feedback ?? [] }, recordings };
}

// audioPath(recording) says where a recording's audio was saved, or null.
export function buildDatabase(exported, dbPath, { audioPath = () => null } = {}) {
  if (dbPath !== ':memory:') rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  const { users, callLog = [], scenarioChecks = [], feedback = [] } = exported.data;
  const logged = new Map(callLog.map((entry) => [entry.callId, entry]));
  const counts = {};
  db.exec('BEGIN');

  counts.learners = table(db, 'learners', ['userId', 'role', 'joinedWith', 'plan', 'joinedAt', 'timeZone', 'selfLevel', 'formality', 'speed', 'thinkingTime', 'callStartHour', 'callEndHour', 'frequency', 'callsEnabled', 'recordingOff', 'levelChosen', 'hasSubscription', 'policyVersion', 'streakCurrent', 'streakBest', 'connectedCalls'],
    users.map((user) => ({
      userId: user.id, role: user.role, joinedWith: user.joinedWith, plan: user.plan, joinedAt: iso(user.joinedAt), timeZone: user.timeZone,
      selfLevel: user.settings?.proficiency, formality: user.settings?.formality, speed: user.settings?.speed, thinkingTime: user.settings?.thinkingTime,
      callStartHour: user.settings?.callStartHour, callEndHour: user.settings?.callEndHour, frequency: user.settings?.frequency, callsEnabled: user.settings?.callsEnabled,
      recordingOff: Boolean(user.recordingOff), levelChosen: user.levelChosen, hasSubscription: user.hasSubscription, policyVersion: user.policyVersion,
      streakCurrent: user.streak?.current, streakBest: user.streak?.best, connectedCalls: user.connectedCalls,
    })), 'userId');

  // Every call, connected or not. The Calls tab history is the source; calls from before it existed come from the call log.
  const callRows = [];
  const seen = new Set();
  for (const user of users) {
    for (const entry of user.callHistory ?? []) {
      seen.add(entry.callId);
      callRows.push({
        callId: entry.callId, userId: user.id, contactId: entry.contactId, direction: entry.direction, startedBy: entry.direction === 'incoming' ? 'ping' : 'learner',
        at: iso(entry.at), localHour: entry.localHour, selfLevel: entry.selfLevel ?? logged.get(entry.callId)?.proficiency, outcome: entry.outcome,
        connected: entry.outcome === 'connected', seconds: entry.seconds ?? logged.get(entry.callId)?.seconds, pickupSeconds: entry.pickupSeconds, test: Boolean(entry.test),
      });
    }
  }
  for (const entry of callLog) {
    if (seen.has(entry.callId)) continue;
    callRows.push({ callId: entry.callId, userId: entry.userId, contactId: entry.contactId, direction: entry.direction, startedBy: entry.direction === 'incoming' ? 'ping' : 'learner', at: iso(entry.at), localHour: null, selfLevel: entry.proficiency, outcome: 'connected', connected: true, seconds: entry.seconds, pickupSeconds: null, test: false });
  }
  counts.calls = table(db, 'calls', ['callId', 'userId', 'contactId', 'direction', 'startedBy', 'at', 'localHour', 'selfLevel', 'outcome', 'connected', 'seconds', 'pickupSeconds', 'test'], callRows, 'callId');

  const setupColumns = ['callId', ...new Set(callLog.flatMap((entry) => Object.keys(entry)).filter((key) => !NOT_SETUP.has(key)))];
  counts.call_setup = table(db, 'call_setup', setupColumns, callLog, 'callId');
  const withAny = (fields) => callLog.filter((entry) => fields.some((field) => entry[field] !== undefined));
  counts.turn_metrics = table(db, 'turn_metrics', ['callId', ...METRIC_FIELDS], withAny(METRIC_FIELDS), 'callId');
  counts.learning_metrics = table(db, 'learning_metrics', ['callId', ...LEARNING_FIELDS], withAny(LEARNING_FIELDS), 'callId');

  counts.ratings = table(db, 'ratings', ['callId', 'userId', 'at', 'cutOffs', 'naturalness', 'comment'], users.flatMap((user) => (user.ratings ?? []).map((r) => ({ ...r, userId: user.id, at: iso(r.at) }))), 'callId');
  counts.level_estimates = table(db, 'level_estimates', ['callId', 'userId', 'at', 'level', 'vocabulary', 'grammar', 'confidence', 'reason'], users.flatMap((user) => (user.levelEstimates ?? []).map((e) => ({ ...e, userId: user.id, at: iso(e.at) }))), 'callId');
  counts.words = table(db, 'words', ['wordId', 'userId', 'kanji', 'kana', 'romaji', 'english', 'savedAt'], users.flatMap((user) => (user.words ?? []).map((w) => ({ ...w, wordId: w.id, userId: user.id, savedAt: iso(w.at) }))));
  counts.sentences = table(db, 'sentences', ['sentenceId', 'userId', 'japanese', 'romaji', 'english', 'word', 'savedAt'], users.flatMap((user) => (user.sentences ?? []).map((s) => ({ ...s, sentenceId: s.id, userId: user.id, savedAt: iso(s.at) }))));
  counts.scenario_checks = table(db, 'scenario_checks', ['callId', 'scenarioId', 'checkpointId', 'result', 'at'], scenarioChecks.map((c) => ({ ...c, at: iso(c.at) })));
  counts.recordings = table(db, 'recordings', ['callId', 'userId', 'audio', 'audioFile', 'lineCount', 'learnerLines'], exported.recordings.map((r) => ({ ...r, audioFile: audioPath(r), lineCount: r.lines?.length ?? 0, learnerLines: r.lines?.filter((line) => line.from === 'you').length ?? 0 })), 'callId');
  counts.transcript_lines = table(db, 'transcript_lines', ['callId', 'lineNo', 'speaker', 'text'], exported.recordings.flatMap((r) => (r.lines ?? []).map((line, index) => ({ callId: r.callId, lineNo: index + 1, speaker: line.from === 'you' ? 'learner' : 'contact', text: line.text }))));
  counts.feedback = table(db, 'feedback', ['at', 'text'], feedback.map((f) => ({ ...f, at: iso(f.at) })));

  // One row per call with everything joined, plus the numbers worked out from the rest.
  const setupSelect = setupColumns.filter((column) => !['callId', 'contactId'].includes(column)).map((column) => `s."${column}"`).join(', ');
  db.exec(`CREATE VIEW call_facts AS
    SELECT c.*, ${setupSelect ? `${setupSelect},` : ''}
      ${METRIC_FIELDS.map((field) => `t."${field}"`).join(', ')},
      ${LEARNING_FIELDS.map((field) => `l."${field}"`).join(', ')},
      r.cutOffs, r.naturalness, r.comment,
      e.level AS estimatedLevel, e.vocabulary AS estimatedVocabulary, e.grammar AS estimatedGrammar, e.confidence AS levelConfidence,
      CASE WHEN t.userSpeechMs IS NOT NULL AND t.userSpeechMs + t.agentSpeechMs > 0 THEN ROUND(100.0 * t.userSpeechMs / (t.userSpeechMs + t.agentSpeechMs)) END AS userCallSharePercent,
      CASE WHEN t.userSpeechMs IS NOT NULL AND t.userTurns > 0 THEN ROUND(1.0 * t.userSpeechMs / t.userTurns) END AS avgTurnMs,
      CASE WHEN t.userSpeechMs IS NOT NULL AND l.englishTurnPercent IS NOT NULL THEN ROUND(t.userSpeechMs * (100 - l.englishTurnPercent) / 100.0) END AS japaneseMs
    FROM calls c
    LEFT JOIN call_setup s ON s.callId = c.callId
    LEFT JOIN turn_metrics t ON t.callId = c.callId
    LEFT JOIN learning_metrics l ON l.callId = c.callId
    LEFT JOIN ratings r ON r.callId = c.callId
    LEFT JOIN level_estimates e ON e.callId = c.callId`);

  // Each learner's weeks since joining: Ping's calls and how many they answered, calls they started, and the north star,
  // minutes of Japanese from Ping's calls they answered. Admin test rings are left out.
  db.exec(`CREATE VIEW learner_weeks AS
    SELECT f.userId, CAST((julianday(f.at) - julianday(lr.joinedAt)) / 7 AS INTEGER) + 1 AS week,
      COUNT(*) FILTER (WHERE f.startedBy = 'ping') AS pingCalls,
      COUNT(*) FILTER (WHERE f.startedBy = 'ping' AND f.connected) AS pingCallsAnswered,
      COUNT(*) FILTER (WHERE f.startedBy = 'learner') AS learnerCalls,
      COUNT(*) FILTER (WHERE f.connected) AS connectedCalls,
      ROUND(SUM(CASE WHEN f.startedBy = 'ping' AND f.connected THEN f.japaneseMs ELSE 0 END) / 60000.0, 1) AS unplannedJapaneseMinutes,
      ROUND(SUM(CASE WHEN f.connected THEN f.japaneseMs ELSE 0 END) / 60000.0, 1) AS japaneseMinutes
    FROM call_facts f JOIN learners lr ON lr.userId = f.userId
    WHERE NOT f.test
    GROUP BY f.userId, week`);

  db.exec('COMMIT');
  db.close();
  return counts;
}
