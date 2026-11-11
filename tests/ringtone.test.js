import test from 'node:test';
import assert from 'node:assert/strict';
import { audioUnlocked, resetAudio, startRingtone, unlockAudio } from '../public/ringtone.js';

// A stand-in audio context that notes what was played.
function fakeAudio({ startsRunning = false } = {}) {
  const log = { contexts: 0, resumes: 0, silences: 0, tones: [], instances: [] };
  class AudioContextClass {
    constructor() {
      log.contexts += 1;
      log.instances.push(this);
      this.state = startsRunning ? 'running' : 'suspended';
      this.currentTime = 10;
      this.destination = { name: 'speaker' };
    }
    resume() {
      log.resumes += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    createBuffer() {
      return {};
    }
    createBufferSource() {
      return { connect() {}, start: () => (log.silences += 1) };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (to) => to };
    }
    createOscillator() {
      const tone = { frequency: {}, connect() {}, start: (at) => log.tones.push({ hz: tone.frequency.value, at }), stop() {} };
      return tone;
    }
  }
  return { log, AudioContextClass };
}

test('the first tap sets up one audio context and plays silence to unlock it', () => {
  resetAudio();
  const { log, AudioContextClass } = fakeAudio();
  assert.equal(audioUnlocked(), false);
  unlockAudio(AudioContextClass);
  assert.equal(audioUnlocked(), true);
  unlockAudio(AudioContextClass);
  assert.deepEqual({ contexts: log.contexts, resumes: log.resumes, silences: log.silences }, { contexts: 1, resumes: 1, silences: 1 });
});

test('once unlocked, a call rings with the two-tone trill and vibrates, until stopped', () => {
  resetAudio();
  const { log, AudioContextClass } = fakeAudio();
  unlockAudio(AudioContextClass);
  const buzzes = [];
  const stop = startRingtone({ vibrate: (pattern) => buzzes.push(pattern) });
  stop();
  // Two bursts, each with both tones.
  assert.deepEqual(log.tones.map(({ hz }) => hz), [440, 480, 440, 480]);
  assert.ok(log.tones.every(({ at }) => at > 10));
  assert.deepEqual(buzzes, [[400, 200, 400], 0]);
});

test('before any tap there is no sound to play, but ringing still vibrates and never fails', () => {
  resetAudio();
  const buzzes = [];
  const stop = startRingtone({ vibrate: (pattern) => buzzes.push(pattern) });
  stop();
  assert.deepEqual(buzzes, [[400, 200, 400], 0]);
});

test('a context interrupted in the background is resumed when a call rings', () => {
  resetAudio();
  const { log, AudioContextClass } = fakeAudio({ startsRunning: true });
  unlockAudio(AudioContextClass);
  assert.equal(log.resumes, 0);
  log.instances[0].state = 'interrupted'; // the phone paused it while the app was in the background
  startRingtone({ vibrate() {} })();
  assert.equal(log.resumes, 1);
});
