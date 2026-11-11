import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFormat, recordingFileName, startRecording } from '../public/recorder.js';

// Stand-ins for the browser's audio mixing and recording.
function fakeAudio({ supported = ['audio/mp4'], chunks = ['a', 'b'] } = {}) {
  const log = { sources: [], resumed: 0, closed: 0, recorders: [] };
  class AudioContextClass {
    resume() {
      log.resumed += 1;
      return Promise.resolve();
    }
    close() {
      log.closed += 1;
      return Promise.resolve();
    }
    createMediaStreamDestination() {
      return { stream: { id: 'mix' } };
    }
    createMediaStreamSource(stream) {
      return { connect: (destination) => log.sources.push(`${stream.id}->${destination.stream.id}`) };
    }
  }
  class MediaRecorderClass {
    static isTypeSupported = (type) => supported.includes(type);
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      this.mimeType = options.mimeType;
      log.recorders.push(this);
    }
    start(timeslice) {
      this.timeslice = timeslice;
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      for (const chunk of chunks) this.ondataavailable({ data: new Blob([chunk]) });
      queueMicrotask(() => this.onstop());
    }
  }
  return { log, AudioContextClass, MediaRecorderClass };
}

const AT = new Date(2026, 10, 11, 15, 7);

test('Safari records mp4 saved as m4a, and other browsers fall back to webm', () => {
  assert.deepEqual(pickFormat((type) => ['audio/mp4', 'audio/webm'].includes(type)), { mimeType: 'audio/mp4', extension: 'm4a' });
  assert.deepEqual(pickFormat((type) => type === 'audio/webm;codecs=opus'), { mimeType: 'audio/webm;codecs=opus', extension: 'webm' });
  assert.equal(pickFormat(() => false), null);
});

test('the file is named after when the call started, in local time', () => {
  assert.equal(recordingFileName(AT, 'm4a'), 'ping-call-2026-11-11-1507.m4a');
});

test('both voices are mixed into one recording, each stream once', async () => {
  const { log, AudioContextClass, MediaRecorderClass } = fakeAudio();
  const recording = startRecording({ streams: [{ id: 'microphone' }], AudioContextClass, MediaRecorderClass, now: () => AT });
  recording.add({ id: 'contact' });
  recording.add({ id: 'contact' });
  recording.add(undefined);
  assert.deepEqual(log.sources, ['microphone->mix', 'contact->mix']);
  assert.equal(log.resumed, 1);
  const [recorder] = log.recorders;
  assert.equal(recorder.stream.id, 'mix');
  assert.equal(recorder.options.mimeType, 'audio/mp4');
  assert.equal(recorder.timeslice, 1000);

  const result = await recording.stop();
  assert.equal(result.fileName, 'ping-call-2026-11-11-1507.m4a');
  assert.equal(result.blob.type, 'audio/mp4');
  assert.equal(await result.blob.text(), 'ab');
  assert.equal(log.closed, 1);
  // Stopping again gives the same recording.
  assert.equal(await recording.stop(), result);
});

test('a recording with no sound in it comes back empty', async () => {
  const { AudioContextClass, MediaRecorderClass } = fakeAudio({ chunks: [] });
  const recording = startRecording({ streams: [{ id: 'microphone' }], AudioContextClass, MediaRecorderClass });
  assert.equal(await recording.stop(), null);
});

test("a browser that can't record says so instead of failing silently", () => {
  const { AudioContextClass, MediaRecorderClass } = fakeAudio({ supported: [] });
  assert.throws(() => startRecording({ AudioContextClass, MediaRecorderClass }), /can't record audio in a format/);
  assert.throws(() => startRecording({ AudioContextClass, MediaRecorderClass: undefined }), /can't record calls/);
});
