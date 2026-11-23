// ElevenLabs Agents: a cascaded engine (ElevenLabs hears, an LLM thinks, an ElevenLabs voice speaks) with its own
// turn-taking model, so these calls have no turn mode. One Ping agent is set up once (scripts/setup-elevenlabs.js);
// each call gets a signed WebSocket URL from Ping's server (valid 15 minutes) and overrides the agent's prompt, first
// message, language and speed. The audio goes straight between the phone and ElevenLabs.
// Field names from elevenlabs.io/docs (get-signed-url, personalization overrides, agent WebSocket).

import { buildInstructions, openingWords } from './tutor.js';

const API = 'https://api.elevenlabs.io/v1';
// ElevenLabs' voice speed range, which Ping's speed (0.6-1.5) is squeezed into.
export const elevenSpeed = (speed = 1) => Math.round(Math.min(1.2, Math.max(0.7, speed)) * 100) / 100;

// What the phone sends first on the socket (conversation_initiation_client_data) to make the agent Ping for this call.
export function elevenOverrides({ question, settings, localHour, localDate, calledBack, contact, memories = [], learnerName = null, comebackWords = [] }) {
  return {
    agent: {
      prompt: { prompt: buildInstructions({ question, localHour, localDate, calledBack, contact, settings, memories, learnerName, comebackWords }) },
      first_message: openingWords({ question, contact, formality: settings.formality, calledBack, localHour, learnerName }),
      language: 'ja',
    },
    tts: { speed: elevenSpeed(settings.speed) },
  };
}

export function createElevenLabs({ apiKey, agentId, fetchImpl = fetch }) {
  return {
    hasKey: Boolean(apiKey && agentId),
    // A one-use signed URL for this call's WebSocket, so the key never reaches the phone.
    async signedUrl() {
      const response = await fetchImpl(`${API}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}&include_conversation_id=true`, { headers: { 'xi-api-key': apiKey } });
      if (!response.ok) throw new Error(`ElevenLabs refused the call (${response.status}): ${await response.text()}`);
      const { signed_url: url } = await response.json();
      if (!url) throw new Error('ElevenLabs sent no signed URL');
      return url;
    },
  };
}
