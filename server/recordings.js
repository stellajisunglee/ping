// Call recordings and transcripts, kept so the Ping team can listen to and review calls.
// Each user's are files in their own folder, outside the main JSON store, since audio is large:
//   recordings/<userId>/<callId>.json   who, when, which contact, and the transcript
//   recordings/<userId>/<callId>.m4a    or .webm: both voices, as the phone recorded them
// They're kept until the user deletes their account. See "Call recordings" in the README.

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Safari records mp4 (saved as .m4a), Chrome and Firefox record webm. Nothing else is accepted.
const AUDIO_TYPES = { 'audio/mp4': 'm4a', 'audio/webm': 'webm' };
const TYPE_FOR_EXTENSION = { m4a: 'audio/mp4', webm: 'audio/webm' };
const SAFE_ID = /^[\w-]{1,64}$/; // user and call ids become file names, so nothing like ../ gets through

// The extension for an uploaded file's Content-Type, or null if it isn't a recording the app makes.
export function audioExtension(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return AUDIO_TYPES[type] ?? null;
}

export class Recordings {
  constructor(dir) {
    this.dir = dir;
  }

  #folder(userId) {
    return join(this.dir, userId);
  }

  // Written to a temporary file first, so a crash mid-write never leaves half a file.
  #write(path, data) {
    const temp = `${path}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, path);
  }

  #readInfo(userId, callId) {
    try {
      return JSON.parse(readFileSync(join(this.#folder(userId), `${callId}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  // info is { userId, callId, ... } from CallEngine.recordingInfo. It's saved with each call,
  // because calls themselves are removed from the main store after 7 days.
  #saveInfo(info, change) {
    mkdirSync(this.#folder(info.userId), { recursive: true });
    const saved = { ...this.#readInfo(info.userId, info.callId), ...info, ...change };
    this.#write(join(this.#folder(info.userId), `${info.callId}.json`), JSON.stringify(saved));
  }

  #valid(info) {
    return SAFE_ID.test(String(info?.userId)) && SAFE_ID.test(String(info?.callId));
  }

  saveAudio(info, buffer, extension) {
    if (!this.#valid(info) || !TYPE_FOR_EXTENSION[extension]) return false;
    mkdirSync(this.#folder(info.userId), { recursive: true });
    // A second upload of the same call replaces the first, even in the other format.
    for (const other of Object.keys(TYPE_FOR_EXTENSION)) {
      if (other !== extension) rmSync(join(this.#folder(info.userId), `${info.callId}.${other}`), { force: true });
    }
    this.#write(join(this.#folder(info.userId), `${info.callId}.${extension}`), buffer);
    this.#saveInfo(info, { audio: extension, audioBytes: buffer.length });
    return true;
  }

  saveTranscript(info, lines) {
    if (!this.#valid(info)) return false;
    this.#saveInfo(info, { lines });
    return true;
  }

  // Every recorded call, newest first, without the transcripts.
  list() {
    if (!existsSync(this.dir)) return [];
    const calls = [];
    for (const userId of readdirSync(this.dir)) {
      if (!SAFE_ID.test(userId) || !statSync(this.#folder(userId)).isDirectory()) continue;
      for (const file of readdirSync(this.#folder(userId))) {
        if (!file.endsWith('.json')) continue;
        const info = this.#readInfo(userId, file.slice(0, -'.json'.length));
        if (!info) continue;
        const { lines = [], ...rest } = info;
        calls.push({ ...rest, lineCount: lines.length });
      }
    }
    return calls.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  // One call with its transcript, or null.
  find(callId) {
    if (!SAFE_ID.test(String(callId)) || !existsSync(this.dir)) return null;
    for (const userId of readdirSync(this.dir)) {
      if (!SAFE_ID.test(userId)) continue;
      const info = this.#readInfo(userId, callId);
      if (info) return { lines: [], ...info };
    }
    return null;
  }

  // A readable stream of the call's audio with its type and size, or null if there's none.
  audio(callId) {
    const info = this.find(callId);
    if (!info?.audio) return null;
    const path = join(this.#folder(info.userId), `${callId}.${info.audio}`);
    if (!existsSync(path)) return null;
    return { type: TYPE_FOR_EXTENSION[info.audio], size: statSync(path).size, stream: () => createReadStream(path) };
  }

  deleteUser(userId) {
    if (!SAFE_ID.test(String(userId))) return;
    rmSync(this.#folder(userId), { recursive: true, force: true });
  }
}
