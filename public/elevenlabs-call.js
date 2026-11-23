// A call on ElevenLabs Agents. The phone opens the signed WebSocket Ping's server got for this call, sends the
// overrides that make the agent Ping for this call (prompt, first message, Japanese, speed), streams its microphone
// as 16 kHz PCM, and plays back the agent's 24 kHz PCM. ElevenLabs hears, thinks, speaks and decides turns itself, so
// these calls have no turn mode. Callbacks are the same as on the other engines; no browser globals are read at
// import time, so the tests can pass stand-ins. Message names from elevenlabs.io/docs (Agents WebSocket).

import { createMicrophoneStream, createPlayer } from './deepgram-call.js';
import { summarizeTurns } from './turn-metrics.js';
import { turnRecords } from './turn-records.js';

const WRAP_UP_BEFORE_END_SECONDS = 20;
const GOODBYE_TIMEOUT_MS = 8000;
const SPEECH_VAD = 0.5; // ElevenLabs' voice-activity score above which the learner is talking

const withoutPunctuation = (text) => text.replace(/[\s、。！？!?,.・ー〜~]/g, '');

export const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0)).buffer;

export function startElevenLabsCall({
  callId,
  api,
  audio,
  session, // from POST /api/calls/:id/session: signedUrl, overrides, maxSeconds, hangUpLines, timeUpNote
  microphone,
  onStatus,
  onLine,
  onWordAdded,
  onSpeaking,
  onSettings,
  onEnded,
  onNeedsTap,
  onContactAudio = () => {},
  startRecorder = null, // (streams) => recorder: both voices, once the player exists
  reportRecording = () => {},
  level = null,
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
  let speaking = false;
  let userSpeaking = false;
  let hangingUp = false;
  let lines = 0;
  let currentLine = null;
  let cutAfter = -1; // audio with an event id up to this was interrupted, so it's skipped
  let stopTimer = null;
  const player = makePlayer({ audio });
  let recorder = null;
  if (startRecorder) {
    try {
      recorder = startRecorder([microphone, player.stream]);
    } catch (error) {
      reportRecording(null, error.message);
    }
  }
  player.resume().then(
    () => Promise.resolve(audio.play?.()).catch(() => onNeedsTap()),
    () => onNeedsTap(),
  );
  const socket = new WebSocketClass(session.signedUrl);
  const send = (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  function sendTurnMetrics() {
    const endedAt = now();
    Promise.resolve()
      .then(() => api(`/api/calls/${callId}/metrics`, { method: 'POST', body: summarizeTurns(turnLog, { connectedAt, endedAt, engine: 'elevenlabs' }) }))
      .then(() => api(`/api/calls/${callId}/turns`, { method: 'POST', body: turnRecords(turnLog, { connectedAt, engine: 'elevenlabs' }) }))
      .catch((error) => console.warn('Could not send turn metrics', error));
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    if (recorder) recorder.stop().then((recording) => reportRecording(recording), (error) => reportRecording(null, error.message));
    if (connectedAt !== null) sendTurnMetrics();
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

  function hangUp() {
    if (hangingUp) return;
    hangingUp = true;
    timers.push(setTimeout(() => end('finished'), GOODBYE_TIMEOUT_MS));
  }

  function startSpeaking() {
    if (speaking) return;
    speaking = true;
    const at = now();
    turnLog.push({ type: 'output_audio_buffer.started', at });
    if (currentLine) onContactAudio({ type: 'start', itemId: currentLine, at });
    onSpeaking(true);
  }

  function stopSpeaking(type) {
    if (!speaking) return;
    speaking = false;
    const at = now();
    turnLog.push({ type: type === 'cut' ? 'output_audio_buffer.cleared' : 'output_audio_buffer.stopped', at });
    if (currentLine) onContactAudio({ type: type === 'cut' ? 'cut' : 'end', itemId: currentLine, at });
    onSpeaking(false);
    if (hangingUp) timers.push(setTimeout(() => end('finished'), 1200));
  }

  // The voice has stopped once the queued audio has played and no more is coming.
  function stopWhenPlayed() {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => (player.remaining() <= 0.05 ? stopSpeaking('end') : stopWhenPlayed()), Math.max(120, player.remaining() * 1000 + 120));
  }

  const TOOLS = {
    async update_settings(change) {
      const { settings } = await api('/api/settings', { method: 'PATCH', body: change });
      level = settings.proficiency ?? level;
      onSettings(settings);
      // The voice is fixed for the call, so the change goes in as context for the agent.
      send({ type: 'contextual_update', text: `The user changed how you talk. From now on: speak at about ${settings.speed}x speed, ${settings.formality} speech, Japanese level ${settings.proficiency}.` });
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

  async function runTool({ tool_name: name, tool_call_id: id, parameters = {}, expects_response: expectsResponse }) {
    turnLog.push({ type: 'tool', name, args: parameters, level, at: now() });
    let output;
    let isError = false;
    try {
      output = TOOLS[name] ? await TOOLS[name](parameters) : { ok: false, error: 'Unknown tool' };
      isError = !output.ok;
    } catch (error) {
      console.warn(`${name} failed`, error);
      output = { ok: false, error: error.message };
      isError = true;
    }
    if (expectsResponse !== false) send({ type: 'client_tool_result', tool_call_id: id, result: JSON.stringify(output), is_error: isError });
  }

  function handleMessage(message) {
    const at = now();
    switch (message.type) {
      case 'conversation_initiation_metadata':
        connectedAt = at;
        onStatus('connected', maxSeconds);
        makeMicrophoneStream({ stream: microphone, onAudio: (chunk) => send({ user_audio_chunk: toBase64(chunk) }) }).then(
          (stream) => (ended ? stream.close() : (micStream = stream)),
          (error) => {
            console.warn('Could not stream the microphone', error);
            end('failed');
          },
        );
        timers.push(
          setTimeout(() => {
            send({ type: 'contextual_update', text: session.timeUpNote });
            hangUp();
          }, Math.max(0, maxSeconds - WRAP_UP_BEFORE_END_SECONDS) * 1000),
          setTimeout(() => end('time-limit'), maxSeconds * 1000),
        );
        break;
      case 'audio': {
        const { audio_base_64: data, event_id: id } = message.audio_event ?? {};
        if (!data || (id !== undefined && id <= cutAfter)) break;
        player.play(fromBase64(data));
        startSpeaking();
        stopWhenPlayed();
        break;
      }
      case 'agent_response': {
        const text = message.agent_response_event?.agent_response ?? '';
        lines += 1;
        currentLine = `elevenlabs-contact-${lines}`;
        onLine({ id: currentLine, from: 'contact', text });
        if (speaking) onContactAudio({ type: 'start', itemId: currentLine, at });
        if (hangUpLines.length && hangUpLines.some((line) => withoutPunctuation(text).includes(line))) hangUp();
        break;
      }
      case 'user_transcript': {
        // ElevenLabs decided the learner's turn is over.
        if (userSpeaking) userSpeaking = false;
        else turnLog.push({ type: 'input_audio_buffer.speech_started', at });
        turnLog.push({ type: 'input_audio_buffer.speech_stopped', at }, { type: 'input_audio_buffer.committed', at });
        lines += 1;
        onLine({ id: `elevenlabs-you-${lines}`, from: 'you', text: message.user_transcription_event?.user_transcript ?? '' });
        break;
      }
      case 'vad_score': {
        const score = message.vad_score_event?.vad_score ?? 0;
        if (score >= SPEECH_VAD && !userSpeaking) {
          userSpeaking = true;
          turnLog.push({ type: 'input_audio_buffer.speech_started', at });
        }
        break;
      }
      case 'interruption':
        // The learner talked over the agent: stop its voice now, and skip what was already sent for that reply.
        cutAfter = message.interruption_event?.event_id ?? cutAfter;
        player.stop();
        stopSpeaking('cut');
        break;
      case 'client_tool_call':
        runTool(message.client_tool_call ?? {});
        break;
      case 'ping':
        send({ type: 'pong', event_id: message.ping_event?.event_id });
        break;
      case 'client_error':
        console.warn('ElevenLabs error', message.error_event);
        break;
      default:
    }
  }

  socket.onopen = () => {
    onStatus('connecting');
    send({ type: 'conversation_initiation_client_data', conversation_config_override: session.overrides });
  };
  socket.onmessage = ({ data }) => {
    try {
      handleMessage(JSON.parse(data));
    } catch (error) {
      console.warn('Could not read an ElevenLabs message', error);
    }
  };
  socket.onclose = () => end(connectedAt === null ? 'failed' : hangingUp ? 'finished' : 'dropped');
  socket.onerror = () => {
    if (connectedAt === null) end('failed');
  };

  return {
    hangUp: () => end('hung-up'),
    resumeAudio: () => player.resume().then(() => audio.play?.()),
    updateVoice: () => {},
  };
}
