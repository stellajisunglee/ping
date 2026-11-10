// One phone call with a contact: a WebRTC connection straight from this browser to the voice model.

import { classifyTurn, resumeNote } from './aizuchi.js';
import { loadSmartTurn, startSmartTurn } from './smart-turn.js';
import { summarizeTurns, TIMED_EVENTS } from './turn-metrics.js';

const DATA_CHANNEL = 'oai-events';
const WRAP_UP_BEFORE_END_SECONDS = 20;
const HANG_UP_AFTER_GOODBYE_MS = 600;
const GOODBYE_TIMEOUT_MS = 10_000;
// A turn that talked over the contact waits this long for its words. Transcripts usually take 0.3 to 0.5 seconds.
const TRANSCRIPT_WAIT_MS = 1500;
const WRAP_UP_NOTE = 'Time is nearly up. Say a short warm goodbye in Japanese, then call end_call.';

// OpenAI's docs don't say how running out of credit shows up during a call. Its text API reports it as
// type "insufficient_quota", code "credit_balance_exhausted", so any error mentioning quota or credit counts.
export const isOutOfCredit = (error) => Boolean(error) && /quota|credit/i.test(`${error.type ?? ''} ${error.code ?? ''}`);

export function startCall({
  callId,
  api,
  audio,
  onStatus,
  onLine,
  onWordAdded,
  onSpeaking,
  onSettings,
  onEnded,
  onNeedsTap,
  onContactAudio = () => {}, // when the contact's voice starts, finishes or is cut off, per line
  onOutOfCredit = () => {}, // OpenAI refused the call because the account has no credit left
  smartTurnEngine = { load: loadSmartTurn, start: startSmartTurn }, // swapped for a stand-in in tests
}) {
  let pc = null;
  let channel = null;
  let microphone = null;
  let ended = false;
  let creditOut = false;
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
  const plannedReplies = new Map(); // the contact's full text for each reply, even the parts never spoken
  let cutReply = ''; // the full text of the reply the user last cut off
  const turnLog = []; // when each turn-taking event arrived, for the call's timing summary
  // Which line each reply's voice belongs to. The voice can start before the reply's first words arrive.
  const replyLines = new Map(); // response id -> item id
  let playing = null; // { responseId, itemId, at }
  const timers = [];
  // Smart Turn mode: the call starts in silence mode, then the phone takes over turn-taking once the
  // models have loaded, and OpenAI's own detection is switched off. Any trouble and it switches back.
  const smart = {
    loading: null, // the models loading, in smartTurn mode only
    engine: null, // listening to the microphone
    active: false, // the phone is deciding turns, and OpenAI's detection is off
    silenceDetection: null, // OpenAI's silence settings for this call, to switch back to
    openAiHearsSpeech: false, // OpenAI's detection is mid-turn, so switching now would cut it short
    switchWhenQuiet: false,
    talkedOver: false, // the turn in progress started while the contact was speaking
    rules: null, // how sure Smart Turn must be and how long its backup waits, from the "time to answer" setting
  };

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

  function outOfCredit(error) {
    if (!isOutOfCredit(error) || creditOut) return;
    creditOut = true;
    onOutOfCredit();
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    smart.engine?.stop();
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
    // Smart Turn takes over once it has loaded and is hearing the microphone. Until then, and if it
    // can't, the call runs in silence mode.
    smart.loading?.then(startSmartTurnMode).catch((error) => {
      console.warn('Smart Turn could not start', error);
      fallBackToSilence(error.message === 'no audio from the microphone' ? 'no-audio' : 'load');
    });
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
    const planned = cutReply;
    cutReply = '';
    if (decision === 'resume') {
      turnLog.push({ type: 'aizuchi', at: performance.now() });
      requestReply(resumeNote(planned));
    } else {
      requestReply();
    }
  }

  function heardWords(itemId, words) {
    transcripts.set(itemId, words);
    if (waitingTurn?.itemId === itemId) answerTurn(itemId);
  }

  // The speed can only change between turns, so a change made mid-sentence waits for the turn to end.
  function updateVoice({ settings, turnDetection, smartTurn }) {
    if (smartTurn) {
      smart.rules = smartTurn;
      smart.engine?.setRules(smartTurn);
    }
    // While the phone is deciding turns, OpenAI's detection stays off. The new silence settings are
    // kept for switching back.
    if (turnDetection?.type === 'server_vad') smart.silenceDetection = turnDetection;
    const update = {
      type: 'session.update',
      session: { type: 'realtime', audio: { input: { turn_detection: smart.active ? null : turnDetection }, output: { speed: settings.speed } } },
    };
    if (responding) pendingVoiceUpdate = update;
    else send(update);
  }

  // ---------- Smart Turn mode ----------

  async function startSmartTurnMode(models) {
    if (ended) return;
    turnLog.push({ type: 'smart-turn-loaded', at: performance.now(), loadMs: models.loadMs });
    smart.engine = await smartTurnEngine.start({ stream: microphone, models, onEvent: onSmartTurnEvent, rules: smart.rules ?? undefined });
    if (ended) return smart.engine.stop();
    // Switching while OpenAI is in the middle of the user's turn would lose that turn's end.
    if (smart.openAiHearsSpeech) smart.switchWhenQuiet = true;
    else switchToSmartTurn();
  }

  function switchToSmartTurn() {
    smart.switchWhenQuiet = false;
    smart.active = true;
    send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } } } });
    // Audio from before the switch belongs to no turn.
    if (!smart.engine.inTurn) send({ type: 'input_audio_buffer.clear' });
  }

  function fallBackToSilence(reason) {
    turnLog.push({ type: 'smart-turn-fallback', at: performance.now(), reason });
    console.warn(`Smart Turn is off for this call (${reason}), so Ping is using silence detection.`);
    smart.engine?.stop();
    smart.engine = null;
    smart.switchWhenQuiet = false;
    if (!smart.active) return; // OpenAI's silence detection never went off
    smart.active = false;
    if (smart.silenceDetection) send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: smart.silenceDetection } } } });
  }

  function onSmartTurnEvent(event) {
    if (event.type === 'fallback') return fallBackToSilence(event.reason);
    if (event.type === 'decision') return turnLog.push({ type: 'smart-turn-decision', at: event.at, ms: event.ms });
    if (event.type === 'audio-restart') return turnLog.push({ type: 'smart-turn-audio-restart', at: performance.now() });
    if (!smart.active) return;
    if (event.type === 'speech-start') {
      // Logged as OpenAI would have, so the call's numbers work the same in every mode.
      turnLog.push({ type: 'input_audio_buffer.speech_started', at: event.at });
      smart.talkedOver = speaking;
      // The user talking over the contact stops them, as OpenAI's own detection would. OpenAI trims the
      // reply to what was heard by itself. A reply already fully written can't be cancelled, only silenced.
      if (responding) send({ type: 'response.cancel' });
      if (speaking) send({ type: 'output_audio_buffer.clear' });
    } else if (event.type === 'end-turn') {
      turnLog.push({ type: 'smart-turn-end', at: event.at, quietSince: event.quietSince, reason: event.reason });
      send({ type: 'input_audio_buffer.commit' });
    }
  }

  const TOOLS = {
    async update_settings(change) {
      const { settings, turnDetection, smartTurn } = await api('/api/settings', { method: 'PATCH', body: change });
      updateVoice({ settings, turnDetection, smartTurn });
      onSettings(settings);
      return { ok: true, settings };
    },
    async add_to_stack(word) {
      const { added, alreadySaved, word: saved } = await api('/api/stack/words', { method: 'POST', body: word });
      if (added || alreadySaved) onWordAdded(saved, { alreadySaved: Boolean(alreadySaved) });
      return { ok: true, added, alreadySaved: Boolean(alreadySaved) };
    },
    // Nothing to run: the answer to a language or culture question ends here, and the conversation picks up as a new message.
    async back_to_conversation() {
      return { ok: true };
    },
  };

  async function runTool(call) {
    try {
      return await TOOLS[call.name](JSON.parse(call.arguments || '{}'));
    } catch (error) {
      console.warn(`${call.name} failed`, error);
      return { ok: false, error: error.message };
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
    const at = performance.now();
    if (TIMED_EVENTS.has(event.type)) turnLog.push({ type: event.type, at, audioMs: event.audio_start_ms ?? event.audio_end_ms });
    // The silence and padding settings OpenAI is using, which the hidden-wait estimate needs.
    const detection = event.session?.audio?.input?.turn_detection;
    if (detection) {
      const silenceMode = detection.type === 'server_vad';
      if (silenceMode && !smart.silenceDetection) smart.silenceDetection = detection;
      turnLog.push({ type: 'turn-detection', at, silenceMs: silenceMode ? detection.silence_duration_ms ?? 0 : 0, paddingMs: silenceMode ? detection.prefix_padding_ms ?? 0 : 0 });
    }
    switch (event.type) {
      case 'response.created':
        responding = true;
        audioFinished = false;
        break;
      case 'response.output_audio_transcript.delta':
        plannedReplies.set(event.item_id, (plannedReplies.get(event.item_id) ?? '') + event.delta);
        onLine({ id: event.item_id, from: 'contact', delta: event.delta });
        if (event.response_id) replyLines.set(event.response_id, event.item_id);
        if (playing && !playing.itemId && playing.responseId === event.response_id) {
          playing.itemId = event.item_id;
          onContactAudio({ type: 'start', itemId: playing.itemId, at: playing.at });
        }
        break;
      // OpenAI trimmed this reply to what the user heard, so keep the full version in case they only said うん.
      case 'conversation.item.truncated':
        cutReply = plannedReplies.get(event.item_id) ?? '';
        onContactAudio({ type: 'heard', itemId: event.item_id, audioEndMs: event.audio_end_ms });
        break;
      case 'input_audio_buffer.speech_started':
        smart.openAiHearsSpeech = true;
        if (speaking) talkedOver.add(event.item_id);
        break;
      case 'input_audio_buffer.speech_stopped':
        smart.openAiHearsSpeech = false;
        break;
      // This holds the user's place in the transcript, because their words arrive after the reply has started.
      case 'input_audio_buffer.committed':
        smart.openAiHearsSpeech = false;
        if (smart.active && smart.talkedOver) talkedOver.add(event.item_id);
        smart.talkedOver = false;
        onLine({ id: event.item_id, from: 'you', text: '' });
        answerTurn(event.item_id);
        if (smart.switchWhenQuiet) switchToSmartTurn();
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
        playing = { responseId: event.response_id, itemId: replyLines.get(event.response_id) ?? null, at };
        if (playing.itemId) onContactAudio({ type: 'start', itemId: playing.itemId, at });
        // Without OpenAI's detection, the input buffer keeps everything since the last turn. Start the
        // next turn clean, so it never includes silence or echo from while the contact was talking.
        if (smart.active && !smart.engine?.inTurn) send({ type: 'input_audio_buffer.clear' });
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (playing?.itemId) onContactAudio({ type: event.type.endsWith('stopped') ? 'end' : 'cut', itemId: playing.itemId, at });
        playing = null;
        speaking = false;
        audioFinished = true;
        onSpeaking(false);
        if (hangingUp) timers.push(setTimeout(() => end('finished'), HANG_UP_AFTER_GOODBYE_MS));
        break;
      case 'response.done':
        responding = false;
        if (pendingVoiceUpdate) {
          if (smart.active) pendingVoiceUpdate.session.audio.input.turn_detection = null;
          send(pendingVoiceUpdate);
          pendingVoiceUpdate = null;
        }
        if (queuedReply) {
          const { note } = queuedReply;
          queuedReply = null;
          requestReply(note);
        }
        if (event.response?.status === 'failed') outOfCredit(event.response.status_details?.error);
        handleToolCalls(event.response?.output ?? []);
        break;
      case 'error':
        console.warn('Voice engine error', event.error);
        outOfCredit(event.error);
        break;
      default:
    }
  }

  async function connect() {
    onStatus('connecting');
    const { clientSecret, sdpUrl, maxSeconds, turnMode, smartTurn } = await api(`/api/calls/${callId}/session`, { method: 'POST' });
    smart.rules = smartTurn ?? null;
    // Start loading Smart Turn straight away, so it's usually ready by the time the greeting ends.
    if (turnMode === 'smartTurn') {
      smart.loading = smartTurnEngine.load();
      smart.loading.catch(() => {}); // a failure is handled once the call connects, below
    }
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
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      outOfCredit(body?.error);
      throw new Error(`Call could not connect (${response.status})`);
    }
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
