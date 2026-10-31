// One phone call with Mina: a WebRTC connection straight from this browser to the voice model.

const DATA_CHANNEL = 'oai-events';
const WRAP_UP_BEFORE_END_SECONDS = 20;
const HANG_UP_AFTER_GOODBYE_MS = 600;
const GOODBYE_TIMEOUT_MS = 10_000;

export function startCall({ callId, api, audio, onStatus, onCaption, onSpeaking, onSettings, onEnded, onNeedsTap }) {
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
  const timers = [];

  const send = (event) => {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  };

  function end(reason) {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    channel?.close();
    pc?.close();
    microphone?.getTracks().forEach((track) => track.stop());
    audio.srcObject = null;
    onEnded(reason);
  }

  // Mina speaks first, but only once the user can actually hear her.
  function greetWhenReady() {
    if (greeted || !channelOpen || !audioPlaying) return;
    greeted = true;
    onStatus('connected');
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
      let output = { ok: false };
      try {
        const { settings, turnDetection } = await api('/api/settings', { method: 'PATCH', body: JSON.parse(call.arguments || '{}') });
        // The speed can only change between turns, which is where a finished response leaves us.
        send({
          type: 'session.update',
          session: { type: 'realtime', audio: { input: { turn_detection: turnDetection }, output: { speed: settings.speed } } },
        });
        onSettings(settings);
        output = { ok: true, settings };
      } catch (error) {
        console.warn('Settings change failed', error);
      }
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
    }
    send({ type: 'response.create' });
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'response.created':
        audioFinished = false;
        onCaption('');
        break;
      case 'response.output_audio_transcript.delta':
        onCaption(event.delta, true);
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
      setTimeout(() => {
        send({ type: 'response.create', response: { instructions: 'Time is nearly up. Say a short warm goodbye in Japanese, then call end_call.' } });
      }, (maxSeconds - WRAP_UP_BEFORE_END_SECONDS) * 1000),
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
  };
}
