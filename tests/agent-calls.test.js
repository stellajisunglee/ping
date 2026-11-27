import test from 'node:test';
import assert from 'node:assert/strict';
import { startCartesiaCall } from '../public/cartesia-call.js';
import { fromBase64, startElevenLabsCall, toBase64 } from '../public/elevenlabs-call.js';
import { agentRequest as cartesiaAgentRequest, toolRequests as cartesiaToolRequests } from '../scripts/setup-cartesia.js';
import { cartesiaOverrides, cartesiaSpeed, createCartesia, socketUrl } from '../server/cartesia.js';
import { startLiveCall } from '../public/live-call.js';
import { liveSession } from '../server/live.js';
import { elevenOverrides, elevenSpeed } from '../server/elevenlabs.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { QUESTIONS } from '../server/lines.js';

const details = { question: QUESTIONS[0], settings: { ...DEFAULT_SETTINGS }, localHour: 10, localDate: { year: 2026, month: 11, day: 23 }, calledBack: false, contact: { id: 'ping', name: 'Ping', spokenName: 'ピン', topic: 'daily life' }, learnerName: 'ステラ' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = () => new Promise((resolve) => setImmediate(resolve)); // for tests that mock setTimeout
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

// ---------- Cartesia Agents ----------

test("Cartesia's call settings carry Ping's instructions, greeting, Japanese and a speed inside its range", () => {
  const overrides = cartesiaOverrides({ ...details, settings: { ...details.settings, speed: 1.7 } });
  assert.ok(overrides.instructions.startsWith('You are Ping'));
  assert.match(overrides.initial_message, /ステラさん/);
  assert.ok(overrides.initial_message.length <= 1000, "Cartesia's limit for a first message");
  assert.deepEqual(overrides.language, { primary: 'ja' });
  assert.equal(overrides.audio.output.speed, 1.5);
  assert.deepEqual([cartesiaSpeed(0.5), cartesiaSpeed(1), cartesiaSpeed(0.85)], [0.6, 1, 0.85]);
  assert.deepEqual(Object.keys(overrides).sort(), ['audio', 'initial_message', 'instructions', 'language'], 'only fields a session accepts');
  assert.ok(overrides.instructions.includes('call hang_up') && !overrides.instructions.includes('end_call'), "the instructions name Ping's hang-up as Cartesia knows it");
});

test("the phone's Cartesia address carries the session's one-use token and the API version", () => {
  const url = new URL(socketUrl({ url: 'wss://api-us.cartesia.ai/v1/agents/websocket/agent_1', token: 'a.b+c' }));
  assert.equal(url.host, 'api-us.cartesia.ai');
  assert.equal(url.searchParams.get('access_token'), 'a.b+c');
  assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
});

test("Ping's server makes a Cartesia session with the key, and deletes Cartesia's copy of a call", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    if (options.method === 'DELETE') return { ok: false, status: 404, text: async () => '' };
    return { ok: true, json: async () => ({ call_id: 'ac_1', url: 'wss://api-us.cartesia.ai/v1/agents/websocket/agent_1', token: 'tok', expires_at: 'soon' }) };
  };
  const cartesia = createCartesia({ apiKey: 'sk_car_test', agentId: 'agent_1', fetchImpl });
  assert.equal(cartesia.hasKey, true);
  assert.equal(createCartesia({ apiKey: 'sk_car_test', agentId: '' }).hasKey, false, 'needs the agent too');
  const session = await cartesia.startSession({ instructions: 'hi' });
  assert.equal(session.callId, 'ac_1');
  assert.match(session.socketUrl, /^wss:\/\/api-us\.cartesia\.ai\/v1\/agents\/websocket\/agent_1\?access_token=tok&cartesia_version=2026-08-14$/);
  assert.equal(requests[0].url, 'https://api.cartesia.ai/v1/agents/websocket/agent_1/sessions');
  assert.deepEqual(JSON.parse(requests[0].body), { config_overrides: { instructions: 'hi' } });
  assert.equal(requests[0].headers.Authorization, 'Bearer sk_car_test');
  assert.equal(await cartesia.deleteCall('ac_1'), true, 'a call already gone counts as deleted');
  assert.deepEqual([requests[1].method, requests[1].url], ['DELETE', 'https://api.cartesia.ai/agents/calls/ac_1']);
  const refusing = createCartesia({ apiKey: 'k', agentId: 'a', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
  await assert.rejects(refusing.startSession({}), /Cartesia refused the call \(500\)/);
  await assert.rejects(refusing.deleteCall('ac_2'), /didn't delete call ac_2/);
});

test("Cartesia's setup makes Ping's four tools as client tools that run straight away, and a Japanese agent", () => {
  const tools = cartesiaToolRequests();
  assert.deepEqual(tools.map((tool) => tool.name), ['add_to_stack', 'update_settings', 'back_to_conversation', 'hang_up'], "end_call is Cartesia's own name");
  for (const tool of tools) {
    assert.deepEqual([tool.type, tool.expects_response, tool.pre_tool_speech, tool.execution_mode], ['client', true, 'off', 'immediate']);
    assert.ok(!JSON.stringify(tool.parameters).includes('additionalProperties'));
  }
  const agent = cartesiaAgentRequest({ toolIds: ['t1', 't2'] });
  assert.deepEqual(agent.config.tools, [{ id: 't1' }, { id: 't2' }]);
  assert.deepEqual([agent.config.language.primary, agent.config.model.id, agent.config.audio.output.voice_id], ['ja', 'gpt-4.1-mini', '498e7f37-7fa3-4e2c-b8e2-8b6e9276f956']);
  assert.deepEqual(agent.config.system_tools, { end_call: null }, "Cartesia's own hang-up is off: it skips the goodbye");
});

function cartesiaCall({ api = async () => ({}), hangUpLines = [], maxSeconds = 180 } = {}) {
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
  const player = { stops: 0, left: 0 };
  const microphoneChunks = [];
  const { seen, ...handlers } = callbacks();
  seen.audio = [];
  seen.metrics = [];
  seen.turns = [];
  const call = startCartesiaCall({
    callId: 'c1',
    api: async (path, options) => {
      if (path.endsWith('/metrics')) seen.metrics.push(options.body);
      if (path.endsWith('/turns')) seen.turns.push(options.body);
      return api(path, options);
    },
    audio: { play: async () => {} },
    session: { socketUrl: 'wss://api-us.cartesia.ai/v1/agents/websocket/agent_1?access_token=tok&cartesia_version=2026-08-14', maxSeconds, hangUpLines },
    microphone,
    ...handlers,
    onContactAudio: (event) => seen.audio.push(`${event.type}:${event.itemId}`),
    WebSocketClass: FakeSocket,
    makePlayer: () => ({ stream: {}, resume: async () => {}, play: (data) => played.push(data.byteLength), remaining: () => player.left, stop: () => (player.stops += 1), close() {} }),
    makeMicrophoneStream: async ({ onAudio }) => {
      microphoneChunks.push(onAudio);
      return { close() {} };
    },
  });
  const socket = sockets[0];
  const message = (data) => socket.onmessage({ data: JSON.stringify(data) });
  return { call, socket, message, seen, played, player, microphoneChunks };
}

test('a Cartesia call: the audio format first, then the microphone, the greeting as it is said, and the learner turn', async () => {
  const { call, socket, message, seen, played, microphoneChunks } = cartesiaCall();
  assert.equal(socket.url, 'wss://api-us.cartesia.ai/v1/agents/websocket/agent_1?access_token=tok&cartesia_version=2026-08-14');
  socket.onopen();
  assert.deepEqual(socket.sent, [{ type: 'session_create', audio: { input_format: 'pcm_24000' } }], 'no instructions from the phone: the server set them');
  message({ type: 'session_ready', call_id: 'ac_1', agent_id: 'agent_1' });
  assert.deepEqual(seen.status, ['connecting', 'connected']);
  await tick();
  microphoneChunks[0](new Uint8Array([1, 0, 2, 0]).buffer);
  assert.deepEqual(socket.sent.at(-1), { type: 'audio_input', audio: toBase64(new Uint8Array([1, 0, 2, 0]).buffer) });

  message({ type: 'turn_started', turn: 1, role: 'assistant' });
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([1, 0, 2, 0]).buffer) });
  message({ type: 'turn_output_text_delta', turn: 1, role: 'assistant', text: 'もし' });
  message({ type: 'turn_output_text_delta', turn: 1, role: 'assistant', text: 'もし！' });
  message({ type: 'turn_ended', turn: 1, role: 'assistant', text: 'もしもし！', interrupted: false, tool_calls: [] });
  assert.deepEqual(played, [4]);
  assert.deepEqual(seen.lines, [
    { id: 'cartesia-contact-1', from: 'contact', delta: 'もし' },
    { id: 'cartesia-contact-1', from: 'contact', delta: 'もし！' },
    { id: 'cartesia-contact-1', from: 'contact', text: 'もしもし！' },
  ]);
  assert.deepEqual(seen.audio, ['start:cartesia-contact-1'], "the line's voice started once its words arrived");

  message({ type: 'turn_started', turn: 2, role: 'user' });
  message({ type: 'turn_ended', turn: 2, role: 'user', text: 'はい、大丈夫です', interrupted: false, tool_calls: [] });
  message({ type: 'turn_ended', turn: 3, role: 'user', text: '', interrupted: false, tool_calls: [] });
  assert.deepEqual(seen.lines.at(-1), { id: 'cartesia-you-2', from: 'you', text: 'はい、大丈夫です' }, 'an empty turn shows no line');
  call.hangUp();
  assert.equal(seen.ended, 'hung-up');
});

test('a Cartesia call: talking over the voice stops it, and its interrupted text is left as heard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, message, seen, player } = cartesiaCall();
  socket.onopen();
  message({ type: 'session_ready', call_id: 'ac_1' });
  message({ type: 'turn_output_text_delta', turn: 1, role: 'assistant', text: '今日は何を' });
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([1, 0]).buffer) });
  message({ type: 'turn_started', turn: 2, role: 'user' });
  message({ type: 'audio_output_clear' });
  message({ type: 'turn_ended', turn: 1, role: 'assistant', text: '今日は何をしましたか？', interrupted: true, tool_calls: [] });
  assert.equal(player.stops, 1);
  assert.deepEqual(seen.audio, ['start:cartesia-contact-1', 'cut:cartesia-contact-1']);
  assert.ok(!seen.lines.some((line) => line.text === '今日は何をしましたか？'), "the full text of a line cut off isn't shown");
});

test('a Cartesia call: tools run on the phone and their results go back, and hang_up hangs up after the goodbye', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = async (path) => (path === '/api/stack/words' ? { added: true, word: { id: 'w1', kana: 'いそがしい' } } : { settings: { speed: 0.9, formality: 'formal', proficiency: 'N5' } });
  const { socket, message, seen, player } = cartesiaCall({ api });
  socket.onopen();
  message({ type: 'session_ready', call_id: 'ac_1' });
  message({ type: 'client_tool_call', tool_call_id: 't1', tool_name: 'add_to_stack', parameters: { kana: 'いそがしい' }, expects_response: true });
  await flush();
  await flush();
  assert.deepEqual(seen.words, [{ id: 'w1', kana: 'いそがしい' }]);
  assert.deepEqual(socket.sent.at(-1), { type: 'client_tool_result', tool_call_id: 't1', result: JSON.stringify({ ok: true, added: true, alreadySaved: false }), is_error: false });
  message({ type: 'client_tool_call', tool_call_id: 't2', tool_name: 'made_up', parameters: {}, expects_response: true });
  await flush();
  assert.equal(socket.sent.at(-1).is_error, true);

  message({ type: 'turn_output_text_delta', turn: 4, role: 'assistant', text: 'またね！' });
  player.left = 1; // the goodbye is still playing
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([1, 0]).buffer) });
  message({ type: 'client_tool_call', tool_call_id: 't3', tool_name: 'hang_up', parameters: {}, expects_response: true });
  await flush();
  t.mock.timers.tick(1500);
  assert.equal(seen.ended, null, 'still saying goodbye');
  player.left = 0;
  t.mock.timers.tick(1200); // the voice is found to have stopped
  t.mock.timers.tick(1200); // then the call hangs up
  await flush();
  assert.equal(seen.ended, 'finished');
  assert.equal(seen.metrics.length, 1);
  await flush();
  assert.deepEqual(seen.turns.at(-1).help.map((event) => event.type), ['lookup', 'end-call'], 'hang_up counts as end-call, like end_call elsewhere');
});

test("a Cartesia call ends at the plan's limit, hangs up after a not-now goodbye, and a socket that never opened is a failed call", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = cartesiaCall({ maxSeconds: 60 });
  timed.socket.onopen();
  timed.message({ type: 'session_ready', call_id: 'ac_1' });
  t.mock.timers.tick(60_000);
  assert.equal(timed.seen.ended, 'time-limit');

  const notNow = cartesiaCall({ hangUpLines: ['また電話しますね'] });
  notNow.socket.onopen();
  notNow.message({ type: 'session_ready', call_id: 'ac_2' });
  notNow.message({ type: 'turn_ended', turn: 3, role: 'assistant', text: 'わかりました、また電話しますね。', interrupted: false, tool_calls: [] });
  t.mock.timers.tick(2500);
  assert.equal(notNow.seen.ended, 'finished');

  const broken = cartesiaCall();
  broken.socket.onclose({ code: 1006 });
  assert.equal(broken.seen.ended, 'failed');

  // Cartesia ending the call on purpose (1000) is a finished call, but a lost connection is a dropped one.
  const closed = cartesiaCall();
  closed.socket.onopen();
  closed.message({ type: 'session_ready', call_id: 'ac_3' });
  closed.socket.onclose({ code: 1000, reason: 'call ended by agent' });
  assert.equal(closed.seen.ended, 'finished');
  const dropped = cartesiaCall();
  dropped.socket.onopen();
  dropped.message({ type: 'session_ready', call_id: 'ac_4' });
  dropped.socket.onclose({ code: 1006 });
  assert.equal(dropped.seen.ended, 'dropped');
});

test("a Cartesia call: after hang_up, only the goodbye plays, and a turn the agent adds after it isn't heard or shown", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, message, seen, played, player } = cartesiaCall();
  socket.onopen();
  message({ type: 'session_ready', call_id: 'ac_1' });
  // The order a live call on Nov 27 sent: the goodbye starts, hang_up comes as its own turn, then an extra turn.
  message({ type: 'turn_started', turn: 3, role: 'assistant' });
  message({ type: 'turn_output_text_delta', turn: 3, role: 'assistant', text: 'わかりました。' });
  player.left = 1;
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([1, 0]).buffer) });
  message({ type: 'client_tool_call', tool_call_id: 't1', tool_name: 'hang_up', parameters: {}, expects_response: true });
  await flush();
  assert.match(socket.sent.at(-1).result, /Say nothing more/);
  message({ type: 'turn_ended', turn: 4, role: 'assistant', text: '', interrupted: false, tool_calls: [{ name: 'hang_up', type: 'client' }] });
  message({ type: 'turn_output_text_delta', turn: 3, role: 'assistant', text: 'また電話しますね！' });
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([3, 0]).buffer) });
  message({ type: 'turn_ended', turn: 3, role: 'assistant', text: 'わかりました。また電話しますね！', interrupted: false, tool_calls: [] });
  message({ type: 'turn_started', turn: 5, role: 'assistant' });
  message({ type: 'turn_output_text_delta', turn: 5, role: 'assistant', text: '(電話を切りました)' });
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([5, 0]).buffer) });
  message({ type: 'turn_ended', turn: 5, role: 'assistant', text: '(電話を切りました)', interrupted: false, tool_calls: [] });
  assert.deepEqual(played, [2, 2], "the extra turn's audio is dropped");
  assert.ok(!seen.lines.some((line) => (line.text ?? line.delta ?? '').includes('電話を切りました')), "and it isn't shown");
  assert.equal(seen.ended, null, 'the goodbye is still playing');
  player.left = 0;
  t.mock.timers.tick(1200);
  t.mock.timers.tick(1200);
  await flush();
  assert.equal(seen.ended, 'finished');
});

test("a Cartesia call: a not-now goodbye recognized from its words hangs up after that turn, and drops the next", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, message, played } = cartesiaCall({ hangUpLines: ['また電話しますね'] });
  socket.onopen();
  message({ type: 'session_ready', call_id: 'ac_1' });
  message({ type: 'turn_started', turn: 3, role: 'assistant' });
  message({ type: 'turn_ended', turn: 3, role: 'assistant', text: 'わかりました。また電話しますね！', interrupted: false, tool_calls: [] });
  message({ type: 'turn_started', turn: 5, role: 'assistant' });
  message({ type: 'audio_output', audio: toBase64(new Uint8Array([5, 0]).buffer) });
  assert.deepEqual(played, [], 'the turn after the recognized goodbye is dropped');
});
