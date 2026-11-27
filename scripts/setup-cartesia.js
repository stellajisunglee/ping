// Sets up the one Cartesia agent Ping uses: npm run setup-cartesia
//
// Needs CARTESIA_API_KEY in .env. CARTESIA_VOICE_ID picks the voice (default: Aiko, a Japanese voice) and
// CARTESIA_LLM the model (default gpt-4.1-mini, as Deepgram and ElevenLabs calls use).
// Creates Ping's four tools as client tools (the phone runs them) and an agent that speaks Japanese. Each call's
// instructions, first message and speed are set when Ping's server creates the call's session (server/cartesia.js),
// so the agent's own instructions are only a placeholder. Prints CARTESIA_AGENT_ID to put in .env and on Render.
// Running it again reuses the tools but makes another agent. Field names follow docs.cartesia.ai (create agent,
// create tool), checked against a live call on 2026-11-27. --dry-run prints the requests.

import { CARTESIA_VERSION, HANG_UP_TOOL } from '../server/cartesia.js';
import { TOOLS } from '../server/tutor.js';

const API = 'https://api.cartesia.ai';
const key = process.env.CARTESIA_API_KEY ?? '';
const voiceId = process.env.CARTESIA_VOICE_ID || '498e7f37-7fa3-4e2c-b8e2-8b6e9276f956'; // Aiko
const llm = process.env.CARTESIA_LLM || 'gpt-4.1-mini';
const dryRun = process.argv.includes('--dry-run');
const headers = { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' };

// Cartesia's tool parameters are plain JSON Schema, without additionalProperties.
const forCartesia = (schema) => {
  if (Array.isArray(schema)) return schema.map(forCartesia);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([name]) => name !== 'additionalProperties').map(([name, value]) => [name, forCartesia(value)]));
};

// Each tool runs straight away, with no filler speech before it, and the agent waits for the phone's answer.
// end_call is a name Cartesia keeps for its own tool, so Ping's is hang_up here (see server/cartesia.js).
export const toolRequests = () =>
  TOOLS.map(({ name, description, parameters }) => ({
    type: 'client',
    name: name === 'end_call' ? HANG_UP_TOOL : name,
    description,
    expects_response: true,
    pre_tool_speech: 'off',
    execution_mode: 'immediate',
    parameters: forCartesia(parameters),
  }));

export function agentRequest({ toolIds = [], voice = voiceId, model = llm } = {}) {
  return {
    name: 'Ping',
    config: {
      instructions: 'Ping, a Japanese conversation partner. The real instructions are set for each call.',
      initial_message: null, // set for each call
      model: { id: model },
      language: { primary: 'ja' },
      audio: { output: { voice_id: voice } },
      tools: toolIds.map((id) => ({ id })),
      // Cartesia's own end_call is off: it hangs up at once, often before the goodbye is said. Ping's hang_up waits.
      system_tools: { end_call: null },
    },
  };
}

async function request(method, path, body) {
  if (dryRun) {
    console.log(`${method} ${API}${path}\n${JSON.stringify(body, null, 2)}\n`);
    return {};
  }
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cartesia refused ${method} ${path} (${response.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

// Ping's tools already on the account, by name, so running the setup again doesn't make copies.
async function existingTools() {
  if (dryRun) return {};
  try {
    const listing = await request('GET', '/v1/agents/tools');
    const tools = Array.isArray(listing) ? listing : (listing.data ?? []);
    return Object.fromEntries(tools.map((tool) => [tool.name, tool.id]).filter(([name, id]) => name && id));
  } catch {
    return {};
  }
}

async function main() {
  if (!dryRun && !key) {
    console.error('Set CARTESIA_API_KEY in .env first.');
    process.exit(1);
  }
  const toolIds = [];
  const existing = await existingTools();
  for (const tool of toolRequests()) {
    if (existing[tool.name]) {
      toolIds.push(existing[tool.name]);
      console.log(`Using the existing tool ${tool.name}: ${existing[tool.name]}`);
      continue;
    }
    const created = await request('POST', '/v1/agents/tools', tool);
    toolIds.push(created.id);
    if (!dryRun) console.log(`Created tool ${tool.name}: ${created.id}`);
  }
  const agent = await request('POST', '/v1/agents', agentRequest({ toolIds }));
  if (dryRun) return;
  console.log(`\nCreated the Ping agent. Add this to .env and to Render's environment:\nCARTESIA_AGENT_ID=${agent.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
