// One phone call with a contact: a WebRTC connection straight from this browser to the voice model.

import { classifyTurn, RESUME_NOTE } from './aizuchi.js';
import { summarizeTurns, TIMED_EVENTS } from './turn-metrics.js';

const DATA_CHANNEL = 'oai-events';
const WRAP_UP_BEFORE_END_SECONDS = 20;
const HANG_UP_AFTER_GOODBYE_MS = 600;
const GOODBYE_TIMEOUT_MS = 10_000;
// A turn that talked over the contact waits this long for its words. Transcripts usually take 0.3 to 0.5 seconds.
const TRANSCRIPT_WAIT_MS = 1500;
const WRAP_UP_NOTE = 'Time is nearly up. Say a short warm goodbye in Japanese, then call end_call.';

export function startCall({ callId, api, audio, onStatus, onLine, onWordAdded, onSpeaking, onSettings, onEnded, onNeedsTap }) {
  let pc = null;
  let channel = null;
  let microphone = null;
  let ended = false;
  let greeted = false;
  let channelOpen = false;
  let audioPlaying = false;
  let hangingUp = false;
  let speaking = false;
  let audioFinished = false;
  let responding = false;
  let pendingVoiceUpdate = null;
  let maxCallSeconds = 0;
  let connectedAt = null;
  let queuedReply = null; // a reply asked for while another was still being written
  let waitingTurn = null; // a turn that talked over the contact, waiting for its words
  const talkedOver = new Set(); // turns that started while the contact was speaking
  const transcripts = new Map(); // the user's words for each turn, as they arrive
  const turnLog = []; // when each turn-taking event arrived, for the call's timing summary
  const timers = [];

  const send = (event) => {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  };

  // Fire and forget: measuring the call must never get in the way of ending it.
  function sendTurnMetrics() {
    const endedAt = performance.now();
    Promise.resolve()
      .then(() => api(`/api/calls/${callId}/metrics`, { method: 'POST', body: summarizeTurns(turnLog, { connectedAt, endedAt }) }))
      .catch((error) => console.warn('Could not send turn metrics', error));
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    sendTurnMetrics();
    timers.forEach(clearTimeout);
    channel?.close();
    pc?.close();
    microphone?.getTracks().forEach((track) => track.stop());
    audio.srcObject = null;
    onEnded(reason);
  }

  // The contact speaks first, but only once the user can actually hear them.
  function greetWhenReady() {
    if (greeted || !channelOpen || !audioPlaying) return;
    greeted = true;
    connectedAt = performance.now();
    onStatus('connected', maxCallSeconds);
    send({ type: 'response.create' });
  }

  function playAudio() {
    audio.play().then(
      () => {
        audioPlaying = true;
        greetWhenReady();
      },
      () => onNeedsTap(),
    );
  }

  // OpenAI doesn't reply on its own, so the app asks for every reply. Only one reply can be
  // written at a time, so one asked for mid-reply waits for that reply to finish.
  function requestReply(note = null) {
    if (responding) {
      queuedReply = { note };
      return;
    }
    // A system message steers this one reply without replacing the contact's instructions.
    if (note) send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: note }] } });
    send({ type: 'response.create' });
  }

  function answerTurn(itemId, { timedOut = false } = {}) {
    const transcript = transcripts.get(itemId) ?? (timedOut ? '' : null);
    const decision = classifyTurn({ talkedOverContact: talkedOver.has(itemId), transcript });
    if (decision === 'wait') {
      waitingTurn = { itemId, timer: setTimeout(() => answerTurn(itemId, { timedOut: true }), TRANSCRIPT_WAIT_MS) };
      timers.push(waitingTurn.timer);
      return;
    }
    if (waitingTurn?.itemId === itemId) {
      clearTimeout(waitingTurn.timer);
      waitingTurn = null;
    }
    talkedOver.delete(itemId);
    transcripts.delete(itemId);
    if (decision === 'resume') {
      turnLog.push({ type: 'aizuchi', at: performance.now() });
      requestReply(RESUME_NOTE);
    } else {
      requestReply();
    }
  }

  function heardWords(itemId, words) {
    transcripts.set(itemId, words);
    if (waitingTurn?.itemId === itemId) answerTurn(itemId);
  }

  // The speed can only change between turns, so a change made mid-sentence waits for the turn to end.
  function updateVoice({ settings, turnDetection }) {
    const update = {
      type: 'session.update',
      session: { type: 'realtime', audio: { input: { turn_detection: turnDetection }, output: { speed: settings.speed } } },
    };
    if (responding) pendingVoiceUpdate = update;
    else send(update);
  }

  const TOOLS = {
    async update_settings(change) {
      const { settings, turnDetection } = await api('/api/settings', { method: 'PATCH', body: change });
      updateVoice({ settings, turnDetection });
      onSettings(settings);
      return { ok: true, settings };
    },
    async add_to_stack(word) {
      const { added, word: saved } = await api('/api/stack/words', { method: 'POST', body: word });
      if (added) onWordAdded(saved);
      return { ok: true, added };
    },
  };

  async function runTool(call) {
    try {
      return await TOOLS[call.name](JSON.parse(call.arguments || '{}'));
    } catch (error) {
      console.warn(`${call.name} failed`, error);
      return { ok: false };
    }
  }

  async function handleToolCalls(items) {
    const calls = items.filter((item) => item.type === 'function_call');
    if (!calls.length) return;
    if (calls.some((call) => call.name === 'end_call')) {
      hangingUp = true;
      // The reply finishes generating before it finishes playing, so wait for the goodbye to be heard.
      const goodbyeStillPlaying = speaking || (items.some((item) => item.type === 'message') && !audioFinished);
      timers.push(setTimeout(() => end('finished'), goodbyeStillPlaying ? GOODBYE_TIMEOUT_MS : HANG_UP_AFTER_GOODBYE_MS));
      return;
    }
    for (const call of calls) {
      const output = await runTool(call);
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
    }
    // If the word was saved while the contact was already explaining it, they've said what they needed to.
    const alreadyAnswered = items.some((item) => item.type === 'message') && calls.every((call) => call.name === 'add_to_stack');
    if (!alreadyAnswered) send({ type: 'response.create' });
  }

  function handleEvent(event) {
    if (TIMED_EVENTS.has(event.type)) turnLog.push({ type: event.type, at: performance.now() });
    switch (event.type) {
      case 'response.created':
        responding = true;
        audioFinished = false;
        break;
      case 'response.output_audio_transcript.delta':
        onLine({ id: event.item_id, from: 'contact', delta: event.delta });
        break;
      case 'input_audio_buffer.speech_started':
        if (speaking) talkedOver.add(event.item_id);
        break;
      // This holds the user's place in the transcript, because their words arrive after the reply has started.
      case 'input_audio_buffer.committed':
        onLine({ id: event.item_id, from: 'you', text: '' });
        answerTurn(event.item_id);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        onLine({ id: event.item_id, from: 'you', text: event.transcript });
        heardWords(event.item_id, event.transcript ?? '');
        break;
      case 'conversation.item.input_audio_transcription.failed':
        heardWords(event.item_id, '');
        break;
      case 'output_audio_buffer.started':
        speaking = true;
        onSpeaking(true);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        speaking = false;
        audioFinished = true;
        onSpeaking(false);
        if (hangingUp) timers.push(setTimeout(() => end('finished'), HANG_UP_AFTER_GOODBYE_MS));
        break;
      case 'response.done':
        responding = false;
        if (pendingVoiceUpdate) {
          send(pendingVoiceUpdate);
          pendingVoiceUpdate = null;
        }
        if (queuedReply) {
          const { note } = queuedReply;
          queuedReply = null;
          requestReply(note);
        }
        handleToolCalls(event.response?.output ?? []);
        break;
      case 'error':
        console.warn('Voice engine error', event.error);
        break;
      default:
    }
  }

  async function connect() {
    onStatus('connecting');
    const { clientSecret, sdpUrl, maxSeconds } = await api(`/api/calls/${callId}/session`, { method: 'POST' });
    maxCallSeconds = maxSeconds;
    if (ended) return;
    microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (ended) {
      microphone.getTracks().forEach((track) => track.stop());
      return;
    }

    pc = new RTCPeerConnection();
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      playAudio();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') end('dropped');
    };
    pc.addTrack(microphone.getAudioTracks()[0], microphone);

    channel = pc.createDataChannel(DATA_CHANNEL);
    channel.onopen = () => {
      channelOpen = true;
      greetWhenReady();
    };
    channel.onmessage = (message) => handleEvent(JSON.parse(message.data));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(sdpUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
    });
    if (!response.ok) throw new Error(`Call could not connect (${response.status})`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });

    timers.push(
      setTimeout(() => requestReply(WRAP_UP_NOTE), (maxSeconds - WRAP_UP_BEFORE_END_SECONDS) * 1000),
      setTimeout(() => end('time-limit'), maxSeconds * 1000),
    );
  }

  connect().catch((error) => {
    console.warn('Call failed', error);
    end(error.name === 'NotAllowedError' ? 'no-microphone' : 'failed');
  });

  return {
    hangUp: () => end('hung-up'),
    setMuted: (muted) => microphone?.getAudioTracks().forEach((track) => (track.enabled = !muted)),
    resumeAudio: playAudio,
    updateVoice,
    // Browsers only sometimes let a page pick the speaker, so this reports whether it worked.
    async setSpeaker(on) {
      if (!audio.setSinkId) return false;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((device) => device.kind === 'audiooutput');
      const target = on ? outputs.find((device) => /speaker/i.test(device.label)) : outputs.find((device) => device.deviceId === 'default');
      if (!target) return false;
      await audio.setSinkId(target.deviceId);
      return true;
    },
  };
}
