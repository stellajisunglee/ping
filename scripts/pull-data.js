// Copies Ping's data to this laptop for analysis: npm run pull-data
//
// Downloads everything from the live server's export (GET /api/export, which needs EXPORT_KEY), saves the raw
// export, downloads any recording audio not already here, and builds one SQLite file (scripts/build-db.js).
// Each run is a dated snapshot, so data the server removes later (other accounts' calls after 7 days) stays here.
//
// Settings, from .env or the environment:
//   EXPORT_KEY       the same key as on Render (at least 32 characters). Never commit it.
//   PING_URL         default https://ping-jmxg.onrender.com
//   PING_DATA_DIR    where to save, default ~/ping-data. Keep it outside any git repository: it holds transcripts and recordings.
// Or build from a local DATA_DIR instead of the server (the simulation, or a copy of Render's disk):
//   node scripts/pull-data.js --from <DATA_DIR>

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildDatabase, readDataDir } from './build-db.js';

const AUDIO_EXTENSIONS = { 'audio/mp4': 'm4a', 'audio/webm': 'webm' };
const fromIndex = process.argv.indexOf('--from');
const localDir = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;
const outDir = process.env.PING_DATA_DIR || join(homedir(), 'ping-data');
const baseUrl = (process.env.PING_URL || 'https://ping-jmxg.onrender.com').replace(/\/$/, '');
const key = process.env.EXPORT_KEY ?? '';
const stamp = new Date().toISOString().slice(0, 16).replace(':', '');

async function fromServer() {
  if (key.length < 32) throw new Error('Set EXPORT_KEY (at least 32 characters, the same as on Render) in .env first.');
  const response = await fetch(`${baseUrl}/api/export`, { headers: { 'X-Export-Key': key } });
  if (!response.ok) throw new Error(`The export failed (${response.status}): ${(await response.json().catch(() => ({}))).error ?? 'no details'}`);
  return response.json();
}

async function downloadAudio(exported) {
  let fetched = 0;
  const where = new Map();
  for (const recording of exported.recordings) {
    if (!recording.audio) continue;
    const file = join(outDir, 'audio', recording.userId, `${recording.callId}.${recording.audio}`);
    where.set(recording.callId, file);
    if (existsSync(file) || localDir) continue;
    const response = await fetch(`${baseUrl}/api/export/audio/${recording.callId}`, { headers: { 'X-Export-Key': key } });
    if (!response.ok) continue;
    mkdirSync(join(outDir, 'audio', recording.userId), { recursive: true });
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    fetched += 1;
  }
  return { fetched, where };
}

const exported = localDir ? readDataDir(localDir) : await fromServer();
mkdirSync(join(outDir, 'raw'), { recursive: true });
writeFileSync(join(outDir, 'raw', `ping-${stamp}.json`), JSON.stringify(exported));
const { fetched, where } = await downloadAudio(exported);
const dbPath = join(outDir, `ping-${stamp}.sqlite`);
const counts = buildDatabase(exported, dbPath, { audioPath: (recording) => where.get(recording.callId) ?? null });
copyFileSync(dbPath, join(outDir, 'ping-latest.sqlite'));
console.log(`Saved to ${outDir}`);
console.log(`  ping-${stamp}.sqlite (also ping-latest.sqlite): ${Object.entries(counts).map(([name, rows]) => `${name} ${rows}`).join(', ')}`);
console.log(`  raw/ping-${stamp}.json, and ${fetched} new audio file${fetched === 1 ? '' : 's'}${localDir ? ' (none from a local folder)' : ''}`);
