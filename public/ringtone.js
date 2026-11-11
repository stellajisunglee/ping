// The ringtone for an incoming call while the app is open.
// iPhones only play web audio that a tap started, and a call arrives without one. So the app sets up
// one audio context on the first tap anywhere, keeps it, and rings through it later.
// Web audio follows the phone's silent switch, like a real ringtone. Vibration only works on Android.
// No browser globals are read at import time, so the tests can pass stand-ins.

const VIBRATION = [400, 200, 400];
const RING_EVERY_MS = 3000;
const VOLUME = 0.3;
// A classic phone trill: two close tones, warbling 20 times a second, in two bursts.
const TONES = [440, 480];
const WARBLE_HZ = 20;
const BURSTS = [
  [0, 0.4],
  [0.6, 0.4],
];
const FADE_SECONDS = 0.005; // so the tones switch on and off without clicks

let context = null;

const audioContextClass = () => globalThis.AudioContext ?? globalThis.webkitAudioContext;

// Called on every tap until the context is running. Playing a moment of silence is what fully
// unlocks audio on older iPhones.
export function unlockAudio(AudioContextClass = audioContextClass()) {
  if (!AudioContextClass) return;
  context ??= new AudioContextClass();
  if (context.state === 'running') return;
  Promise.resolve(context.resume?.()).catch(() => {});
  const buffer = context.createBuffer(1, 1, 22050);
  const silence = context.createBufferSource();
  silence.buffer = buffer;
  silence.connect(context.destination);
  silence.start(0);
}

export const audioUnlocked = () => context?.state === 'running';

// For tests: forget the context, as a fresh page load would.
export function resetAudio() {
  context = null;
}

function ringOnce() {
  const start = context.currentTime + 0.05;
  const half = 1 / WARBLE_HZ / 2;
  for (const [offset, length] of BURSTS) {
    const from = start + offset;
    const to = from + length;
    // The warble: the tones switch on and off 20 times a second, each time with a short fade.
    const volume = context.createGain();
    volume.gain.setValueAtTime(0, from);
    for (let on = from; on < to - half / 2; on += 2 * half) {
      volume.gain.setValueAtTime(0, on);
      volume.gain.linearRampToValueAtTime(VOLUME, on + FADE_SECONDS);
      volume.gain.setValueAtTime(VOLUME, on + half - FADE_SECONDS);
      volume.gain.linearRampToValueAtTime(0, on + half);
    }
    volume.connect(context.destination);
    for (const frequency of TONES) {
      const tone = context.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(volume);
      tone.start(from);
      tone.stop(to);
    }
  }
}

// Rings until the returned function is called.
export function startRingtone({ vibrate = (pattern) => globalThis.navigator?.vibrate?.(pattern) } = {}) {
  // A context that was interrupted while the app was in the background can usually be resumed.
  if (context && context.state !== 'running') Promise.resolve(context.resume?.()).catch(() => {});
  const ring = () => {
    vibrate(VIBRATION);
    if (context) ringOnce();
  };
  ring();
  const interval = setInterval(ring, RING_EVERY_MS);
  return () => {
    clearInterval(interval);
    vibrate(0);
  };
}
