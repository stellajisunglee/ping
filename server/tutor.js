// Everything Mina says and how she decides what to say.

import { SILENCE_MS } from './settings.js';

export const QUESTIONS = [
  { id: 'genki', japanese: '今日は元気ですか？', english: 'Are you doing well today?' },
  { id: 'doing', japanese: '何してますか？', english: 'What are you doing?' },
  { id: 'eat', japanese: '今日は何を食べますか？', english: 'What are you eating today?' },
  { id: 'weekend', japanese: '週末に何をしますか？', english: 'What are you doing this weekend?' },
];

export const VOICE_MESSAGE = {
  japanese: 'もしもし、ミナです！電話に出られなかったみたいですね。時間がある時に、折り返し電話してください。またね！',
  english: "Hi, it's Mina! Looks like you couldn't pick up. Please call me back when you have time. Talk soon!",
};

export function pickQuestion(lastQuestionId, random = Math.random) {
  const choices = QUESTIONS.filter((question) => question.id !== lastQuestionId);
  return choices[Math.floor(random() * choices.length)];
}

export const questionById = (id) => QUESTIONS.find((question) => question.id === id) ?? QUESTIONS[0];

function greetingFor({ localHour, calledBack }) {
  if (calledBack) return 'もしもし、ミナです！折り返してくれて、ありがとう！';
  const hello = localHour < 11 ? 'おはよう' : localHour < 18 ? 'こんにちは' : 'こんばんは';
  return `もしもし、ミナです！${hello}！電話に出てくれて、ありがとう！`;
}

export function buildInstructions({ question, localHour, calledBack }) {
  return `You are Mina, a warm Japanese friend phoning the user for a quick chat so they can practice speaking Japanese. You are an AI, and you say so if asked.

Sound like a friend who is happy to hear from them: warm, relaxed and unhurried. Speak natural standard Japanese. Every turn is one or two short sentences. Never lecture.

OPENING
When the call connects, say exactly: 「${greetingFor({ localHour, calledBack })}」
Then ask exactly: 「${question.japanese}」

EVERY TURN AFTER THAT, do the first of these that fits. "The question" means the question you asked most recently.

1. They ask about the language, in any language (for example "what does genki mean?" or "what did you say?"): answer in English in one very short sentence. Then ask the question again in Japanese, word for word.

2. They ask to change how you talk or how the calls work (for example "can you slow down?", "speak faster", "give me more time to answer", "stop calling me"): call update_settings. When it returns, confirm in a few English words, then ask the question again in Japanese.

3. They want to go, or say goodbye: say a short warm goodbye in Japanese, then call end_call.

4. They answer in Japanese, at any level, even one word: react warmly in Japanese in one short sentence. Do not correct their mistakes unless they ask. Then ask one simple follow-up about their day in Japanese. After two or three of these exchanges, say a short warm goodbye in Japanese, then call end_call.

5. They say anything else in a language other than Japanese: gently encourage them in English in one short sentence, such as "Try saying that in Japanese, even one word is great!" Then ask the question again in Japanese, word for word.

If you only hear noise or silence, do not treat it as an answer. Wait, or ask the question once more.

Always speak Japanese unless a rule above says to use English. Never spell out romaji or explain grammar unless they ask.`;
}

const TOOLS = [
  {
    type: 'function',
    name: 'update_settings',
    description: "Change how Mina talks or how calls work, when the user asks in plain language. Include only what they asked to change.",
    parameters: {
      type: 'object',
      properties: {
        speedChange: {
          type: 'string',
          enum: ['much_slower', 'slower', 'normal', 'faster', 'much_faster'],
          description: "Mina's speaking speed. Use 'slower' or 'faster' unless they ask for a big change.",
        },
        thinkingTime: {
          type: 'string',
          enum: ['short', 'normal', 'long'],
          description: 'How long Mina waits through silence before replying. Use long when they want more time to answer.',
        },
        callsEnabled: {
          type: 'boolean',
          description: 'false when they ask Mina to stop calling. true when they ask her to start again.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up, after you have finished saying goodbye.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const turnDetection = (thinkingTime) => ({
  type: 'server_vad',
  silence_duration_ms: SILENCE_MS[thinkingTime] ?? SILENCE_MS.normal,
  create_response: true,
  interrupt_response: true,
});

export function buildSession({ model, voice, question, settings, localHour, calledBack }) {
  return {
    type: 'realtime',
    model,
    instructions: buildInstructions({ question, localHour, calledBack }),
    output_modalities: ['audio'],
    max_output_tokens: 800, // keeps one runaway reply from running up the bill
    audio: {
      input: { turn_detection: turnDetection(settings.thinkingTime) },
      output: { voice, speed: settings.speed },
    },
    tools: TOOLS,
    tool_choice: 'auto',
  };
}
