import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioExtension, Recordings } from '../server/recordings.js';
import { recordingLocked, recordsCalls } from '../server/calls.js';

const fresh = () => new Recordings(join(mkdtempSync(join(tmpdir(), 'ping-recordings-')), 'recordings'));
const info = (callId, at, userId = 'user-1') => ({ userId, callId, at, contactName: 'Ping', joinedWith: 'beta' });
const readAll = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test('admins and beta testers always record; YC reviewers and everyone else can turn it off', () => {
  assert.equal(recordingLocked({ role: 'admin', joinedWith: 'admin' }), true);
  assert.equal(recordingLocked({ role: 'beta', joinedWith: 'beta' }), true);
  assert.equal(recordingLocked({ role: 'beta', joinedWith: 'yc' }), false);
  assert.equal(recordsCalls({ role: 'beta', joinedWith: 'yc', recordingOff: false }), true);
  assert.equal(recordsCalls({ role: 'beta', joinedWith: 'yc', recordingOff: true }), false);
  assert.equal(recordsCalls({ role: 'admin', joinedWith: 'admin', recordingOff: true }), true);
});

test('only the audio formats the app records are accepted', () => {
  assert.equal(audioExtension('audio/mp4'), 'm4a');
  assert.equal(audioExtension('Audio/MP4'), 'm4a');
  assert.equal(audioExtension('audio/webm;codecs=opus'), 'webm');
  for (const other of ['audio/ogg', 'text/plain', '', undefined]) assert.equal(audioExtension(other), null);
});

test("a call's audio and transcript are kept together, and the list is newest first without transcripts", async () => {
  const recordings = fresh();
  assert.deepEqual(recordings.list(), []);
  const lines = [{ from: 'contact', text: '元気？' }, { from: 'you', text: 'うん、元気' }];
  recordings.saveAudio(info('call-1', 1000), Buffer.from('first'), 'm4a');
  recordings.saveTranscript({ ...info('call-1', 1000), seconds: 42 }, lines);
  recordings.saveTranscript(info('call-2', 2000, 'user-2'), lines);

  const listed = recordings.list();
  assert.deepEqual(listed.map((call) => call.callId), ['call-2', 'call-1']);
  assert.equal(listed[1].audio, 'm4a');
  assert.equal(listed[1].seconds, 42); // the later save adds to the first
  assert.equal(listed[1].lineCount, 2);
  assert.equal(listed[1].lines, undefined);
  assert.equal(listed[0].audio, undefined); // a transcript with no audio uploaded

  assert.deepEqual(recordings.find('call-1').lines, lines);
  const audio = recordings.audio('call-1');
  assert.equal(audio.type, 'audio/mp4');
  assert.equal(audio.size, 5);
  assert.equal((await readAll(audio.stream())).toString(), 'first');
  assert.equal(recordings.audio('call-2'), null);
  assert.equal(recordings.find('missing'), null);
});

test('a second upload of a call replaces the first, even in the other format', () => {
  const recordings = fresh();
  recordings.saveAudio(info('call-1', 1000), Buffer.from('mp4'), 'm4a');
  recordings.saveAudio(info('call-1', 1000), Buffer.from('webm audio'), 'webm');
  assert.deepEqual(readdirSync(join(recordings.dir, 'user-1')).sort(), ['call-1.json', 'call-1.webm']);
  assert.equal(recordings.audio('call-1').type, 'audio/webm');
});

test('ids that could reach outside the folder, and unknown formats, are refused', () => {
  const recordings = fresh();
  assert.equal(recordings.saveAudio(info('../escape', 1), Buffer.from('x'), 'm4a'), false);
  assert.equal(recordings.saveAudio(info('call-1', 1, '../user'), Buffer.from('x'), 'm4a'), false);
  assert.equal(recordings.saveAudio(info('call-1', 1), Buffer.from('x'), 'exe'), false);
  assert.equal(recordings.saveTranscript(info('a/b', 1), []), false);
  assert.equal(recordings.find('../escape'), null);
  assert.equal(existsSync(recordings.dir), false);
});

test("deleting a user removes only that user's recordings", () => {
  const recordings = fresh();
  recordings.saveAudio(info('call-1', 1000, 'user-1'), Buffer.from('a'), 'm4a');
  recordings.saveAudio(info('call-2', 2000, 'user-2'), Buffer.from('b'), 'm4a');
  recordings.deleteUser('user-1');
  recordings.deleteUser('../user-2'); // ignored
  assert.deepEqual(recordings.list().map((call) => call.callId), ['call-2']);
});
