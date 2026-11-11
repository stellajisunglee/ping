import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI } from '../server/openai.js';

const WORD = { kanji: '元気', kana: 'げんき', romaji: 'genki', english: 'healthy, well' };

test('example sentences use a structured response and are read from the output', async () => {
  let sent;
  const sentences = [1, 2, 3, 4].map((number) => ({ japanese: `例文${number}です。`, romaji: `reibun ${number} desu.`, english: `Example ${number}.` }));
  const openai = createOpenAI({
    apiKey: 'key',
    textModel: 'test-model',
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ sentences }) }] }] }),
      };
    },
  });
  const result = await openai.exampleSentences(WORD, 'beginner');
  assert.match(sent.url, /\/responses$/);
  assert.equal(sent.body.model, 'test-model');
  assert.equal(sent.body.text.format.type, 'json_schema');
  assert.equal(sent.body.text.format.strict, true);
  assert.deepEqual(sent.body.text.format.schema.properties.sentences.items.required, ['japanese', 'romaji', 'english']);
  assert.match(sent.body.input[0].content, /romaji/);
  assert.equal(result.length, 3);
  assert.equal(result[0].japanese, '例文1です。');
  assert.equal(result[0].romaji, 'reibun 1 desu.');
});

test("a sentence's words come back as structured output, in dictionary form with how they're written", async () => {
  let sent;
  const words = [{ asWritten: '始まります', kanji: '始まる', kana: 'はじまる', romaji: 'hajimaru', english: 'to start' }];
  const openai = createOpenAI({
    apiKey: 'key',
    textModel: 'test-model',
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ words }) }] }] }) };
    },
  });
  assert.deepEqual(await openai.sentenceWords('会議は三時から始まります。'), words);
  assert.equal(sent.body.input[1].content, '会議は三時から始まります。');
  assert.match(sent.body.input[0].content, /dictionary form/);
  assert.deepEqual(sent.body.text.format.schema.properties.words.items.required, ['asWritten', 'kanji', 'kana', 'romaji', 'english']);
  const failing = createOpenAI({ apiKey: 'key', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'nope' }) });
  await assert.rejects(failing.sentenceWords('会議'), /500/);
});

test('a failed or empty lookup raises an error', async () => {
  const failing = createOpenAI({ apiKey: 'key', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'nope' }) });
  await assert.rejects(failing.exampleSentences(WORD, 'beginner'), /500/);
  const empty = createOpenAI({ apiKey: 'key', fetchImpl: async () => ({ ok: true, json: async () => ({ output: [] }) }) });
  await assert.rejects(empty.exampleSentences(WORD, 'beginner'), /empty/);
});
