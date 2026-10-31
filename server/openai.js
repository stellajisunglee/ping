// The only code that holds the OpenAI key. The browser gets a short-lived key per call.

import { createHash } from 'node:crypto';

const CLIENT_SECRET_SECONDS = 60;
const VOICE_INSTRUCTIONS = 'Speak like a warm, cheerful friend leaving a short voicemail in Japanese, at a relaxed pace.';

export function createOpenAI({ apiKey, baseUrl = 'https://api.openai.com/v1', fetchImpl = fetch }) {
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
  };
}
