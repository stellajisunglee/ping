// A call on Cartesia's Managed Agents. Ping's server makes the call's session (with this call's instructions, first
// message and speed) and hands the phone a WebSocket address with a one-use token. The phone says which audio it
// sends, streams its microphone as 24 kHz PCM, and plays back the agent's 24 kHz PCM (Cartesia sends back the format
// it's sent). Cartesia hears (Ink-2), thinks, speaks (Sonic) and decides turns itself, so these calls have no turn
// mode. Callbacks are the same as on the other engines; no browser globals are read at import time, so the tests can
// pass stand-ins. Message names from docs.cartesia.ai (agent WebSocket), checked against a live call on 2026-11-27.

import { createMicrophoneStream, createPlayer } from './deepgram-call.js';
import { fromBase64, toBase64 } from './elevenlabs-call.js';
import { summarizeTurns } from './turn-metrics.js';
import { turnRecords } from './turn-records.js';

const SAMPLE_RATE = 24000;
const GOODBYE_TIMEOUT_MS = 8000;
// After hang_up, the agent often says its goodbye as a new turn, about half a second later, so the phone waits a
// little for it before hanging up on silence.
const GOODBYE_START_MS = 2500;

const withoutPunctuation = (text) => text.replace(/[\s、。！？!?,.・ー〜~「」]/g, '');

export function startCartesiaCall({
  callId,
  api,
  audio,
  session, // from POST /api/calls/:id/session: socketUrl, maxSeconds, hangUpLines
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
  makePlayer = (options) => createPlayer({ AudioContextClass: globalThis.AudioContext ?? globalThis.webkitAudioContext, sampleRate: SAMPLE_RATE, ...options }),
  makeMicrophoneStream = (options) =>
    createMicrophoneStream({ AudioContextClass: globalThis.AudioContext ?? globalThis.webkitAudioContext, AudioWorkletNodeClass: globalThis.AudioWorkletNode, sampleRate: SAMPLE_RATE, ...options }),
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
  let currentLine = null; // the contact's line being said, by Cartesia's turn number
  let speakingTurn = null; // the contact's turn that has started and not yet ended
  // After hang_up, the goodbye is the turn being said then, or the next one if none was. The agent sometimes adds
  // another turn after it, like 「(電話を切りました)」, which the learner shouldn't hear, so later turns are dropped.
  let goodbyeTurn = null;
  let afterGoodbye = false;
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
  const socket = new WebSocketClass(session.socketUrl);
  const send = (message) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  function sendTurnMetrics() {
    const endedAt = now();
    Promise.resolve()
      .then(() => api(`/api/calls/${callId}/metrics`, { method: 'POST', body: summarizeTurns(turnLog, { connectedAt, endedAt, engine: 'cartesia' }) }))
      .then(() => api(`/api/calls/${callId}/turns`, { method: 'POST', body: turnRecords(turnLog, { connectedAt, engine: 'cartesia' }) }))
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

  // Hangs up once the goodbye has played, or after a while if it never comes. turn is the goodbye, when known.
  function hangUp(turn = speakingTurn) {
    if (hangingUp) return;
    hangingUp = true;
    goodbyeTurn = turn ?? 'next';
    timers.push(setTimeout(() => end('finished'), GOODBYE_TIMEOUT_MS));
    if (!speaking) timers.push(setTimeout(() => (speaking ? null : end('finished')), GOODBYE_START_MS));
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
      // The voice's speed is fixed for the call, so the agent is told how to talk from now on instead.
      return { ok: true, settings, note: `From now on: speak more ${change.speedChange?.includes('slower') ? 'slowly' : change.speedChange?.includes('faster') ? 'quickly' : 'naturally'}, ${settings.formality} speech, Japanese level ${settings.proficiency}.` };
    },
    async add_to_stack(word) {
      const { added, alreadySaved, word: saved } = await api('/api/stack/words', { method: 'POST', body: word });
      if (added || alreadySaved) onWordAdded(saved, { alreadySaved: Boolean(alreadySaved) });
      return { ok: true, added, alreadySaved: Boolean(alreadySaved) };
    },
    async back_to_conversation() {
      return { ok: true };
    },
    // Ping's end_call, under the name Cartesia allows (HANG_UP_TOOL in server/cartesia.js).
    async hang_up() {
      hangUp();
      return { ok: true, note: 'The call is over. Say nothing more.' };
    },
  };

  async function runTool({ tool_name: name, tool_call_id: id, parameters = {}, expects_response: expectsResponse }) {
    // Logged under Ping's own tool names, so help events count the same as on the other engines.
    turnLog.push({ type: 'tool', name: name === 'hang_up' ? 'end_call' : name, args: parameters, level, at: now() });
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

  // A turn the agent started after its goodbye, which isn't played or shown.
  const pastGoodbye = (turn) => hangingUp && typeof goodbyeTurn === 'number' && turn > goodbyeTurn;

  function dropRestAfterGoodbye() {
    afterGoodbye = true;
    if (!speaking) timers.push(setTimeout(() => end('finished'), 200));
  }

  // The contact's line for this turn, made when its first words arrive (a turn that only runs a tool has none).
  function lineFor(turn, at) {
    const id = `cartesia-contact-${turn}`;
    if (currentLine !== id) {
      currentLine = id;
      if (speaking) onContactAudio({ type: 'start', itemId: id, at });
    }
    return id;
  }

  function handleMessage(message) {
    const at = now();
    switch (message.type) {
      case 'session_ready':
        connectedAt = at;
        onStatus('connected', maxSeconds);
        makeMicrophoneStream({ stream: microphone, onAudio: (chunk) => send({ type: 'audio_input', audio: toBase64(chunk) }) }).then(
          (stream) => (ended ? stream.close() : (micStream = stream)),
          (error) => {
            console.warn('Could not stream the microphone', error);
            end('failed');
          },
        );
        // Cartesia has no way to tell the agent to wrap up, so the call simply ends at the plan's limit.
        timers.push(setTimeout(() => end('time-limit'), maxSeconds * 1000));
        break;
      case 'audio_output':
        if (!message.audio || afterGoodbye) break;
        player.play(fromBase64(message.audio));
        startSpeaking();
        stopWhenPlayed();
        break;
      case 'audio_output_clear':
        // The learner started talking: stop the agent's voice now and drop what was queued.
        player.stop();
        stopSpeaking('cut');
        break;
      case 'turn_started':
        if (message.role === 'user' && !userSpeaking) {
          userSpeaking = true;
          turnLog.push({ type: 'input_audio_buffer.speech_started', at });
        }
        if (message.role === 'assistant') {
          if (hangingUp && goodbyeTurn === 'next') goodbyeTurn = message.turn;
          if (pastGoodbye(message.turn)) dropRestAfterGoodbye();
          else speakingTurn = message.turn;
        }
        break;
      case 'turn_output_text_delta':
        if (message.role === 'assistant' && message.text && !pastGoodbye(message.turn)) onLine({ id: lineFor(message.turn, at), from: 'contact', delta: message.text });
        break;
      case 'turn_ended': {
        const text = message.text ?? '';
        if (message.role === 'user') {
          // Cartesia decided the learner's turn is over.
          if (userSpeaking) userSpeaking = false;
          else turnLog.push({ type: 'input_audio_buffer.speech_started', at });
          turnLog.push({ type: 'input_audio_buffer.speech_stopped', at }, { type: 'input_audio_buffer.committed', at });
          if (text.trim()) onLine({ id: `cartesia-you-${message.turn}`, from: 'you', text });
          break;
        }
        if (pastGoodbye(message.turn)) break;
        if (text && !message.interrupted) onLine({ id: lineFor(message.turn, at), from: 'contact', text });
        if (hangUpLines.length && hangUpLines.some((line) => withoutPunctuation(text).includes(line))) hangUp(message.turn);
        if (message.turn === speakingTurn) speakingTurn = null;
        break;
      }
      case 'client_tool_call':
        runTool(message);
        break;
      case 'error':
        console.warn('Cartesia error', message.code, message.message);
        break;
      default:
    }
  }

  socket.onopen = () => {
    onStatus('connecting');
    send({ type: 'session_create', audio: { input_format: `pcm_${SAMPLE_RATE}` } });
  };
  socket.onmessage = ({ data }) => {
    try {
      handleMessage(JSON.parse(data));
    } catch (error) {
      console.warn('Could not read a Cartesia message', error);
    }
  };
  // Cartesia closes with 1000 when the call ended on its side on purpose. What's still queued is played first.
  socket.onclose = (event = {}) => {
    const reason = connectedAt === null ? 'failed' : hangingUp || event.code === 1000 ? 'finished' : 'dropped';
    const left = connectedAt === null ? 0 : player.remaining();
    if (left > 0.05) timers.push(setTimeout(() => end(reason), left * 1000 + 200));
    else end(reason);
  };
  socket.onerror = () => {
    if (connectedAt === null) end('failed');
  };

  return {
    hangUp: () => end('hung-up'),
    resumeAudio: () => player.resume().then(() => audio.play?.()),
    updateVoice: () => {},
  };
}
