// OpenAI GPT-Live: a full-duplex voice model that listens while it speaks and decides for itself when to talk, so
// these calls have no turn mode. There's no browser key: the phone sends its WebRTC offer to Ping's server, which
// creates the session at POST /v1/live/sessions and hands back OpenAI's answer, so the audio still goes straight
// between the phone and OpenAI. Ping's tools run through a small "backend" model (delegation), because GPT-Live
// itself can't call functions. Field names from developers.openai.com/api/docs/guides/live and live-delegation.

import { buildInstructions, openingWords, TOOLS } from './tutor.js';

export const LIVE_MODEL = 'gpt-live-1.1';
export const LIVE_VOICE = 'harema'; // one of GPT-Live's two Japanese voices (feminine), like Ping
export const LIVE_BACKEND_MODEL = 'gpt-4.1-mini';

// GPT-Live can't call tools itself. Where Ping's rules say to call one, it asks the backend, which calls it.
const LIVE_NOTE = `TOOLS ON THIS CALL
You can't call tools yourself. Whenever these instructions say to call a tool (add_to_stack, update_settings, back_to_conversation or end_call), delegate to the backend, saying which tool and with what (for example: add_to_stack for 散歩, さんぽ, "a walk"), and keep talking naturally. Don't guess a tool's result while waiting.`;

const BACKEND_INSTRUCTIONS =
  "You run the tools for Ping, a friendly Japanese conversation partner on a voice call. When the voice model asks, call exactly the tool it names with the right arguments: add_to_stack for a Japanese word the learner asked about (its kanji if it has any, its kana, romaji and a short English meaning), update_settings for a change to how Ping talks or calls, back_to_conversation after answering a language or culture question, and end_call to hang up after a goodbye. Don't call a tool nobody asked for. Reply with one short sentence saying what you did.";

// The session for one call: Ping's instructions, a Japanese voice, the greeting to say first, and the tools.
export function liveSession({ question, settings, localHour, localDate, calledBack, contact, memories = [], learnerName = null, comebackWords = [], model = LIVE_MODEL, voice = LIVE_VOICE, backendModel = LIVE_BACKEND_MODEL }) {
  const instructions = `${buildInstructions({ question, localHour, localDate, calledBack, contact, settings, memories, learnerName, comebackWords })}\n\n${LIVE_NOTE}`;
  const greeting = openingWords({ question, contact, formality: settings.formality, calledBack, localHour, learnerName });
  return {
    model,
    instructions,
    audio: { output: { voice } },
    // The docs: startup instructions help the greeting but don't guarantee it, and the wording may vary a little.
    input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `Greet the user now, in Japanese. Say exactly: 「${greeting}」` }] }],
    delegation: {
      type: 'responses',
      responses: {
        model: backendModel,
        instructions: BACKEND_INSTRUCTIONS,
        tools: TOOLS.map(({ type, name, description, parameters }) => ({ type, name, description, parameters })),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_output_tokens: 300,
      },
    },
  };
}
