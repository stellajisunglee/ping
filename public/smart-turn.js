// Smart Turn on the phone: Silero hears when the user starts and stops talking, and Smart Turn decides
// at each pause whether they've finished. The audio never leaves the phone. The rules for what to do
// live in turn-machine.js; this file runs the models on the call's microphone and reports what happened.

import { logMelFeatures, N_FRAMES, N_MELS, SAMPLE_RATE } from './features.js';
import { initialTurnState, onBlock, onVerdict, shouldFallBack, TURN } from './turn-machine.js';

const RUNTIME_PATH = '/vendor/onnxruntime-web-1.30.0/';
const VAD_MODEL = '/models/silero-vad-2026-10.onnx';
const TURN_MODEL = '/models/smart-turn-v3.2-cpu.onnx';
const MAX_THREADS = 4; // four threads brought a decision from about 345 ms to 100 ms on a laptop in the spike

const BLOCK = 512; // 32 ms at 16 kHz
const VAD_CONTEXT = 64; // Silero also looks at the last 64 samples of the previous block
const PRE_ROLL_BLOCKS = 16; // about half a second of audio from before speech was noticed
const KEEP_SAMPLES = 8 * SAMPLE_RATE; // Smart Turn only hears the last 8 seconds
// With OpenAI's detection off, no audio means no turn ever ends. iOS can pause a page's audio
// processing, for example when the audio output changes, so a gap first gets a restart, and only
// a gap this long from the microphone itself (not the user) sends the call back to silence mode.
const RESTART_AUDIO_AFTER_MS = 600;
const NO_AUDIO_MS = 3000;

let loading = null; // shared by every call on this page, so the models load once

async function fetchBytes(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Loads the runtime and both models, once per page. Resolves with how long that took. */
export function loadSmartTurn() {
  loading ??= (async () => {
    const started = performance.now();
    const ort = await import(`${RUNTIME_PATH}ort.wasm.min.mjs`);
    ort.env.wasm.wasmPaths = new URL(RUNTIME_PATH, location.href).href;
    // Threads only work on a cross-origin isolated page, which Ping's server headers make it.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(MAX_THREADS, navigator.hardwareConcurrency || 1) : 1;
    const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const vad = await ort.InferenceSession.create(await fetchBytes(VAD_MODEL), options);
    const turn = await ort.InferenceSession.create(await fetchBytes(TURN_MODEL), options);
    // One practice run, so the first real decision isn't slower than the rest.
    await turn.run({ input_features: new ort.Tensor('float32', logMelFeatures(new Float32Array(SAMPLE_RATE)), [1, N_MELS, N_FRAMES]) });
    return { ort, vad, turn, loadMs: Math.round(performance.now() - started) };
  })();
  loading.catch(() => {
    loading = null; // let the next call try again
  });
  return loading;
}

// Turns whatever rate the microphone runs at into 16 kHz. Only needed where a browser won't run
// the audio graph at 16 kHz itself; it averages each group of samples, then picks every nth.
function makeResampler(fromRate) {
  const ratio = fromRate / SAMPLE_RATE;
  if (ratio === 1) return (samples) => samples;
  let carry = new Float32Array(0);
  const width = Math.max(1, Math.round(ratio));
  return (samples) => {
    const joined = new Float32Array(carry.length + samples.length);
    joined.set(carry);
    joined.set(samples, carry.length);
    const length = Math.floor((joined.length - 1) / ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const base = Math.floor(i * ratio);
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, base - width + 1); j <= base; j++) (sum += joined[j]), count++;
      out[i] = sum / count;
    }
    carry = joined.slice(Math.floor(length * ratio));
    return out;
  };
}

/**
 * Starts listening to the call's microphone. `onEvent` receives:
 * - { type: 'speech-start', at }
 * - { type: 'end-turn', reason: 'smartTurn' | 'backup', at, quietSince }
 * - { type: 'decision', at, ms }: how long one Smart Turn decision took
 * - { type: 'audio-restart' }: the microphone audio paused, so the audio graph was restarted
 * - { type: 'fallback', reason }: Smart Turn is too slow here, or stopped getting audio, so the call
 *   should go back to silence mode
 * Resolves once audio is actually flowing, or rejects if it doesn't start.
 */
export async function startSmartTurn({ stream, models, onEvent, rules: startRules = {} }) {
  const { ort, vad, turn } = models;
  let stopped = false;
  let rules = { ...TURN, ...startRules }; // the call's own patience, from its settings
  let context;
  let source;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    source = context.createMediaStreamSource(stream);
  } catch {
    // Some browsers can't connect a microphone to an audio graph running at a different rate.
    await context?.close();
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
  }
  await context.resume();
  // If the phone pauses the audio graph, start it again straight away.
  context.onstatechange = () => {
    if (!stopped && context.state !== 'running' && context.state !== 'closed') context.resume().catch(() => {});
  };
  await context.audioWorklet.addModule('/capture-worklet.js');
  const capture = new AudioWorkletNode(context, 'capture');
  const mute = context.createGain();
  mute.gain.value = 0; // a silent output keeps the audio thread running in every browser
  source.connect(capture);
  capture.connect(mute).connect(context.destination);
  const resample = makeResampler(context.sampleRate);

  let state = initialTurnState();
  let vadState = new Float32Array(2 * 128);
  let vadContext = new Float32Array(VAD_CONTEXT);
  let pending = new Float32Array(0);
  let queue = [];
  let busy = false;
  let preRoll = [];
  let turnAudio = new Float32Array(0);
  const decisionMs = [];
  let lastAudioAt = null;
  let restarting = false; // one restart per gap in the audio
  let audioStarted;
  const flowing = new Promise((resolve) => (audioStarted = resolve));
  const watchdog = setInterval(() => {
    if (lastAudioAt === null) return;
    const gap = performance.now() - lastAudioAt;
    if (gap > NO_AUDIO_MS) {
      onEvent({ type: 'fallback', reason: 'no-audio' });
      stop();
    } else if (gap > RESTART_AUDIO_AFTER_MS && !restarting) {
      restarting = true;
      onEvent({ type: 'audio-restart' });
      context.resume().catch(() => {});
    }
  }, 300);

  function keep(block) {
    const joined = new Float32Array(Math.min(KEEP_SAMPLES, turnAudio.length + block.length));
    const fromOld = joined.length - block.length;
    joined.set(turnAudio.subarray(turnAudio.length - fromOld), 0);
    joined.set(block, fromOld);
    turnAudio = joined;
  }

  async function speechProbability(block) {
    const input = new Float32Array(VAD_CONTEXT + BLOCK);
    input.set(vadContext, 0);
    input.set(block, VAD_CONTEXT);
    const output = await vad.run({
      input: new ort.Tensor('float32', input, [1, VAD_CONTEXT + BLOCK]),
      state: new ort.Tensor('float32', vadState, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    });
    vadState = new Float32Array(output.stateN.data);
    vadContext = block.slice(BLOCK - VAD_CONTEXT);
    return output.output.data[0];
  }

  async function decide(pause) {
    const started = performance.now();
    const output = await turn.run({ input_features: new ort.Tensor('float32', logMelFeatures(turnAudio), [1, N_MELS, N_FRAMES]) });
    const at = performance.now();
    const ms = Math.round(at - started);
    decisionMs.push(ms);
    onEvent({ type: 'decision', at, ms });
    if (shouldFallBack({ decisionMs })) {
      onEvent({ type: 'fallback', reason: 'slow' });
      stop();
      return [];
    }
    const result = onVerdict(state, { pause, probability: output.logits.data[0], at }, rules);
    state = result.state;
    return result.actions;
  }

  async function handle(block, at) {
    const wasInTurn = state.inTurn;
    const result = onBlock(state, { speech: await speechProbability(block), at }, rules);
    state = result.state;
    if (!wasInTurn && !state.inTurn) {
      preRoll.push(block);
      if (preRoll.length > PRE_ROLL_BLOCKS) preRoll.shift();
    } else {
      if (!wasInTurn) {
        turnAudio = new Float32Array(0);
        preRoll.forEach(keep);
        preRoll = [];
      }
      keep(block);
    }
    const actions = [...result.actions];
    for (let index = 0; index < actions.length && !stopped; index++) {
      const action = actions[index];
      if (action.type === 'ask') actions.push(...(await decide(action.pause)));
      else onEvent(action);
    }
  }

  // Blocks are handled one at a time, in order, even while a decision is running.
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length && !stopped) {
      const { block, at } = queue.shift();
      try {
        await handle(block, at);
      } catch (error) {
        console.warn('Smart Turn failed on a block', error);
      }
    }
    busy = false;
  }

  capture.port.onmessage = ({ data }) => {
    if (stopped) return;
    const at = performance.now();
    lastAudioAt = at;
    restarting = false;
    audioStarted();
    const samples = resample(data);
    const joined = new Float32Array(pending.length + samples.length);
    joined.set(pending);
    joined.set(samples, pending.length);
    let offset = 0;
    while (joined.length - offset >= BLOCK) {
      queue.push({ block: joined.slice(offset, offset + BLOCK), at });
      offset += BLOCK;
    }
    pending = joined.slice(offset);
    pump();
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    queue = [];
    capture.port.onmessage = null;
    source.disconnect();
    context.close().catch(() => {});
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('no audio from the microphone')), NO_AUDIO_MS);
  });
  try {
    await Promise.race([flowing, timeout]);
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    stop,
    get inTurn() {
      return state.inTurn;
    },
    get rules() {
      return rules;
    },
    // A settings change or a step of adaptive patience. It applies from the next block of audio.
    setRules(change) {
      rules = { ...rules, ...change };
    },
  };
}
