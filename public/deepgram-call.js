// A call on Deepgram's Voice Agent. The phone streams its microphone to Deepgram over a WebSocket and
// plays back the audio Deepgram sends. Deepgram hears (Flux), thinks (an OpenAI model) and speaks (a Flux
// voice), and decides when the learner's turn is over itself, so these calls have no turn mode.
// Everything the app sees (lines, the contact's voice starting and stopping, tools, timing numbers) works
// the same as on OpenAI. No browser globals are read at import time, so the tests can pass stand-ins.

import { summarizeTurns } from './turn-metrics.js';

const INPUT_RATE = 16000; // what the phone sends: 16-bit samples, one channel
const OUTPUT_RATE = 24000; // what Deepgram sends back
const HANG_UP_AFTER_GOODBYE_MS = 600;
const GOODBYE_TIMEOUT_MS = 10_000;
const WRAP_UP_BEFORE_END_SECONDS = 20;

const withoutPunctuation = (text) => text.replace(/[\s、。！？!?.,…・「」]/g, '');

// Deepgram's total_latency for one reply, in seconds, as whole milliseconds, or null if it didn't send one.
const latencyMs = (seconds) => (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null);

export function toPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

// Plays Deepgram's audio in order, through an <audio> element so the speaker button and recording work.
export function createPlayer({ AudioContextClass, audio }) {
  const context = new AudioContextClass();
  const output = context.createMediaStreamDestination();
  audio.srcObject = output.stream;
  const sources = new Set();
  let endsAt = 0; // when the queued audio finishes, in the audio clock
  let leftover = null; // a byte left over from an odd-sized chunk
  return {
    stream: output.stream,
    resume: () => Promise.resolve(context.resume?.()).catch(() => {}),
    play(data) {
      let bytes = new Uint8Array(data);
      if (leftover) {
        bytes = Uint8Array.of(leftover, ...bytes);
        leftover = null;
      }
      if (bytes.length % 2) {
        leftover = bytes.at(-1);
        bytes = bytes.subarray(0, -1);
      }
      if (!bytes.length) return;
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
      const buffer = context.createBuffer(1, pcm.length, OUTPUT_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      const startAt = Math.max(context.currentTime, endsAt);
      source.start(startAt);
      endsAt = startAt + buffer.duration;
      sources.add(source);
      source.onended = () => sources.delete(source);
    },
    // Seconds of audio still to play.
    remaining: () => Math.max(0, endsAt - context.currentTime),
    stop() {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already finished
        }
      }
      sources.clear();
      endsAt = 0;
      leftover = null;
    },
    close: () => Promise.resolve(context.close?.()).catch(() => {}),
  };
}

// Sends the microphone to Deepgram as 16 kHz, 16-bit audio, using the same worklet Smart Turn uses.
export async function createMicrophoneStream({ AudioContextClass, AudioWorkletNodeClass, stream, onAudio }) {
  const context = new AudioContextClass({ sampleRate: INPUT_RATE });
  await Promise.resolve(context.resume?.()).catch(() => {});
  await context.audioWorklet.addModule('/capture-worklet.js');
  const source = context.createMediaStreamSource(stream);
  const capture = new AudioWorkletNodeClass(context, 'capture');
  const mute = context.createGain();
  mute.gain.value = 0; // a silent output keeps the audio thread running in every browser
  source.connect(capture);
  capture.connect(mute).connect(context.destination);
  capture.port.onmessage = (event) => onAudio(toPcm16(event.data).buffer);
  return { close: () => Promise.resolve(context.close?.()).catch(() => {}) };
}

export function startDeepgramCall({
  callId,
  api,
  audio,
  session, // from POST /api/calls/:id/session: token, agentUrl, settings, maxSeconds, hangUpLines, timeUpLine
  microphone,
  onStatus,
  onLine,
  onWordAdded,
  onSpeaking,
  onSettings,
  onEnded,
  onNeedsTap,
  onContactAudio = () => {},
  recorder = null, // already recording the microphone, when the call is recorded
  reportRecording = () => {},
  WebSocketClass = globalThis.WebSocket,
  makePlayer = (options) => createPlayer({ AudioContextClass: globalThis.AudioContext ?? globalThis.webkitAudioContext, ...options }),
  makeMicrophoneStream = (options) =>
    createMicrophoneStream({ AudioContextClass: globalThis.AudioContext ?? globalThis.webkitAudioContext, AudioWorkletNodeClass: globalThis.AudioWorkletNode, ...options }),
  now = () => performance.now(),
}) {
  const hangUpLines = (session.hangUpLines ?? []).map(withoutPunctuation);
  const maxSeconds = session.maxSeconds;
  const turnLog = [];
  const timers = [];
  let ended = false;
  let connectedAt = null;
  let micStream = null;
  let hangingUp = false;
  let agentDone = false; // Deepgram has sent all the audio for the current reply
  let speaking = false; // the contact's audio is playing
  let lineCount = 0;
  let currentLine = null; // the contact's line whose voice is playing, or about to
  let lineStarted = false;
  let lineEnded = false;
  let stopTimer = null;
  let skipAudio = false; // after the learner cuts in, until the next reply: Deepgram may still send the cut reply's tail

  const player = makePlayer({ audio });
  recorder?.add(player.stream);
  const socket = new WebSocketClass(session.agentUrl, ['bearer', session.token]);
  socket.binaryType = 'arraybuffer';
  // Audio goes as raw binary frames; everything else is a JSON message.
  const send = (message) => {
    if (socket.readyState !== 1) return;
    const binary = message instanceof ArrayBuffer || ArrayBuffer.isView(message);
    socket.send(binary || typeof message === 'string' ? message : JSON.stringify(message));
  };

  function sendTurnMetrics() {
    const endedAt = now();
    Promise.resolve()
      .then(() => api(`/api/calls/${callId}/metrics`, { method: 'POST', body: summarizeTurns(turnLog, { connectedAt, endedAt, engine: 'deepgram-agent' }) }))
      .catch((error) => console.warn('Could not send turn metrics', error));
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    if (recorder) recorder.stop().then((recording) => reportRecording(recording), (error) => reportRecording(null, error.message));
    sendTurnMetrics();
    timers.forEach(clearTimeout);
    clearTimeout(stopTimer);
    micStream?.close();
    microphone.getTracks().forEach((track) => track.stop());
    player.stop();
    player.close();
    try {
      socket.close();
    } catch {
      // already closed
    }
    audio.srcObject = null;
    onEnded(reason);
  }

  function startSpeaking() {
    if (speaking) return;
    speaking = true;
    const at = now();
    turnLog.push({ type: 'output_audio_buffer.started', at });
    onSpeaking(true);
    if (currentLine && !lineStarted) {
      lineStarted = true;
      onContactAudio({ type: 'start', itemId: currentLine, at });
    }
  }

  function stopSpeaking(type) {
    if (!speaking) return;
    speaking = false;
    const at = now();
    turnLog.push({ type: type === 'cut' ? 'output_audio_buffer.cleared' : 'output_audio_buffer.stopped', at });
    if (currentLine && lineStarted && !lineEnded) {
      lineEnded = true;
      onContactAudio({ type: type === 'cut' ? 'cut' : 'end', itemId: currentLine, at });
    }
    onSpeaking(false);
    if (hangingUp) timers.push(setTimeout(() => end('finished'), HANG_UP_AFTER_GOODBYE_MS));
  }

  // Once Deepgram has sent the whole reply, the voice stops when the queued audio has played.
  function stopWhenPlayed() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (agentDone && player.remaining() <= 0.05) stopSpeaking('end');
      else if (agentDone) stopWhenPlayed();
    }, Math.max(50, player.remaining() * 1000));
  }

  // Deepgram can send a reply's audio a moment before its words, so a new line can arrive while its
  // voice is already playing. A second line in the same reply starts where the first one ends.
  function newContactLine(text) {
    if (currentLine && lineStarted && !lineEnded && speaking) onContactAudio({ type: 'end', itemId: currentLine, at: now() });
    lineCount += 1;
    currentLine = `deepgram-contact-${lineCount}`;
    lineStarted = false;
    lineEnded = false;
    onLine({ id: currentLine, from: 'contact', delta: text });
    if (speaking) {
      lineStarted = true;
      onContactAudio({ type: 'start', itemId: currentLine, at: now() });
    }
    if (hangUpLines.length && hangUpLines.some((line) => withoutPunctuation(text).includes(line))) hangUp();
  }

  // The contact said goodbye: hang up once it's been heard.
  function hangUp() {
    if (hangingUp) return;
    hangingUp = true;
    timers.push(setTimeout(() => end('finished'), GOODBYE_TIMEOUT_MS));
    if (!speaking && agentDone) timers.push(setTimeout(() => end('finished'), HANG_UP_AFTER_GOODBYE_MS));
  }

  const TOOLS = {
    async update_settings(change) {
      const { settings, agent } = await api('/api/settings', { method: 'PATCH', body: change });
      if (agent) {
        send({ type: 'UpdateSpeak', speak: agent.speak });
        send({ type: 'UpdateListen', listen: agent.listen });
      }
      onSettings(settings);
      return { ok: true, settings };
    },
    async add_to_stack(word) {
      const { added, alreadySaved, word: saved } = await api('/api/stack/words', { method: 'POST', body: word });
      if (added || alreadySaved) onWordAdded(saved, { alreadySaved: Boolean(alreadySaved) });
      return { ok: true, added, alreadySaved: Boolean(alreadySaved) };
    },
    async back_to_conversation() {
      return { ok: true };
    },
    async end_call() {
      hangUp();
      return { ok: true };
    },
  };

  async function runTools(functions) {
    for (const call of functions.filter((fn) => fn.client_side !== false)) {
      let output;
      try {
        output = await TOOLS[call.name](JSON.parse(call.arguments || '{}'));
      } catch (error) {
        console.warn(`${call.name} failed`, error);
        output = { ok: false, error: error.message };
      }
      send({ type: 'FunctionCallResponse', id: call.id, name: call.name, content: JSON.stringify(output) });
    }
  }

  function handleMessage(message) {
    if (typeof message !== 'string') {
      if (ended || skipAudio) return;
      agentDone = false;
      player.play(message);
      startSpeaking();
      return;
    }
    const event = JSON.parse(message);
    const at = now();
    switch (event.type) {
      case 'Welcome':
        send(session.settings);
        break;
      case 'SettingsApplied':
        connectedAt = at;
        onStatus('connected', maxSeconds);
        makeMicrophoneStream({ stream: microphone, onAudio: (chunk) => send(chunk) }).then(
          (stream) => (ended ? stream.close() : (micStream = stream)),
          (error) => {
            console.warn('Could not stream the microphone', error);
            end('failed');
          },
        );
        // Deepgram can't take a mid-call instruction, so near the limit the phone has the contact say goodbye.
        timers.push(
          setTimeout(() => {
            send({ type: 'InjectAgentMessage', message: session.timeUpLine });
            hangUp();
          }, Math.max(0, maxSeconds - WRAP_UP_BEFORE_END_SECONDS) * 1000),
          setTimeout(() => end('time-limit'), maxSeconds * 1000),
        );
        break;
      case 'ConversationText':
        if (event.role === 'assistant') {
          skipAudio = false;
          newContactLine(event.content ?? '');
        }
        else onLine({ id: `deepgram-you-${at}`, from: 'you', text: event.content ?? '' });
        break;
      case 'UserStartedSpeaking':
        turnLog.push({ type: 'input_audio_buffer.speech_started', at });
        // The learner talked over the contact: stop its voice straight away.
        if (speaking) {
          player.stop();
          agentDone = true;
          skipAudio = true;
          stopSpeaking('cut');
        }
        break;
      case 'EndOfTurn':
        // Flux decided the learner's turn is over. It doesn't say when they actually went quiet.
        turnLog.push({ type: 'input_audio_buffer.speech_stopped', at }, { type: 'input_audio_buffer.committed', at });
        break;
      // Deepgram's own latency for a reply. Its docs put it in LatencyReport; it has also come with AgentStartedSpeaking.
      case 'AgentStartedSpeaking':
      case 'LatencyReport':
        turnLog.push({ type: 'provider-latency', at, source: event.type, totalMs: latencyMs(event.total_latency) });
        break;
      case 'AgentAudioDone':
        agentDone = true;
        stopWhenPlayed();
        break;
      case 'FunctionCallRequest':
        runTools(event.functions ?? []);
        break;
      case 'Warning':
        console.warn('Deepgram warning', event.code, event.description);
        break;
      case 'Error':
        console.warn('Deepgram error', event.code, event.description);
        end('failed');
        break;
      default:
    }
  }

  socket.onmessage = (message) => handleMessage(message.data);
  socket.onclose = () => end(hangingUp ? 'finished' : 'dropped');
  socket.onerror = () => end('failed');

  // iPhones only play audio a tap started, so the call screen may need a "tap to hear".
  const playAudio = () => {
    player.resume();
    Promise.resolve(audio.play?.()).catch(() => onNeedsTap());
  };
  playAudio();

  return {
    hangUp: () => end('hung-up'),
    setMuted: (muted) => microphone.getAudioTracks().forEach((track) => (track.enabled = !muted)),
    resumeAudio: playAudio,
    // Settings changed on the call screen (the speed slider), not by the contact: tell Deepgram too.
    updateVoice: ({ agent }) => {
      if (!agent) return;
      send({ type: 'UpdateSpeak', speak: agent.speak });
      send({ type: 'UpdateListen', listen: agent.listen });
    },
  };
}
