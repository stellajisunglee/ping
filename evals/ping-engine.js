// Plays one scenario against Ping's real instructions and tools on OpenAI's Realtime model, in text.
// The learner's lines go in as text instead of audio, so this tests what Ping says and does, not
// turn-taking timing (bench/ covers that). Tools are simulated the way the app answers them.

import { applySettings, DEFAULT_SETTINGS } from '../server/settings.js';
import { buildSession, questionById } from '../server/tutor.js';
import { PING } from '../server/contacts.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const RESPONSE_TIMEOUT_MS = 45_000;
const MAX_REPLIES_PER_TURN = 4; // Ping can call a tool and then speak; this stops a runaway loop
// A fixed day and hour, so Ping's own day (server/persona.js) is the same on every run.
const LOCAL_DATE = { year: 2026, month: 11, day: 15 };
const LOCAL_HOUR = 15;

// The session the app would mint for this scenario, switched to text.
export function scenarioSession(scenario, model) {
  const settings = { ...DEFAULT_SETTINGS, ...scenario.settings };
  const { instructions, tools, tool_choice: toolChoice, max_output_tokens: maxOutputTokens } = buildSession({
    model,
    voice: 'marin',
    question: questionById(scenario.question),
    settings,
    localHour: LOCAL_HOUR,
    localDate: LOCAL_DATE,
    // Calls the learner starts go straight to the question. "incoming" scenarios test Ping calling,
    // where it first asks if it's a good time.
    calledBack: !scenario.incoming,
    contact: PING,
    memories: [],
    turnMode: 'silence',
  });
  return { settings, session: { type: 'realtime', instructions, tools, tool_choice: toolChoice, max_output_tokens: maxOutputTokens, output_modalities: ['text'] } };
}

// What the phone answers for each tool. Saving a word always works here.
function simulateTool(call, state) {
  const args = JSON.parse(call.arguments || '{}');
  if (call.name === 'add_to_stack') return { ok: true, added: true, alreadySaved: false };
  if (call.name === 'update_settings') {
    state.settings = applySettings(state.settings, args);
    return { ok: true, settings: state.settings };
  }
  return { ok: true };
}

const textOf = (item) =>
  (item.content ?? [])
    .map((part) => part.text ?? part.transcript ?? '')
    .join('')
    .trim();

// One transcript line per message Ping sent, with the reply's tool calls on its last line.
function linesFrom(items, turn) {
  const tools = items.filter((item) => item.type === 'function_call').map((call) => ({ name: call.name, args: JSON.parse(call.arguments || '{}') }));
  const lines = items.filter((item) => item.type === 'message').map((item) => ({ turn, from: 'ping', text: textOf(item), tools: [] }));
  if (!lines.length) lines.push({ turn, from: 'ping', text: '', tools: [] });
  lines.at(-1).tools = tools;
  return lines;
}

export async function runScenario(scenario, { apiKey, model = 'gpt-realtime', WebSocketClass = globalThis.WebSocket }) {
  const { settings, session } = scenarioSession(scenario, model);
  const state = { settings };
  const transcript = [];
  const socket = new WebSocketClass(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` } });

  // Events arrive in order; this waits for the next one of a given type.
  const waiting = [];
  const backlog = [];
  let failure = null;
  socket.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'error') failure = new Error(`${event.error?.code ?? 'error'}: ${event.error?.message ?? ''}`);
    const index = waiting.findIndex((waiter) => waiter.types.includes(event.type) || event.type === 'error');
    if (index >= 0) waiting.splice(index, 1)[0].resolve(event);
    else backlog.push(event);
  };
  const next = (...types) =>
    new Promise((resolve, reject) => {
      const found = backlog.findIndex((event) => types.includes(event.type) || event.type === 'error');
      if (found >= 0) return resolve(backlog.splice(found, 1)[0]);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${types.join(' or ')}`)), RESPONSE_TIMEOUT_MS);
      waiting.push({ types, resolve: (event) => (clearTimeout(timer), resolve(event)) });
    });
  const send = (event) => socket.send(JSON.stringify(event));
  const checkFailure = (event) => {
    if (event.type === 'error' || failure) throw failure ?? new Error('error');
  };

  // One reply, plus any follow-ups after its tool calls. Returns true when Ping ended the call.
  async function reply(turn) {
    for (let count = 0; count < MAX_REPLIES_PER_TURN; count += 1) {
      send({ type: 'response.create' });
      const done = await next('response.done');
      checkFailure(done);
      const items = done.response?.output ?? [];
      const calls = items.filter((item) => item.type === 'function_call');
      transcript.push(...linesFrom(items, turn));
      if (calls.some((call) => call.name === 'end_call')) return true;
      if (!calls.length) return false;
      for (const call of calls) {
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(simulateTool(call, state)) } });
      }
      // Same rule as the app: a word saved while Ping already explained it needs no second reply.
      if (items.some((item) => item.type === 'message') && calls.every((call) => call.name === 'add_to_stack')) return false;
    }
    return false;
  }

  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('could not connect to OpenAI'));
    });
    checkFailure(await next('session.created'));
    send({ type: 'session.update', session });
    checkFailure(await next('session.updated'));

    let ended = await reply(0); // Ping speaks first
    for (const [index, line] of (scenario.turns ?? []).entries()) {
      if (ended) break;
      transcript.push({ turn: index + 1, from: 'learner', text: line, tools: [] });
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } });
      ended = await reply(index + 1);
    }
    return { transcript, settings: state.settings, error: null };
  } catch (error) {
    return { transcript, settings: state.settings, error: error.message };
  } finally {
    socket.close();
  }
}
