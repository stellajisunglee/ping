// The judge: Claude reads each conversation and scores it against rubric.json.
// It's a different model family from Ping's (OpenAI), so it isn't grading its own family's writing.
// Uses Anthropic's official library, @anthropic-ai/sdk, which is only needed to run evals, not by the app.

import Anthropic from '@anthropic-ai/sdk';
import { cleanVerdicts, JUDGE_SYSTEM, judgeUserMessage, verdictSchema } from './judge-prompt.js';

export const JUDGE_MODEL = 'claude-opus-5-5';

export function createJudge({ model = JUDGE_MODEL } = {}) {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  return async function judge(scenario, result, rubric) {
    try {
      // fallbacks: "default" re-runs a request on another model if a safety check declines it.
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: verdictSchema(rubric) } },
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: judgeUserMessage(scenario, result, rubric) }],
      });
      if (response.stop_reason === 'refusal') return { model: response.model, items: cleanVerdicts(null, rubric), error: 'the judge declined' };
      if (response.stop_reason === 'max_tokens') return { model: response.model, items: cleanVerdicts(null, rubric), error: 'the judge ran out of room' };
      const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      return { model: response.model, items: cleanVerdicts(JSON.parse(text), rubric), error: null };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic key was rejected. Check ANTHROPIC_API_KEY in .env.');
      if (error instanceof Anthropic.RateLimitError) return { model, items: cleanVerdicts(null, rubric), error: 'rate limited, try again later' };
      if (error instanceof Anthropic.APIError) return { model, items: cleanVerdicts(null, rubric), error: `API error ${error.status}: ${error.message}` };
      if (error instanceof SyntaxError) return { model, items: cleanVerdicts(null, rubric), error: 'the judge returned invalid JSON' };
      throw error;
    }
  };
}
