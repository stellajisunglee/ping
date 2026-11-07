import test from 'node:test';
import assert from 'node:assert/strict';
import { startCall } from '../public/voice.js';

// A stand-in for the browser's WebRTC, so the call's event handling runs without a real connection.
function setupCall({ apiResponses = {}, failPaths = [] } = {}) {
  const sent = [];
  const channel = {
    readyState: 'open',
    send: (event) => sent.push(JSON.parse(event)),
    close() {},
  };
  globalThis.RTCPeerConnection = class {
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

  const events = { lines: [], words: [], ended: [], settings: [], apiCalls: [] };
  const audio = { play: async () => {}, srcObject: null };
  const call = startCall({
    callId: 'c1',
    audio,
    api: async (path, options) => {
      events.apiCalls.push({ path, options });
      if (failPaths.includes(path)) throw new Error('offline');
      if (path.endsWith('/session')) return { clientSecret: 'ek', sdpUrl: 'https://voice.test', maxSeconds: 180 };
      return apiResponses[path];
    },
    onStatus: () => {},
    onLine: (line) => events.lines.push(line),
    onWordAdded: (word) => events.words.push(word),
    onSpeaking: () => {},
    onSettings: (settings) => events.settings.push(settings),
    onEnded: (reason) => events.ended.push(reason),
    onNeedsTap: () => {},
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async (event) => {
    channel.onmessage({ data: JSON.stringify(event) });
    await settle();
  };
  return { call, sent, events, fire, settle, channel, audio };
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
