// Records a call for admins: both voices mixed into one audio file that stays on this phone.
// iPhone screen recordings go silent once a call opens the microphone, so for a demo video,
// screen record the call as usual and line this file up with it afterwards.
// No browser globals are read at import time, so the tests can pass stand-ins.

// Safari records mp4 (saved as .m4a, which the iPhone share sheet accepts). Chrome and Firefox record webm.
const FORMATS = [
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
];

const CHUNK_MS = 1000; // a chunk a second, so a call that ends badly still keeps what was recorded

export function pickFormat(isTypeSupported) {
  return FORMATS.find(({ mimeType }) => isTypeSupported(mimeType)) ?? null;
}

const pad = (number) => String(number).padStart(2, '0');

// For example ping-call-2026-11-11-1530.m4a, in the phone's local time.
export function recordingFileName(date, extension) {
  return `ping-call-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.${extension}`;
}

// `streams` are recorded from the start. Ping's voice arrives a moment later, through add().
// stop() resolves with { blob, fileName }, or null if nothing was recorded.
export function startRecording({
  streams = [],
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  MediaRecorderClass = globalThis.MediaRecorder,
  now = () => new Date(),
}) {
  if (!AudioContextClass || !MediaRecorderClass) throw new Error("This browser can't record calls.");
  const format = pickFormat((type) => MediaRecorderClass.isTypeSupported?.(type) ?? false);
  if (!format) throw new Error("This browser can't record audio in a format the phone can save.");

  const context = new AudioContextClass();
  // An audio context started outside a tap can begin suspended, and then records only silence.
  Promise.resolve(context.resume?.()).catch(() => {});
  const mix = context.createMediaStreamDestination();
  const mixed = new Set();
  const add = (stream) => {
    if (!stream || mixed.has(stream.id)) return;
    mixed.add(stream.id);
    context.createMediaStreamSource(stream).connect(mix);
  };
  streams.forEach(add);

  const recorder = new MediaRecorderClass(mix.stream, { mimeType: format.mimeType });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  const startedAt = now();
  recorder.start(CHUNK_MS);

  let stopped = null;
  return {
    add,
    stop() {
      stopped ??= new Promise((resolve) => {
        const finish = () => {
          Promise.resolve(context.close?.()).catch(() => {});
          const type = recorder.mimeType || format.mimeType;
          resolve(chunks.length ? { blob: new Blob(chunks, { type }), fileName: recordingFileName(startedAt, format.extension) } : null);
        };
        if (recorder.state === 'inactive') return finish();
        recorder.onstop = finish;
        recorder.stop();
      });
      return stopped;
    },
  };
}
