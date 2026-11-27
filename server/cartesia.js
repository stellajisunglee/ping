// Cartesia Managed Agents: a cascaded engine (Ink-2 hears and decides turns, an LLM thinks, a Sonic voice speaks), so
// these calls have no turn mode. One Ping agent is set up once (scripts/setup-cartesia.js). For each call, Ping's server
// creates a session that sets this call's instructions, first message, language and speed, and hands the phone the
// session's one-use token. The audio goes straight between the phone and Cartesia.
// Cartesia keeps every agent call (recording and transcript) with no setting to turn that off, so Ping deletes each
// call from Cartesia once it ends (deleteCall), and sweeps up any the phone never reported.
// Field names from docs.cartesia.ai (create a WebSocket session, agent WebSocket, delete call), checked against a
// live call on 2026-11-27.

import { buildInstructions, openingWords } from './tutor.js';

const API = 'https://api.cartesia.ai';
export const CARTESIA_VERSION = '2026-08-14';
// Cartesia keeps the name end_call for its own hang-up tool, which ends the call at once, often before any goodbye
// is said. So on Cartesia, Ping's end_call is called hang_up: the phone runs it and hangs up once the goodbye has
// played, as on the other engines. The instructions name it the same way.
export const HANG_UP_TOOL = 'hang_up';
const withCartesiaToolNames = (text) => text.replaceAll('end_call', HANG_UP_TOOL);
// Cartesia's voice speed range is the same as Ping's (0.6-1.5); this keeps a stray value inside it.
export const cartesiaSpeed = (speed = 1) => Math.round(Math.min(1.5, Math.max(0.6, speed)) * 100) / 100;

// This call's settings for the Ping agent: everything that changes from call to call.
export function cartesiaOverrides({ question, settings, localHour, localDate, calledBack, contact, memories = [], learnerName = null, comebackWords = [] }) {
  return {
    instructions: withCartesiaToolNames(buildInstructions({ question, localHour, localDate, calledBack, contact, settings, memories, learnerName, comebackWords })),
    initial_message: openingWords({ question, contact, formality: settings.formality, calledBack, localHour, learnerName }),
    language: { primary: 'ja' },
    audio: { output: { speed: cartesiaSpeed(settings.speed) } },
  };
}

// Where the phone connects: the session's WebSocket address with its one-use token and the API version.
export function socketUrl({ url, token }) {
  const address = new URL(url);
  address.searchParams.set('access_token', token);
  address.searchParams.set('cartesia_version', CARTESIA_VERSION);
  return address.toString();
}

export function createCartesia({ apiKey, agentId, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' };
  return {
    hasKey: Boolean(apiKey && agentId),
    agentId,
    // A session for one call. Its token is single use and must be used within four minutes.
    async startSession(overrides) {
      const response = await fetchImpl(`${API}/v1/agents/websocket/${encodeURIComponent(agentId)}/sessions`, { method: 'POST', headers, body: JSON.stringify({ config_overrides: overrides }) });
      if (!response.ok) throw new Error(`Cartesia refused the call (${response.status}): ${await response.text()}`);
      const { call_id: callId, url, token } = await response.json();
      if (!callId || !url || !token) throw new Error('Cartesia sent an incomplete session');
      return { callId, socketUrl: socketUrl({ url, token }) };
    },
    // Removes the call's recording and transcript from Cartesia. Returns true once it's gone (or was never there).
    // Cartesia refuses (400) while the call hasn't finished on its side yet; the next sweep tries again.
    async deleteCall(callId) {
      const response = await fetchImpl(`${API}/agents/calls/${encodeURIComponent(callId)}`, { method: 'DELETE', headers });
      if (response.ok || response.status === 404) return true;
      throw new Error(`Cartesia didn't delete call ${callId} (${response.status}): ${await response.text()}`);
    },
  };
}
