// A call on OpenAI's GPT-Live: full duplex, so it listens while it speaks and decides when to talk itself, and these
// calls have no turn mode. The phone makes a WebRTC offer, Ping's server creates the session with it and returns
// OpenAI's answer, and then audio flows straight between the phone and OpenAI. Events come on the "oai-events" data
// channel. Ping's tools run through GPT-Live's backend model: the phone gets each finished function call, runs it, and
// sends the result back. The callbacks are the same as on the other engines. No browser globals are read at import
// time, so the tests can pass stand-ins. Event names from developers.openai.com/api/docs/guides/live.

import { summarizeTurns } from './turn-metrics.js';
import { turnRecords } from './turn-records.js';

const WRAP_UP_BEFORE_END_SECONDS = 20;
const QUIET_MS = 900; // no new transcript for this long: that side has stopped talking
const GOODBYE_TIMEOUT_MS = 8000; // hang up this long after end_call even if the goodbye never finishes
const ICE_WAIT_MS = 2500;

const withoutPunctuation = (text) => text.replace(/[\s、。！？!?,.・ー〜~]/g, '');

export function startLiveCall({
  callId,
  api,
  audio,
  session, // from POST /api/calls/:id/session: maxSeconds, hangUpLines, timeUpNote
  microphone,
  onStatus,
  onLine,
  onWordAdded,
  onSpeaking,
  onSettings,
  onEnded,
  onNeedsTap,
  onFallback, // GPT-Live couldn't start a randomly assigned call: the server moved it to OpenAI's Realtime API
  onContactAudio = () => {},
  startRecorder = null, // (streams) => recorder, once the contact's audio track arrives
  reportRecording = () => {},
  level = null,
  PeerConnectionClass = globalThis.RTCPeerConnection,
  now = () => performance.now(),
}) {
  const hangUpLines = (session.hangUpLines ?? []).map(withoutPunctuation);
  const maxSeconds = session.maxSeconds;
  const turnLog = [];
  const timers = [];
  let ended = false;
  let connectedAt = null;
  let recorder = null;
  let channel = null;
  let speaker = null; // 'contact' or 'you': whose line is open
  let lineId = null;
  let lineText = '';
  let lines = 0;
  let speaking = false;
  let userSpeaking = false;
  let quietTimer = null;
  let userQuietTimer = null;
  let hangingUp = false;
  const pc = new PeerConnectionClass();

  const send = (event) => {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  };

  function sendTurnMetrics() {
    const endedAt = now();
    Promise.resolve()
      .then(() => api(`/api/calls/${callId}/metrics`, { method: 'POST', body: summarizeTurns(turnLog, { connectedAt, endedAt, engine: 'gpt-live' }) }))
      .then(() => api(`/api/calls/${callId}/turns`, { method: 'POST', body: turnRecords(turnLog, { connectedAt, engine: 'gpt-live' }) }))
      .catch((error) => console.warn('Could not send turn metrics', error));
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    if (recorder) recorder.stop().then((recording) => reportRecording(recording), (error) => reportRecording(null, error.message));
    if (connectedAt !== null) sendTurnMetrics();
    timers.forEach(clearTimeout);
    clearTimeout(quietTimer);
    clearTimeout(userQuietTimer);
    send({ type: 'session.close' });
    try {
      pc.close();
    } catch {
      // already closed
    }
    microphone.getTracks().forEach((track) => track.stop());
    audio.srcObject = null;
    onEnded(reason);
  }

  function hangUp() {
    if (hangingUp) return;
    hangingUp = true;
    timers.push(setTimeout(() => end('finished'), GOODBYE_TIMEOUT_MS));
    if (!speaking) timers.push(setTimeout(() => end('finished'), 1500));
  }

  // The contact's voice: GPT-Live sends no audio start or stop events on WebRTC, so its transcript stands in. A line
  // starts with the first words and ends once they stop coming.
  function contactSaid(delta) {
    const at = now();
    if (speaker !== 'contact') {
      speaker = 'contact';
      lines += 1;
      lineId = `live-contact-${lines}`;
      lineText = '';
    }
    lineText += delta;
    onLine({ id: lineId, from: 'contact', delta });
    if (!speaking) {
      speaking = true;
      turnLog.push({ type: 'output_audio_buffer.started', at });
      onContactAudio({ type: 'start', itemId: lineId, at });
      onSpeaking(true);
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(contactQuiet, QUIET_MS);
    if (hangUpLines.length && hangUpLines.some((line) => withoutPunctuation(lineText).includes(line))) hangUp();
  }

  function contactQuiet() {
    if (!speaking) return;
    speaking = false;
    const at = now();
    turnLog.push({ type: 'output_audio_buffer.stopped', at });
    onContactAudio({ type: 'end', itemId: lineId, at });
    onSpeaking(false);
    if (hangingUp) timers.push(setTimeout(() => end('finished'), 1200));
  }

  function learnerSaid(delta) {
    const at = now();
    if (speaker !== 'you') {
      speaker = 'you';
      lines += 1;
      lineId = `live-you-${lines}`;
    }
    onLine({ id: lineId, from: 'you', delta });
    if (!userSpeaking) {
      userSpeaking = true;
      turnLog.push({ type: 'input_audio_buffer.speech_started', at });
    }
    clearTimeout(userQuietTimer);
    userQuietTimer = setTimeout(() => {
      userSpeaking = false;
      turnLog.push({ type: 'input_audio_buffer.speech_stopped', at: now() - QUIET_MS }, { type: 'input_audio_buffer.committed', at: now() });
    }, QUIET_MS);
  }

  const TOOLS = {
    async update_settings(change) {
      const { settings } = await api('/api/settings', { method: 'PATCH', body: change });
      level = settings.proficiency ?? level;
      onSettings(settings);
      // GPT-Live's voice and instructions are fixed for the session, so the change goes in as a note.
      send({ type: 'session.instructions.append', delegation_id: null, content: `The user changed how you talk. From now on: speech speed about ${settings.speed}x, ${settings.formality} speech, Japanese level ${settings.proficiency}, and ${settings.thinkingTime} time to answer.` });
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

  async function runTool(item) {
    let args = {};
    try {
      args = JSON.parse(item.arguments || '{}');
    } catch {}
    turnLog.push({ type: 'tool', name: item.name, args, level, at: now() });
    let output;
    try {
      output = TOOLS[item.name] ? await TOOLS[item.name](args) : { ok: false, error: 'Unknown tool' };
    } catch (error) {
      console.warn(`${item.name} failed`, error);
      output = { ok: false, error: error.message };
    }
    send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    send({ type: 'response.create' });
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'session.started':
        connectedAt = now();
        onStatus('connected', maxSeconds);
        timers.push(
          setTimeout(() => send({ type: 'session.instructions.append', delegation_id: null, content: session.timeUpNote }), Math.max(0, maxSeconds - WRAP_UP_BEFORE_END_SECONDS) * 1000),
          setTimeout(() => end('time-limit'), maxSeconds * 1000),
        );
        break;
      case 'session.output_transcript.delta':
        if (event.delta) contactSaid(event.delta);
        break;
      case 'session.input_transcript.delta':
        if (event.delta) learnerSaid(event.delta);
        break;
      case 'response.event': {
        const inner = event.event ?? {};
        if (inner.type === 'response.output_item.done' && inner.item?.type === 'function_call') runTool(inner.item);
        break;
      }
      case 'session.closed':
        end(event.reason === 'expired' ? 'time-limit' : event.reason === 'connection_lost' ? 'dropped' : 'finished');
        break;
      case 'error':
        console.warn('GPT-Live error', event.code, event.message);
        if (/quota|credit/i.test(`${event.code} ${event.type}`)) end('unavailable');
        break;
      default:
    }
  }

  async function connect() {
    onStatus('connecting');
    pc.ontrack = (trackEvent) => {
      const [remote] = trackEvent.streams;
      audio.srcObject = remote;
      Promise.resolve(audio.play?.()).catch(() => onNeedsTap());
      if (startRecorder && !recorder) {
        try {
          recorder = startRecorder([microphone, remote]);
        } catch (error) {
          reportRecording(null, error.message);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState) && !ended) end('dropped');
    };
    for (const track of microphone.getTracks()) pc.addTrack(track, microphone);
    channel = pc.createDataChannel('oai-events');
    channel.onmessage = ({ data }) => {
      try {
        handleEvent(JSON.parse(data));
      } catch (error) {
        console.warn('Could not read a GPT-Live event', error);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    // The server forwards the offer in one request, so it needs the network routes gathered first.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timer = setTimeout(resolve, ICE_WAIT_MS);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    if (ended) return;
    let answer;
    try {
      answer = await api(`/api/calls/${callId}/live`, { method: 'POST', body: { sdp: pc.localDescription.sdp } });
    } catch (error) {
      if (error.status === 409) {
        // The server moved the call to OpenAI's Realtime API: close this attempt quietly and let voice.js start again.
        ended = true;
        pc.close();
        return onFallback();
      }
      throw error;
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  connect().catch((error) => {
    console.warn('GPT-Live call failed', error);
    end('failed');
  });

  return {
    hangUp: () => end('hung-up'),
    resumeAudio: () => Promise.resolve(audio.play?.()).catch(() => {}),
    updateVoice: () => {},
  };
}
