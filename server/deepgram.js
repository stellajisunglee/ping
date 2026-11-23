// Deepgram's Voice Agent, a cascaded engine: Flux hears the learner and decides when their turn is over,
// an OpenAI model (run by Deepgram) writes the reply, and a Japanese Flux voice speaks it.
// Like OpenAI, the phone connects straight to Deepgram with a short-lived token, so audio never
// passes through Ping's server. See docs/deepgram-friction-log.md for what building on it was like.

import { buildInstructions, openingWords, TOOLS } from './tutor.js';

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
export const AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const TOKEN_SECONDS = 30; // only needs to be valid when the phone connects

// How patient Flux is before ending the learner's turn, by "time to answer". eot_threshold is how sure
// Flux must be that they've finished (0.5 to 1.0, Deepgram's default 0.7); eot_timeout_ms is the silence
// that ends the turn anyway. On the benchmark, Flux at 0.85 and 8 s cut off 17% of thinking pauses.
export const FLUX_PATIENCE = {
  short: { eot_threshold: 0.7, eot_timeout_ms: 3000 },
  normal: { eot_threshold: 0.8, eot_timeout_ms: 4000 },
  long: { eot_threshold: 0.9, eot_timeout_ms: 6000 },
};

// Flux voices take 0.5 to 1.5, in steps of 0.05. The Aura-2 Japanese voices reject speed entirely.
const voiceSpeed = (speed) => Math.min(1.5, Math.max(0.5, Math.round(Number(speed || 1) * 20) / 20));

// Japanese, with English hinted too, since learners switch to English when stuck.
export const agentListen = (settings) => ({
  provider: { type: 'deepgram', version: 'v2', model: 'flux-general-multi', language_hints: ['ja', 'en'], ...(FLUX_PATIENCE[settings.thinkingTime] ?? FLUX_PATIENCE.normal) },
});

export const agentSpeak = (settings, voice) => ({ provider: { type: 'deepgram', version: 'v2', model: voice, speed: voiceSpeed(settings.speed) } });

// The Settings message the phone sends when it connects: Ping's own instructions, persona and tools.
export function agentSettings({ question, settings, localHour, localDate, calledBack, contact, memories = [], thinkModel, voice, learnerName = null, comebackWords = [] }) {
  const greeting = openingWords({ question, contact, formality: settings.formality, calledBack, localHour, learnerName });
  const instructions = buildInstructions({ question, localHour, localDate, calledBack, contact, settings, memories, learnerName, comebackWords });
  return {
    type: 'Settings',
    experimental: true, // so AgentStartedSpeaking reports how long thinking and speaking took
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      listen: agentListen(settings),
      think: {
        provider: { type: 'open_ai', model: thinkModel },
        // Deepgram speaks the greeting itself, so the model is told it's already been said.
        prompt: `${instructions}\n\nYour opening line has already been said: 「${greeting}」 Don't say it again.`,
        functions: TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })),
      },
      speak: agentSpeak(settings, voice),
      greeting,
    },
  };
}

export function createDeepgram({ apiKey, fetchImpl = fetch }) {
  return {
    hasKey: Boolean(apiKey),
    // A token that lets one phone open one agent connection. The key needs Deepgram's Member role or higher.
    async mintToken() {
      const response = await fetchImpl(GRANT_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: TOKEN_SECONDS }),
      });
      if (!response.ok) throw new Error(`Deepgram refused a call token (${response.status})`);
      const { access_token: token } = await response.json();
      if (!token) throw new Error('Deepgram sent no call token');
      return token;
    },
  };
}
