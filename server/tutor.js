// The voice session for a call: the contact's instructions, the tools it can call, and how its turns are taken.
// The instructions are built in prompt.js, from who the contact is (persona.js, contacts.js) and the
// words it says exactly (lines.js). Those are re-exported here, so callers can keep importing from tutor.js.

import { PING } from './contacts.js';
import { buildInstructions } from './prompt.js';
import { silenceMs } from './settings.js';

export { buildInstructions, PROMPT_VERSION } from './prompt.js';
export { NOT_NOW_GOODBYES, openingWords, pickQuestion, QUESTIONS, questionById, TIME_UP_LINES, voiceMessageFor } from './lines.js';

const TRANSCRIPTION_MODEL = 'gpt-transcribe';

export const TOOLS = [
  {
    type: 'function',
    name: 'add_to_stack',
    description: "Save a Japanese word the user didn't understand to their word bank.",
    parameters: {
      type: 'object',
      properties: {
        kanji: { type: 'string', description: 'The word as it is usually written, with kanji if it has any (for example 無糖). An empty string only if it is written in kana alone.' },
        kana: { type: 'string', description: 'The word in hiragana or katakana.' },
        romaji: { type: 'string', description: 'The word in romaji.' },
        english: { type: 'string', description: 'A short English definition.' },
      },
      required: ['kanji', 'kana', 'romaji', 'english'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_settings',
    description: 'Change how you talk or how calls work, when the user asks in plain language. Include only what they asked to change.',
    parameters: {
      type: 'object',
      properties: {
        speedChange: {
          type: 'string',
          enum: ['much_slower', 'slower', 'normal', 'faster', 'much_faster'],
          description: "Your speaking speed. Use 'slower' or 'faster' unless they ask for a big change.",
        },
        thinkingTime: {
          type: 'string',
          enum: ['short', 'normal', 'long'],
          description: 'How long you wait through silence before replying. Use long when they want more time to answer.',
        },
        formality: {
          type: 'string',
          enum: ['formal', 'casual'],
          description: 'How politely you speak.',
        },
        proficiency: {
          type: 'string',
          enum: ['new', 'N5', 'N4', 'N3', 'N2', 'N1'],
          description: "How hard your Japanese is, as a JLPT level: 'new' (completely new to Japanese) is the easiest, then N5, and N1 the hardest. To make it a little easier or harder, move one level from the user's current level.",
        },
        callsEnabled: {
          type: 'boolean',
          description: 'false when they ask you to stop calling. true when they ask you to start again.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'back_to_conversation',
    description: 'Call this right after answering a question about Japanese language or culture. Your next words come as a new message, so the answer stays separate from the conversation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up, after you have finished saying goodbye.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// How Ping decides the user has finished their turn: after enough silence, when OpenAI
// judges from the words said so far that they're done, or with Smart Turn on the phone.
export const TURN_MODES = ['silence', 'semantic', 'smartTurn'];

// Semantic mode has no silence length to tune, only how eager the model is to reply.
// Learners pause to find words, so even "short" stops at medium, and "normal" and "long"
// both get low, the most patient level, which waits up to 8 seconds.
const SEMANTIC_EAGERNESS = { short: 'medium', normal: 'low', long: 'low' };

// OpenAI stops the contact when the user speaks (interrupt_response), but doesn't reply on its own
// (create_response). The app asks for each reply, so it can let the contact carry on after aizuchi.
const REPLY_CONTROL = { create_response: false, interrupt_response: true };

// In smartTurn mode the call starts in silence mode, and the phone switches OpenAI's detection off
// once Smart Turn has loaded. If it never loads, the call simply stays in silence mode.
export function turnDetection({ thinkingTime, speed, turnMode = 'silence' }) {
  if (turnMode === 'semantic') return { type: 'semantic_vad', eagerness: SEMANTIC_EAGERNESS[thinkingTime] ?? 'low', ...REPLY_CONTROL };
  return { type: 'server_vad', silence_duration_ms: silenceMs(thinkingTime, speed), ...REPLY_CONTROL };
}

// Smart Turn's own patience, per thinking time: how sure it must be that the user is done, and how much
// quiet ends the turn anyway. On the benchmark, 0.7 with a 4-second backup cut off 10% of thinking pauses
// against 14% for "normal", and still caught 68% of finished answers within a quarter of a second.
const SMART_TURN_PATIENCE = {
  short: { doneAt: 0.5, backupMs: 2000 },
  normal: { doneAt: 0.5, backupMs: 2500 },
  long: { doneAt: 0.7, backupMs: 4000 },
};

export const smartTurnRules = (thinkingTime) => ({ ...(SMART_TURN_PATIENCE[thinkingTime] ?? SMART_TURN_PATIENCE.normal) });

export function buildSession({ model, voice, question, settings, localHour, localDate, calledBack, contact = PING, memories = [], turnMode = 'silence', learnerName = null }) {
  return {
    type: 'realtime',
    model,
    instructions: buildInstructions({ question, localHour, localDate, calledBack, contact, settings, memories, learnerName }),
    output_modalities: ['audio'],
    max_output_tokens: 800, // keeps one runaway reply from running up the bill
    audio: {
      input: {
        transcription: { model: TRANSCRIPTION_MODEL, languages: ['ja', 'en'] },
        turn_detection: turnDetection({ thinkingTime: settings.thinkingTime, speed: settings.speed, turnMode }),
      },
      output: { voice: contact.voice ?? voice, speed: settings.speed },
    },
    tools: TOOLS,
    tool_choice: 'auto',
  };
}
