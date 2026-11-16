import test from 'node:test';
import assert from 'node:assert/strict';
import { agentListen, agentSettings, agentSpeak, createDeepgram, FLUX_PATIENCE } from '../server/deepgram.js';
import { startDeepgramCall, toPcm16 } from '../public/deepgram-call.js';
import { questionById, TOOLS } from '../server/tutor.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { PING } from '../server/contacts.js';

const details = (change = {}) => ({
  question: questionById('weekend'),
  settings: { ...DEFAULT_SETTINGS, ...change },
  localHour: 15,
  localDate: { year: 2026, month: 11, day: 15 },
  calledBack: true,
  contact: PING,
  memories: [],
  thinkModel: 'gpt-4.1-mini',
  voice: 'flux-ayumi-ja',
});

test("the agent settings carry Ping's instructions, tools, greeting and the learner's settings", () => {
  const settings = agentSettings(details());
  assert.equal(settings.type, 'Settings');
  assert.equal(settings.agent.greeting, 'もしもし、ピンです！折り返してくれて、ありがとうございます！週末は何をしますか？');
  assert.match(settings.agent.think.prompt, /Your opening line has already been said/);
  assert.deepEqual(settings.agent.think.provider, { type: 'open_ai', model: 'gpt-4.1-mini' });
  assert.deepEqual(settings.agent.think.functions.map((fn) => fn.name), TOOLS.map((tool) => tool.name));
  assert.ok(settings.agent.think.functions.every((fn) => !('type' in fn)), 'Deepgram functions have no OpenAI "type" field');
  assert.deepEqual(settings.agent.listen.provider, { type: 'deepgram', version: 'v2', model: 'flux-general-multi', language_hints: ['ja', 'en'], ...FLUX_PATIENCE.normal });
  assert.deepEqual(settings.agent.speak.provider, { type: 'deepgram', version: 'v2', model: 'flux-ayumi-ja', speed: 1 });
  assert.deepEqual(settings.audio.input, { encoding: 'linear16', sample_rate: 16000 });
  assert.ok(settings.agent.think.prompt.length < 25_000, "under Deepgram's prompt limit");
});

test('a call Ping makes asks if it is a good time first, and casual speech is used when set', () => {
  const incoming = agentSettings({ ...details({ formality: 'casual' }), calledBack: false });
  assert.equal(incoming.agent.greeting, 'もしもし、ピンだよ！こんにちは！今、話せる？');
});

test('time to answer sets Flux patience, and speed is kept to what the voice accepts', () => {
  assert.equal(agentListen({ thinkingTime: 'long' }).provider.eot_threshold, 0.9);
  assert.equal(agentListen({ thinkingTime: 'short' }).provider.eot_timeout_ms, 3000);
  assert.equal(agentSpeak({ speed: 0.6 }, 'v').provider.speed, 0.6);
  assert.equal(agentSpeak({ speed: 0.3 }, 'v').provider.speed, 0.5);
  assert.equal(agentSpeak({ speed: 0.87 }, 'v').provider.speed, 0.85);
});

test('a call token comes from Deepgram, and a refusal says so', async () => {
  const calls = [];
  const ok = createDeepgram({ apiKey: 'key', fetchImpl: async (url, options) => (calls.push({ url, options }), { ok: true, json: async () => ({ access_token: 'jwt', expires_in: 30 }) }) });
  assert.equal(await ok.mintToken(), 'jwt');
  assert.equal(calls[0].options.headers.Authorization, 'Token key');
  assert.equal(JSON.parse(calls[0].options.body).ttl_seconds, 30);
  const refused = createDeepgram({ apiKey: 'key', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(refused.mintToken(), /403/);
  assert.equal(createDeepgram({ apiKey: '' }).hasKey, false);
});

test('microphone audio becomes 16-bit samples', () => {
  assert.deepEqual([...toPcm16(new Float32Array([0, 1, -1, 2]))], [0, 32767, -32768, 32767]);
});

// ---------- the call on the phone, with stand-ins for the socket and audio ----------

function harness({ session = {} } = {}) {
  const sent = [];
  const events = [];
  const apiCalls = [];
  let socket;
  class FakeSocket {
    constructor(url, protocols) {
      socket = this;
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1;
    }
    send(message) {
      sent.push(typeof message === 'string' ? JSON.parse(message) : message);
    }
    close() {
      this.readyState = 3;
    }
  }
  const player = { played: 0, stopped: 0, remainingSeconds: 0, stream: { id: 'playback' } };
  const mic = {};
  Object.assign(player, {
    play: () => (player.played += 1),
    stop: () => (player.stopped += 1),
    remaining: () => player.remainingSeconds,
    resume: () => {},
    close: () => {},
  });
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const microphone = { getTracks: () => [track], getAudioTracks: () => [track] };
  const api = async (path, options = {}) => {
    apiCalls.push({ path, options });
    if (path === '/api/settings') return { settings: { speed: 0.85 }, agent: { speak: { provider: { speed: 0.85 } }, listen: { provider: { eot_threshold: 0.9 } } } };
    if (path === '/api/stack/words') return { added: true, word: options.body };
    return {};
  };
  const call = startDeepgramCall({
    callId: 'call-1',
    api,
    audio: { play: async () => {} },
    session: { agentUrl: 'wss://agent.example', token: 'jwt', settings: { type: 'Settings' }, maxSeconds: 180, hangUpLines: [], timeUpLine: 'じかん', ...session },
    microphone,
    onStatus: (status) => events.push(['status', status]),
    onLine: (line) => events.push(['line', line.from, line.text ?? line.delta]),
    onWordAdded: (word) => events.push(['word', word.kanji]),
    onSpeaking: (on) => events.push(['speaking', on]),
    onSettings: (settings) => events.push(['settings', settings.speed]),
    onEnded: (reason) => events.push(['ended', reason]),
    onNeedsTap: () => events.push(['tap']),
    onContactAudio: (audio) => events.push(['voice', audio.type, audio.itemId]),
    WebSocketClass: FakeSocket,
    makePlayer: () => player,
    makeMicrophoneStream: async ({ onAudio }) => {
      mic.onAudio = onAudio;
      return { close: () => {} };
    },
    now: () => 1000,
  });
  const receive = (message) => socket.onmessage({ data: typeof message === 'string' || message instanceof ArrayBuffer ? message : JSON.stringify(message) });
  return { call, sent, events, apiCalls, player, track, receive, mic, socket: () => socket };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the phone connects with the token, sends the settings, and shows each line as its voice plays', async () => {
  const { sent, events, receive, socket, player, call, mic } = harness();
  assert.deepEqual(socket().protocols, ['bearer', 'jwt']);
  receive({ type: 'Welcome' });
  assert.deepEqual(sent[0], { type: 'Settings' });
  receive({ type: 'SettingsApplied' });
  assert.deepEqual(events.at(-1), ['status', 'connected']);
  await tick();
  const audio = toPcm16(new Float32Array([0.5, -0.5])).buffer;
  mic.onAudio(audio);
  assert.equal(sent.at(-1), audio, 'microphone audio goes to Deepgram as raw binary, not JSON');
  receive({ type: 'ConversationText', role: 'assistant', content: 'もしもし！' });
  receive(new ArrayBuffer(4));
  assert.equal(player.played, 1);
  receive({ type: 'AgentAudioDone' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  receive({ type: 'UserStartedSpeaking' });
  receive({ type: 'EndOfTurn' });
  receive({ type: 'ConversationText', role: 'user', content: '映画を見ました。' });
  assert.deepEqual(
    events.filter(([kind]) => ['line', 'voice', 'speaking'].includes(kind)),
    [
      ['line', 'contact', 'もしもし！'],
      ['speaking', true],
      ['voice', 'start', 'deepgram-contact-1'],
      ['voice', 'end', 'deepgram-contact-1'],
      ['speaking', false],
      ['line', 'you', '映画を見ました。'],
    ],
  );
  call.hangUp();
  assert.deepEqual(events.at(-1), ['ended', 'hung-up']);
});

test('the learner talking over the contact cuts its voice, and the rest of that reply is skipped', () => {
  const { events, receive, player, call } = harness();
  receive({ type: 'Welcome' });
  receive({ type: 'SettingsApplied' });
  receive({ type: 'ConversationText', role: 'assistant', content: '週末は何をしますか？' });
  receive(new ArrayBuffer(4));
  receive({ type: 'UserStartedSpeaking' });
  assert.equal(player.stopped, 1);
  assert.deepEqual(events.slice(-2), [['voice', 'cut', 'deepgram-contact-1'], ['speaking', false]]);
  receive(new ArrayBuffer(4)); // the tail of the reply that was cut
  assert.equal(player.played, 1);
  receive({ type: 'ConversationText', role: 'assistant', content: 'なるほど！' });
  receive(new ArrayBuffer(4));
  assert.equal(player.played, 2);
  call.hangUp();
});

test('tools run like on OpenAI: words are saved, settings change the voice, and end_call hangs up after the goodbye', async () => {
  const { sent, events, receive, apiCalls } = harness();
  receive({ type: 'Welcome' });
  receive({ type: 'SettingsApplied' });
  receive({ type: 'FunctionCallRequest', functions: [{ id: 'f1', name: 'add_to_stack', arguments: '{"kanji":"予定"}', client_side: true }] });
  receive({ type: 'FunctionCallRequest', functions: [{ id: 'f2', name: 'update_settings', arguments: '{"speedChange":"slower"}', client_side: true }] });
  await tick();
  await tick();
  assert.deepEqual(events.find(([kind]) => kind === 'word'), ['word', '予定']);
  assert.deepEqual(apiCalls.map((call) => call.path), ['/api/stack/words', '/api/settings']);
  const responses = sent.filter((message) => message.type === 'FunctionCallResponse');
  assert.deepEqual(responses.map((response) => [response.id, response.name, JSON.parse(response.content).ok]), [['f1', 'add_to_stack', true], ['f2', 'update_settings', true]]);
  assert.deepEqual(sent.find((message) => message.type === 'UpdateSpeak').speak, { provider: { speed: 0.85 } });
  assert.deepEqual(sent.find((message) => message.type === 'UpdateListen').listen, { provider: { eot_threshold: 0.9 } });

  receive({ type: 'ConversationText', role: 'assistant', content: 'またね！' });
  receive(new ArrayBuffer(4));
  receive({ type: 'FunctionCallRequest', functions: [{ id: 'f3', name: 'end_call', arguments: '{}', client_side: true }] });
  await tick();
  receive({ type: 'AgentAudioDone' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(events.at(-1), ['ended', 'finished']);
});

test('a Deepgram error ends the call, and timing numbers are sent when it ends', async () => {
  const { events, receive, apiCalls, track } = harness();
  receive({ type: 'Welcome' });
  receive({ type: 'SettingsApplied' });
  receive({ type: 'Error', code: 'FAILED_TO_SPEAK', description: 'bad voice' });
  assert.deepEqual(events.at(-1), ['ended', 'failed']);
  assert.equal(track.stopped, true);
  await tick();
  assert.ok(apiCalls.some((call) => call.path === '/api/calls/call-1/metrics'));
});

test("a reply whose audio arrives before its words still starts on the new line, and each line ends once", async () => {
  const { events, receive, call } = harness();
  receive({ type: 'Welcome' });
  receive({ type: 'SettingsApplied' });
  receive({ type: 'ConversationText', role: 'assistant', content: 'もしもし！' });
  receive(new ArrayBuffer(4));
  receive({ type: 'AgentAudioDone' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  receive(new ArrayBuffer(4)); // the next reply's audio, before its words
  receive({ type: 'ConversationText', role: 'assistant', content: 'いいですね！' });
  const voice = events.filter(([kind]) => kind === 'voice');
  assert.deepEqual(voice, [
    ['voice', 'start', 'deepgram-contact-1'],
    ['voice', 'end', 'deepgram-contact-1'],
    ['voice', 'start', 'deepgram-contact-2'],
  ]);
  call.hangUp();
});
