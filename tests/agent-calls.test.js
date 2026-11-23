import test from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64, startElevenLabsCall, toBase64 } from '../public/elevenlabs-call.js';
import { startLiveCall } from '../public/live-call.js';
import { liveSession } from '../server/live.js';
import { elevenOverrides, elevenSpeed } from '../server/elevenlabs.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { QUESTIONS } from '../server/lines.js';

const details = { question: QUESTIONS[0], settings: { ...DEFAULT_SETTINGS }, localHour: 10, localDate: { year: 2026, month: 11, day: 23 }, calledBack: false, contact: { id: 'ping', name: 'Ping', spokenName: 'ピン', topic: 'daily life' }, learnerName: 'ステラ' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const microphone = { getTracks: () => [{ stop() {} }] };
const callbacks = () => {
  const seen = { lines: [], status: [], ended: null, words: [] };
  return {
    seen,
    onStatus: (status) => seen.status.push(status),
    onLine: (line) => seen.lines.push(line),
    onWordAdded: (word) => seen.words.push(word),
    onSpeaking: () => {},
    onSettings: () => {},
    onEnded: (reason) => (seen.ended = reason),
    onNeedsTap: () => {},
  };
};

test("GPT-Live's session greets by name, keeps Ping's rules, and runs tools through the backend", () => {
  const session = liveSession(details);
  assert.match(session.input[0].content[0].text, /ステラさん/);
  assert.ok(session.instructions.startsWith('You are Ping'));
  assert.equal(session.delegation.type, 'responses');
  assert.equal(session.delegation.responses.model, 'gpt-4.1-mini');
});

test("ElevenLabs' overrides set the prompt, greeting, Japanese and a speed inside its range", () => {
  const overrides = elevenOverrides({ ...details, settings: { ...details.settings, speed: 1.5 } });
  assert.equal(overrides.agent.language, 'ja');
  assert.equal(overrides.tts.speed, 1.2);
  assert.deepEqual([elevenSpeed(0.6), elevenSpeed(1), elevenSpeed(0.85)], [0.7, 1, 0.85]);
});

test('an ElevenLabs call: overrides first, pings answered, tools run, interrupted audio skipped', async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 1;
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
  }
  const played = [];
  const { seen, ...handlers } = callbacks();
  const api = async (path) => (path === '/api/stack/words' ? { added: true, word: { id: 'w1', kana: 'さんぽ' } } : {});
  const call = startElevenLabsCall({
    callId: 'c1',
    api,
    audio: { play: async () => {} },
    session: { signedUrl: 'wss://example/x', overrides: { agent: { language: 'ja' } }, maxSeconds: 180, hangUpLines: [], timeUpNote: 'bye' },
    microphone,
    ...handlers,
    WebSocketClass: FakeSocket,
    makePlayer: () => ({ stream: {}, resume: async () => {}, play: (data) => played.push(data.byteLength), remaining: () => 0, stop() {}, close() {} }),
    makeMicrophoneStream: async () => ({ close() {} }),
  });
  const socket = sockets[0];
  socket.onopen();
  assert.deepEqual(socket.sent[0], { type: 'conversation_initiation_client_data', conversation_config_override: { agent: { language: 'ja' } } });
  const message = (data) => socket.onmessage({ data: JSON.stringify(data) });
  message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'x' } });
  assert.deepEqual(seen.status, ['connecting', 'connected']);
  message({ type: 'ping', ping_event: { event_id: 7 } });
  assert.deepEqual(socket.sent.at(-1), { type: 'pong', event_id: 7 });
  message({ type: 'agent_response', agent_response_event: { agent_response: 'もしもし！' } });
  message({ type: 'audio', audio_event: { audio_base_64: toBase64(new Uint8Array([1, 0, 2, 0]).buffer), event_id: 3 } });
  message({ type: 'interruption', interruption_event: { event_id: 4 } });
  message({ type: 'audio', audio_event: { audio_base_64: toBase64(new Uint8Array([1, 0]).buffer), event_id: 4 } });
  assert.deepEqual(played, [4], 'audio from the interrupted reply is skipped');
  message({ type: 'client_tool_call', client_tool_call: { tool_name: 'add_to_stack', tool_call_id: 't1', parameters: { kana: 'さんぽ' }, expects_response: true } });
  await tick();
  await tick();
  assert.deepEqual(seen.words, [{ id: 'w1', kana: 'さんぽ' }]);
  assert.deepEqual(socket.sent.at(-1).type, 'client_tool_result');
  assert.equal(socket.sent.at(-1).tool_call_id, 't1');
  message({ type: 'user_transcript', user_transcription_event: { user_transcript: '散歩しました' } });
  assert.deepEqual(seen.lines.map((line) => line.from), ['contact', 'you']);
  call.hangUp();
  assert.equal(seen.ended, 'hung-up');
});

test('base64 audio goes both ways intact', () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 128]);
  assert.deepEqual(new Uint8Array(fromBase64(toBase64(bytes.buffer))), bytes);
});

test('a GPT-Live call: offer to the server, transcripts become lines, and a function call is answered on the data channel', async () => {
  const sent = [];
  let channel;
  class FakePeer {
    constructor() {
      this.iceGatheringState = 'complete';
      this.localDescription = null;
    }
    addTrack() {}
    createDataChannel() {
      channel = { readyState: 'open', send: (data) => sent.push(JSON.parse(data)) };
      return channel;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
    }
    async setRemoteDescription(description) {
      this.remote = description;
    }
    close() {}
  }
  const requests = [];
  const api = async (path, options = {}) => {
    requests.push({ path, body: options.body });
    if (path.endsWith('/live')) return { sdp: 'v=0 answer' };
    if (path === '/api/settings') return { settings: { ...DEFAULT_SETTINGS, speed: 0.85 } };
    return {};
  };
  const { seen, ...handlers } = callbacks();
  const call = startLiveCall({ callId: 'c2', api, audio: {}, session: { maxSeconds: 180, hangUpLines: [], timeUpNote: 'bye' }, microphone, ...handlers, onFallback: () => {}, PeerConnectionClass: FakePeer });
  await tick();
  await tick();
  assert.deepEqual(requests[0], { path: '/api/calls/c2/live', body: { sdp: 'v=0 offer' } });
  const event = (data) => channel.onmessage({ data: JSON.stringify(data) });
  event({ type: 'session.started', session: { id: 'live_1' } });
  event({ type: 'session.output_transcript.delta', delta: 'もしもし、', start_ms: 0, end_ms: 400 });
  event({ type: 'session.output_transcript.delta', delta: 'ピンです！', start_ms: 400, end_ms: 900 });
  event({ type: 'session.input_transcript.delta', delta: 'はい', start_ms: 2000, end_ms: 2300 });
  assert.deepEqual(seen.lines.map((line) => [line.id, line.from, line.delta]), [['live-contact-1', 'contact', 'もしもし、'], ['live-contact-1', 'contact', 'ピンです！'], ['live-you-2', 'you', 'はい']]);
  event({ type: 'response.event', delegation_id: 'd1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'update_settings', arguments: '{"speedChange":"slower"}' } } });
  await tick();
  await tick();
  const types = sent.map((message) => message.type);
  assert.ok(types.includes('session.instructions.append'), 'the new speed goes in as a note');
  assert.deepEqual(sent.filter((message) => message.type !== 'session.instructions.append'), [
    { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ ok: true, settings: { ...DEFAULT_SETTINGS, speed: 0.85 } }) } },
    { type: 'response.create' },
  ]);
  call.hangUp();
  assert.equal(seen.ended, 'hung-up');
  assert.equal(sent.at(-1).type, 'session.close');
});

test('when the server moves a GPT-Live call to the Realtime API, the phone starts again quietly', async () => {
  class FakePeer {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'v=0 offer' };
    addTrack() {}
    createDataChannel() {
      return { readyState: 'open', send() {} };
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 offer' };
    }
    async setLocalDescription() {}
    close() {}
  }
  let fellBack = false;
  const api = async () => {
    const error = new Error('GPT-Live is unavailable.');
    error.status = 409;
    throw error;
  };
  const { seen, ...handlers } = callbacks();
  startLiveCall({ callId: 'c3', api, audio: {}, session: { maxSeconds: 180 }, microphone, ...handlers, onFallback: () => (fellBack = true), PeerConnectionClass: FakePeer });
  await tick();
  await tick();
  assert.equal(fellBack, true);
  assert.equal(seen.ended, null, 'the call itself carries on');
});
