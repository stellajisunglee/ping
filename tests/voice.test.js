import test from 'node:test';
import assert from 'node:assert/strict';
import { startCall } from '../public/voice.js';
import { cleanMetrics } from '../public/turn-metrics.js';

// A stand-in for the browser's WebRTC, so the call's event handling runs without a real connection.
function setupCall({ apiResponses = {}, failPaths = [], session = {}, smartTurnEngine } = {}) {
  const sent = [];
  const peers = [];
  const channel = {
    readyState: 'open',
    send: (event) => sent.push(JSON.parse(event)),
    close() {},
  };
  globalThis.RTCPeerConnection = class {
    constructor() {
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      return channel;
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [{}], getTracks: () => [] }),
        enumerateDevices: async () => [{ kind: 'audiooutput', label: 'Speakerphone', deviceId: 'loud' }, { kind: 'audiooutput', label: 'Default', deviceId: 'default' }],
      },
    },
  });
  globalThis.fetch = async () => ({ ok: true, text: async () => 'answer' });

  const events = { lines: [], words: [], ended: [], settings: [], apiCalls: [], audio: [] };
  const audio = { play: async () => {}, srcObject: null };
  const call = startCall({
    callId: 'c1',
    audio,
    api: async (path, options) => {
      events.apiCalls.push({ path, options });
      if (failPaths.includes(path)) throw new Error('offline');
      if (path.endsWith('/session')) return { clientSecret: 'ek', sdpUrl: 'https://voice.test', maxSeconds: 180, ...session };
      return apiResponses[path];
    },
    onStatus: () => {},
    onLine: (line) => events.lines.push(line),
    onWordAdded: (word) => events.words.push(word),
    onSpeaking: () => {},
    onSettings: (settings) => events.settings.push(settings),
    onEnded: (reason) => events.ended.push(reason),
    onNeedsTap: () => {},
    onContactAudio: ({ type, itemId, audioEndMs }) => events.audio.push(audioEndMs === undefined ? `${type} ${itemId}` : `${type} ${itemId} ${audioEndMs}`),
    ...(smartTurnEngine && { smartTurnEngine }),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async (event) => {
    channel.onmessage({ data: JSON.stringify(event) });
    await settle();
  };
  // The data channel opens and the contact's audio starts playing, so the contact greets the user.
  const answer = async () => {
    channel.onopen();
    peers[0].ontrack({ streams: [{}] });
    await settle();
    await settle();
  };
  return { call, sent, events, fire, settle, channel, audio, answer };
}

async function connected(options) {
  const context = setupCall(options);
  await context.settle();
  await context.settle();
  return context;
}

const finishCall = (context) => context.call.hangUp();

test('the transcript keeps the user line in order, even though it arrives late', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'you1' });
  await context.fire({ type: 'response.output_audio_transcript.delta', item_id: 'ai1', delta: 'そう' });
  await context.fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'you1', transcript: '元気です' });
  assert.deepEqual(context.events.lines, [
    { id: 'you1', from: 'you', text: '' },
    { id: 'ai1', from: 'contact', delta: 'そう' },
    { id: 'you1', from: 'you', text: '元気です' },
  ]);
});

const toolDone = (name, args, extra = []) => ({
  type: 'response.done',
  response: { output: [...extra, { type: 'function_call', name, call_id: 'tool1', arguments: JSON.stringify(args) }] },
});

test('a word the user asked about is saved and announced, then the contact answers', async (t) => {
  const saved = { id: 'w1', kana: 'げんき' };
  const context = await connected({ apiResponses: { '/api/stack/words': { added: true, word: saved } } });
  t.after(() => finishCall(context));
  await context.fire(toolDone('add_to_stack', { kana: 'げんき', romaji: 'genki', english: 'well', kanji: '元気' }));
  assert.deepEqual(context.events.words, [saved]);
  const types = context.sent.map((event) => event.type);
  assert.deepEqual(types.slice(-2), ['conversation.item.create', 'response.create']);
  assert.deepEqual(JSON.parse(context.sent.at(-2).item.output), { ok: true, added: true });
});

test('a duplicate word is not announced', async (t) => {
  const context = await connected({ apiResponses: { '/api/stack/words': { added: false, word: null } } });
  t.after(() => finishCall(context));
  await context.fire(toolDone('add_to_stack', { kana: 'げんき' }));
  assert.deepEqual(context.events.words, []);
});

test('a word saved while already speaking does not make the contact speak twice', async (t) => {
  const context = await connected({ apiResponses: { '/api/stack/words': { added: true, word: { id: 'w1' } } } });
  t.after(() => finishCall(context));
  const before = context.sent.filter((event) => event.type === 'response.create').length;
  await context.fire(toolDone('add_to_stack', { kana: 'げんき' }, [{ type: 'message' }]));
  assert.equal(context.sent.filter((event) => event.type === 'response.create').length, before);
});

test('after answering a language question, the contact goes back to the conversation as a new message', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire(toolDone('back_to_conversation', {}, [{ type: 'message' }]));
  const types = context.sent.map((event) => event.type);
  assert.deepEqual(types.slice(-2), ['conversation.item.create', 'response.create']);
  assert.deepEqual(JSON.parse(context.sent.at(-2).item.output), { ok: true });
});

test('a speed change mid-sentence waits for the turn to end', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  const update = { settings: { speed: 0.7 }, turnDetection: { silence_duration_ms: 2000 } };

  await context.fire({ type: 'response.created' });
  context.call.updateVoice(update);
  assert.ok(!context.sent.some((event) => event.type === 'session.update'));

  await context.fire({ type: 'response.done', response: { output: [] } });
  const sentUpdate = context.sent.find((event) => event.type === 'session.update');
  assert.equal(sentUpdate.session.audio.output.speed, 0.7);
  assert.equal(sentUpdate.session.audio.input.turn_detection.silence_duration_ms, 2000);

  context.sent.length = 0;
  context.call.updateVoice(update);
  assert.equal(context.sent[0].type, 'session.update');
});

test('a tool that fails tells the model, and the call carries on', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  const context = await connected();
  t.after(() => {
    console.warn = warn;
    finishCall(context);
  });
  await context.fire(toolDone('update_settings', { speedChange: 'slower' }));
  assert.deepEqual(JSON.parse(context.sent.at(-2).item.output), { ok: false });
  assert.deepEqual(context.events.ended, []);
});

test('the speaker switch reports when the phone does not allow it', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  assert.equal(await context.call.setSpeaker(true), false);

  const sinks = [];
  context.audio.setSinkId = async (id) => sinks.push(id);
  assert.equal(await context.call.setSpeaker(true), true);
  assert.equal(await context.call.setSpeaker(false), true);
  assert.deepEqual(sinks, ['loud', 'default']);
});

test('ending a call sends its timing numbers', async () => {
  const context = await connected();
  await context.fire({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 4000 });
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  context.call.hangUp();
  await context.settle();
  const sent = context.events.apiCalls.find((call) => call.path === '/api/calls/c1/metrics');
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.body.replyLatencyCount, 1);
  assert.equal(sent.options.body.userTurns, 1);
  assert.equal(sent.options.body.agentTurns, 1);
  assert.ok(Object.values(sent.options.body).every((value) => value === null || typeof value === 'number'));
  assert.deepEqual(context.events.ended, ['hung-up']);
});

test('a failure sending the numbers never stops the call from ending', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const context = await connected({ failPaths: ['/api/calls/c1/metrics'] });
    context.call.hangUp();
    await context.settle();
    assert.deepEqual(context.events.ended, ['hung-up']);
  } finally {
    console.warn = warn;
  }
});

const replies = (context) => context.sent.filter((event) => event.type === 'response.create');
const systemNotes = (context) => context.sent.filter((event) => event.type === 'conversation.item.create' && event.item.role === 'system');

// Ping is speaking, then the user talks over it, and OpenAI cuts the audio, as it does over WebRTC.
async function talkOverPing(context, itemId) {
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  await context.fire({ type: 'input_audio_buffer.speech_started', item_id: itemId });
  await context.fire({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
}

test('a normal turn gets a reply as soon as it ends', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  const before = replies(context).length;
  await context.fire({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.equal(replies(context).length, before + 1);
  assert.deepEqual(systemNotes(context), []);
});

test('aizuchi over Ping makes it carry on instead of answering, and is counted', async () => {
  const context = await connected();
  await talkOverPing(context, 'u1');
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  const before = replies(context).length;
  await context.fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'うん。' });
  assert.equal(replies(context).length, before + 1);
  assert.match(systemNotes(context)[0].item.content[0].text, /Carry on from the exact point/);
  const order = context.sent.map((event) => event.type).slice(-2);
  assert.deepEqual(order, ['conversation.item.create', 'response.create']);

  context.call.hangUp();
  await context.settle();
  const metrics = context.events.apiCalls.find((call) => call.path === '/api/calls/c1/metrics').options.body;
  assert.equal(metrics.ignoredAizuchi, 1);
  assert.equal(metrics.bargeIns, 0);
});

test('a real sentence over Ping gets a normal reply once its words arrive', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await talkOverPing(context, 'u1');
  const before = replies(context).length;
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.equal(replies(context).length, before, 'waits for the words first');
  await context.fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'いや、それは早すぎ。' });
  assert.equal(replies(context).length, before + 1);
  assert.deepEqual(systemNotes(context), []);
});

test('if the words never arrive, the turn still gets a normal reply', async (t) => {
  // Fake timers from the start, so the call's own timers are fake too and stop when it ends.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = await connected();
  t.after(() => finishCall(context));
  await talkOverPing(context, 'u1');
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  const before = replies(context).length;
  t.mock.timers.tick(1499);
  assert.equal(replies(context).length, before);
  t.mock.timers.tick(1);
  assert.equal(replies(context).length, before + 1);
  assert.deepEqual(systemNotes(context), []);
});

test('a failed transcription gets a normal reply without waiting', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await talkOverPing(context, 'u1');
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  const before = replies(context).length;
  await context.fire({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'u1', error: { code: 'audio_unintelligible' } });
  assert.equal(replies(context).length, before + 1);
});

test('a turn that ends while a reply is still being written waits for it to finish', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire({ type: 'response.created' });
  const before = replies(context).length;
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.equal(replies(context).length, before);
  await context.fire({ type: 'response.done', response: { output: [] } });
  assert.equal(replies(context).length, before + 1);
});

test('after aizuchi, the note gives back the reply OpenAI cut short', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'お寿司、いいですね！' });
  await context.fire({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'どんなネタが好きですか？' });
  await talkOverPing(context, 'u1');
  await context.fire({ type: 'conversation.item.truncated', item_id: 'a1', content_index: 0, audio_end_ms: 900 });
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  await context.fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'はい' });
  assert.match(systemNotes(context).at(-1).item.content[0].text, /「お寿司、いいですね！どんなネタが好きですか？」/);
});

test('the call records OpenAI audio times and turn settings for the hidden-wait estimate', async () => {
  const context = await connected();
  await context.fire({ type: 'session.created', session: { audio: { input: { turn_detection: { type: 'server_vad', silence_duration_ms: 1300, prefix_padding_ms: 300 } } } } });
  await context.fire({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: 1000 });
  await context.fire({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 3000 });
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  context.call.hangUp();
  await context.settle();
  const metrics = context.events.apiCalls.find((call) => call.path === '/api/calls/c1/metrics').options.body;
  // The events arrive almost at once here, so this only checks the estimate is made and sent.
  assert.equal(typeof metrics.turnEndWaitMedianMs, 'number');
  assert.equal(typeof metrics.replyGapMedianMs, 'number');
});

// ---------- Smart Turn mode ----------

const SILENCE = { type: 'server_vad', silence_duration_ms: 1300, create_response: false, interrupt_response: true };

// A stand-in for the models and microphone: the test plays Smart Turn's part by calling `hear`.
function fakeSmartTurn({ loadFails = false } = {}) {
  const fake = { stopped: false, inTurn: false, hear: null };
  fake.engine = {
    load: async () => {
      if (loadFails) throw new Error('offline');
      return { loadMs: 2500 };
    },
    start: async ({ onEvent }) => {
      fake.hear = onEvent;
      return {
        stop: () => (fake.stopped = true),
        get inTurn() {
          return fake.inTurn;
        },
      };
    },
  };
  return fake;
}

async function smartTurnCall(options = {}) {
  const fake = fakeSmartTurn(options);
  const context = await connected({ session: { turnMode: 'smartTurn' }, smartTurnEngine: fake.engine });
  await context.fire({ type: 'session.created', session: { audio: { input: { turn_detection: SILENCE } } } });
  return { ...context, fake };
}

const detectionUpdates = (context) =>
  context.sent.filter((event) => event.type === 'session.update' && 'turn_detection' in (event.session.audio?.input ?? {})).map((event) => event.session.audio.input.turn_detection);
const sentTypes = (context) => context.sent.map((event) => event.type);
const metricsOf = (context) => context.events.apiCalls.find((call) => call.path === '/api/calls/c1/metrics').options.body;

test("once Smart Turn is ready, OpenAI's detection goes off and the phone ends each turn", async (t) => {
  const context = await smartTurnCall();
  t.after(() => finishCall(context));
  await context.answer();
  assert.deepEqual(detectionUpdates(context), [null]);
  assert.ok(sentTypes(context).includes('input_audio_buffer.clear'), 'audio from before the switch is dropped');

  context.fake.hear({ type: 'speech-start', at: 1000 });
  context.fake.hear({ type: 'end-turn', reason: 'smartTurn', at: 3430, quietSince: 3000 });
  assert.equal(sentTypes(context).at(-1), 'input_audio_buffer.commit');
  const before = replies(context).length;
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.equal(replies(context).length, before + 1, 'one reply, through the usual path');
});

test('in Smart Turn mode, talking over Ping stops it, and うん still makes it carry on', async () => {
  const context = await smartTurnCall();
  await context.answer();
  await context.fire({ type: 'response.created' });
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  context.fake.hear({ type: 'speech-start', at: 5000 });
  assert.deepEqual(sentTypes(context).slice(-2), ['response.cancel', 'output_audio_buffer.clear']);
  await context.fire({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  await context.fire({ type: 'response.done' });

  context.fake.hear({ type: 'end-turn', reason: 'smartTurn', at: 5600, quietSince: 5300 });
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  const before = replies(context).length;
  await context.fire({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'うん' });
  assert.equal(replies(context).length, before + 1);
  assert.match(systemNotes(context)[0].item.content[0].text, /Carry on from the exact point/);

  context.call.hangUp();
  await context.settle();
  assert.equal(context.fake.stopped, true);
  const metrics = metricsOf(context);
  assert.deepEqual([metrics.ignoredAizuchi, metrics.smartTurnEnds, metrics.modelLoadMs], [1, 1, 2500]);
  assert.deepEqual(cleanMetrics(metrics), metrics, 'the server accepts them');
});

test('a reply already fully written is silenced, not cancelled, when the user talks over it', async (t) => {
  const context = await smartTurnCall();
  t.after(() => finishCall(context));
  await context.answer();
  await context.fire({ type: 'response.created' });
  await context.fire({ type: 'response.done' });
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  const sentBefore = context.sent.length;
  context.fake.hear({ type: 'speech-start', at: 5000 });
  assert.deepEqual(sentTypes(context).slice(sentBefore), ['output_audio_buffer.clear']);
});

test("a settings change keeps OpenAI's detection off, and a fallback restores the newest silence settings", async () => {
  const context = await smartTurnCall();
  await context.answer();
  const longer = { ...SILENCE, silence_duration_ms: 2500 };
  context.call.updateVoice({ settings: { speed: 1 }, turnDetection: longer });
  assert.deepEqual(detectionUpdates(context), [null, null]);

  context.fake.hear({ type: 'fallback', reason: 'slow' });
  assert.deepEqual(detectionUpdates(context), [null, null, longer]);
  assert.equal(context.fake.stopped, true);
  context.fake.hear({ type: 'end-turn', reason: 'smartTurn', at: 1, quietSince: 0 });
  assert.notEqual(sentTypes(context).at(-1), 'input_audio_buffer.commit', 'Smart Turn no longer ends turns');

  context.call.hangUp();
  await context.settle();
  assert.equal(metricsOf(context).smartTurnFallback, 2, 'too slow');
});

test('if Smart Turn cannot load, the call simply stays in silence mode', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const context = await smartTurnCall({ loadFails: true });
    await context.answer();
    assert.deepEqual(detectionUpdates(context), []);
    context.call.hangUp();
    await context.settle();
    assert.equal(metricsOf(context).smartTurnFallback, 1, 'could not load');
  } finally {
    console.warn = warn;
  }
});

test("Smart Turn waits for a turn OpenAI is already hearing to end before taking over", async (t) => {
  const context = await smartTurnCall();
  t.after(() => finishCall(context));
  await context.fire({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  await context.answer();
  assert.deepEqual(detectionUpdates(context), []);
  await context.fire({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  assert.deepEqual(detectionUpdates(context), [null]);
});

test('other modes never load Smart Turn', async (t) => {
  const fake = fakeSmartTurn();
  let loaded = false;
  fake.engine.load = async () => {
    loaded = true;
    return { loadMs: 1 };
  };
  const context = await connected({ smartTurnEngine: fake.engine });
  t.after(() => finishCall(context));
  await context.answer();
  assert.equal(loaded, false);
});

// ---------- showing the contact's words as they're said ----------

test('the screen hears when each line starts being said and when it finishes, even if the voice comes first', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire({ type: 'response.output_audio_transcript.delta', response_id: 'r1', item_id: 'ai1', delta: 'もしもし' });
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r1' });
  await context.fire({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  // The next reply's voice starts before its first words arrive.
  await context.fire({ type: 'output_audio_buffer.started', response_id: 'r2' });
  assert.deepEqual(context.events.audio, ['start ai1', 'end ai1']);
  await context.fire({ type: 'response.output_audio_transcript.delta', response_id: 'r2', item_id: 'ai2', delta: '今日は' });
  await context.fire({ type: 'response.output_audio_transcript.delta', response_id: 'r2', item_id: 'ai2', delta: '何を' });
  assert.deepEqual(context.events.audio, ['start ai1', 'end ai1', 'start ai2']);
});

test('when the user cuts the contact off, the screen hears it, then exactly how much was heard', async (t) => {
  const context = await connected();
  t.after(() => finishCall(context));
  await context.fire({ type: 'response.output_audio_transcript.delta', response_id: 'r1', item_id: 'ai1', delta: 'そうなんだ。今日は何を食べた？' });
  await talkOverPing(context, 'u1');
  await context.fire({ type: 'conversation.item.truncated', item_id: 'ai1', audio_end_ms: 1980 });
  assert.deepEqual(context.events.audio.slice(-2), ['cut ai1', 'heard ai1 1980']);
});
