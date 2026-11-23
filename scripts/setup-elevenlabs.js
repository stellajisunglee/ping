// Sets up the one ElevenLabs agent Ping uses: npm run setup-elevenlabs
//
// Needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (a Japanese voice from elevenlabs.io/app/voice-library) in .env.
// Creates Ping's four tools as client tools (the phone runs them) and an agent that: speaks Japanese, thinks with
// gpt-4.1-mini (as Deepgram calls do), uses ElevenLabs' turn_v3 turn-taking set to "patient" for learners, sends
// 24 kHz audio and takes 16 kHz audio (what Ping's phone code plays and records), lets each call override its prompt,
// first message, language and speed, needs a signed URL, and keeps no audio or transcripts at ElevenLabs.
// Prints ELEVENLABS_AGENT_ID to put in .env and on Render. Run it once; running it again makes another agent.
// Field names follow elevenlabs.io/docs (agents create, tools, overrides, privacy). The tools endpoint's exact body
// wasn't shown in the docs, so if ElevenLabs rejects it, the error is printed as is. --dry-run prints the requests.

import { TOOLS } from '../server/tutor.js';

const API = 'https://api.elevenlabs.io/v1';
const key = process.env.ELEVENLABS_API_KEY ?? '';
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '';
const llm = process.env.ELEVENLABS_LLM || 'gpt-4.1-mini';
const dryRun = process.argv.includes('--dry-run');

export const toolRequests = () =>
  TOOLS.map(({ name, description, parameters }) => ({ tool_config: { type: 'client', name, description, expects_response: true, parameters } }));

export function agentRequest({ toolIds = [], voice = voiceId, model = llm } = {}) {
  return {
    name: 'Ping',
    conversation_config: {
      agent: {
        language: 'ja',
        first_message: '', // set per call
        prompt: { prompt: 'Ping, a Japanese conversation partner. The real prompt is set for each call.', llm: model, tool_ids: toolIds },
      },
      tts: { model_id: 'eleven_v4_turbo', voice_id: voice, agent_output_audio_format: 'pcm_24000' },
      asr: { user_input_audio_format: 'pcm_16000' },
      turn: { turn_model: 'turn_v3', turn_eagerness: 'patient' },
      conversation: {
        max_duration_seconds: 600, // Platinum's longest call; Ping ends calls at the plan's limit itself
        client_events: ['conversation_initiation_metadata', 'audio', 'agent_response', 'user_transcript', 'interruption', 'client_tool_call', 'vad_score', 'ping'],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: { conversation_config_override: { agent: { first_message: true, language: true, prompt: { prompt: true } }, tts: { speed: true } } },
      privacy: { record_voice: false, retention_days: 0, delete_audio: true, delete_transcript_and_pii: true, zero_retention_mode: true },
    },
  };
}

async function post(path, body) {
  if (dryRun) {
    console.log(`POST ${API}${path}\n${JSON.stringify(body, null, 2)}\n`);
    return {};
  }
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`ElevenLabs refused POST ${path} (${response.status}): ${text}`);
  return JSON.parse(text);
}

async function main() {
  if (!dryRun && (!key || !voiceId)) {
    console.error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (a Japanese voice from the Voice Library) in .env first.');
    process.exit(1);
  }
  const toolIds = [];
  for (const request of toolRequests()) {
    const tool = await post('/convai/tools', request);
    toolIds.push(tool.id ?? tool.tool_id);
    if (!dryRun) console.log(`Created tool ${request.tool_config.name}: ${toolIds.at(-1)}`);
  }
  const agent = await post('/convai/agents/create', agentRequest({ toolIds }));
  if (dryRun) return;
  console.log(`\nCreated the Ping agent. Add this to .env and to Render's environment:\nELEVENLABS_AGENT_ID=${agent.agent_id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
