// The only code that holds the OpenAI key. The browser gets a short-lived key per call.

import { createHash } from 'node:crypto';

const CLIENT_SECRET_SECONDS = 60;
const VOICE_INSTRUCTIONS = 'Speak like a warm, cheerful friend leaving a short voicemail in Japanese, at a relaxed pace.';
const EXAMPLE_COUNT = 3;

const EXAMPLES_FORMAT = {
  type: 'json_schema',
  name: 'example_sentences',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      sentences: {
        type: 'array',
        items: {
          type: 'object',
          properties: { japanese: { type: 'string' }, english: { type: 'string' } },
          required: ['japanese', 'english'],
          additionalProperties: false,
        },
      },
    },
    required: ['sentences'],
    additionalProperties: false,
  },
};

export function createOpenAI({ apiKey, baseUrl = 'https://api.openai.com/v1', textModel = 'gpt-6-luna', fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const hasKey = Boolean(apiKey);

  return {
    hasKey,
    sdpUrl: `${baseUrl}/realtime/calls`,

    async mintClientSecret(session, userId) {
      const response = await fetchImpl(`${baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: { ...headers, 'OpenAI-Safety-Identifier': createHash('sha256').update(userId).digest('hex') },
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_SECONDS }, session }),
      });
      if (!response.ok) throw new Error(`Client secret request failed (${response.status}): ${await response.text()}`);
      const { value } = await response.json();
      return value;
    },

    async speak(text, voice) {
      const response = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, instructions: VOICE_INSTRUCTIONS, response_format: 'mp3' }),
      });
      if (!response.ok) throw new Error(`Speech request failed (${response.status}): ${await response.text()}`);
      return Buffer.from(await response.arrayBuffer());
    },

    async exampleSentences(word, proficiency) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: textModel,
          max_output_tokens: 600,
          input: [
            { role: 'system', content: `Write ${EXAMPLE_COUNT} short, natural Japanese example sentences using the given word, for a ${proficiency} learner, each with an English translation. Use polite speech.` },
            { role: 'user', content: JSON.stringify({ word: word.kanji || word.kana, reading: word.kana, meaning: word.english }) },
          ],
          text: { format: EXAMPLES_FORMAT },
        }),
      });
      if (!response.ok) throw new Error(`Example sentences request failed (${response.status}): ${await response.text()}`);
      const { output = [] } = await response.json();
      const text = output.find((item) => item.type === 'message')?.content?.find((part) => part.type === 'output_text')?.text;
      if (!text) throw new Error('Example sentences came back empty');
      return JSON.parse(text).sentences.slice(0, EXAMPLE_COUNT);
    },
  };
}
