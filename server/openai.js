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
          properties: { japanese: { type: 'string' }, romaji: { type: 'string' }, english: { type: 'string' } },
          required: ['japanese', 'romaji', 'english'],
          additionalProperties: false,
        },
      },
    },
    required: ['sentences'],
    additionalProperties: false,
  },
};

const SENTENCE_WORDS_FORMAT = {
  type: 'json_schema',
  name: 'sentence_words',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: { asWritten: { type: 'string' }, kanji: { type: 'string' }, kana: { type: 'string' }, romaji: { type: 'string' }, english: { type: 'string' } },
          required: ['asWritten', 'kanji', 'kana', 'romaji', 'english'],
          additionalProperties: false,
        },
      },
    },
    required: ['words'],
    additionalProperties: false,
  },
};

const SENTENCE_WORDS_INSTRUCTIONS =
  'List every word in the Japanese sentence that is written with at least one kanji, in the order they appear, each once. For each give: ' +
  'asWritten, exactly as it appears in the sentence; kanji, its dictionary form as usually written (for example 始まります becomes 始まる, 美味しかった becomes 美味しい); ' +
  'kana, that dictionary form in hiragana; romaji, that dictionary form in Hepburn romaji; english, a short English meaning that fits this sentence. ' +
  'A number or counter written with kanji, like 三時, is one word. Leave out words with no kanji. If there are none, return an empty list.';

const JLPT = ['N5', 'N4', 'N3', 'N2', 'N1'];
const LEVEL_FORMAT = {
  type: 'json_schema',
  name: 'speaking_level',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: JLPT },
      vocabulary: { type: 'string', enum: JLPT },
      grammar: { type: 'string', enum: JLPT },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      reason: { type: 'string' },
    },
    required: ['level', 'vocabulary', 'grammar', 'confidence', 'reason'],
    additionalProperties: false,
  },
};

const LEVEL_INSTRUCTIONS =
  "You estimate a Japanese learner's speaking level from a phone-call transcript between the learner and a friendly AI. " +
  'Judge only the lines marked LEARNER, using the AI lines only for context. Give the JLPT level (N5 easiest, N1 near-fluent) that best matches ' +
  'what the learner can do in speech, judging vocabulary, grammar, and how fully they answer. Separately rate their vocabulary and their grammar. ' +
  'The transcript comes from speech recognition, so ignore small spelling or kanji errors, and do not count fillers like えーと against them. ' +
  'Short answers and English show less ability than complete Japanese sentences, but a learner can only show the level the conversation asked for, ' +
  'so when there is little Japanese to judge, give the level the evidence supports and set confidence to low. ' +
  'reason is one short English sentence naming the clearest evidence.';

export function createOpenAI({ apiKey, baseUrl = 'https://api.openai.com/v1', textModel = 'gpt-6-luna', levelModel = 'gpt-4.1-mini', fetchImpl = fetch }) {
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
            { role: 'system', content: `Write ${EXAMPLE_COUNT} short, natural Japanese example sentences using the given word, for a JLPT ${proficiency} learner, each with its romaji (Hepburn, words separated by spaces) and an English translation. Use polite speech.` },
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

    // An estimate of the learner's speaking level from a recorded call's transcript ([{ from, text }]).
    async gradeLevel(lines) {
      const transcript = lines.map((line) => `${line.from === 'you' ? 'LEARNER' : 'AI'}: ${line.text}`).join('\n');
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: levelModel,
          max_output_tokens: 300,
          input: [
            { role: 'system', content: LEVEL_INSTRUCTIONS },
            { role: 'user', content: transcript },
          ],
          text: { format: LEVEL_FORMAT },
        }),
      });
      if (!response.ok) throw new Error(`Level request failed (${response.status}): ${await response.text()}`);
      const { output = [] } = await response.json();
      const text = output.find((item) => item.type === 'message')?.content?.find((part) => part.type === 'output_text')?.text;
      if (!text) throw new Error('Level estimate came back empty');
      const estimate = JSON.parse(text);
      if (![estimate.level, estimate.vocabulary, estimate.grammar].every((level) => JLPT.includes(level))) throw new Error('Level estimate was not a JLPT level');
      return { level: estimate.level, vocabulary: estimate.vocabulary, grammar: estimate.grammar, confidence: estimate.confidence, reason: String(estimate.reason).slice(0, 300) };
    },

    // The words with kanji in a saved sentence, so each can be studied and added to the stack.
    async sentenceWords(japanese) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: textModel,
          max_output_tokens: 1200,
          input: [
            { role: 'system', content: SENTENCE_WORDS_INSTRUCTIONS },
            { role: 'user', content: japanese },
          ],
          text: { format: SENTENCE_WORDS_FORMAT },
        }),
      });
      if (!response.ok) throw new Error(`Sentence words request failed (${response.status}): ${await response.text()}`);
      const { output = [] } = await response.json();
      const text = output.find((item) => item.type === 'message')?.content?.find((part) => part.type === 'output_text')?.text;
      if (!text) throw new Error('Sentence words came back empty');
      return JSON.parse(text).words;
    },
  };
}
