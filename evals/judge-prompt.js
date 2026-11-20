// What the judge reads: the rubric, the scenario, and the conversation. Kept apart from the API call
// so it can be tested, and so a human labeler sees exactly what the judge sees.

export const VERDICTS = ['pass', 'fail', 'na'];

export function formatTranscript(transcript) {
  return transcript
    .map((line) => {
      const who = line.from === 'ping' ? 'Ping' : 'Learner';
      const tools = (line.tools ?? []).map((tool) => `[tool: ${tool.name} ${JSON.stringify(tool.args)}]`).join(' ');
      return [`${who}: ${line.text || '(no words)'}`, tools].filter(Boolean).join(' ');
    })
    .join('\n');
}

export function describeLearner(settings) {
  return `Level: JLPT ${settings.proficiency}. Speech style requested: ${settings.formality}.`;
}

export const JUDGE_SYSTEM = `You review practice phone calls between Ping, an AI friend that phones Japanese learners, and a learner.
You score Ping's behavior against a rubric. Judge only what is in the transcript. Learner lines were typed, so ignore anything about audio or timing.
For each rubric item, answer pass, fail, or na (the item doesn't apply to this conversation), with one short sentence of reasoning that points to what Ping said.
Be strict about the scenario's expectation and fair about everything else: a reply that a good human tutor might give passes.`;

export function judgeUserMessage(scenario, result, rubric) {
  const items = rubric.map((item) => `- ${item.id}: ${item.question}\n  Pass: ${item.pass}\n  Fail: ${item.fail}`).join('\n');
  return `Scenario: ${scenario.title}
${describeLearner(result.settings)}
Expectation: ${scenario.expect}

Conversation:
${formatTranscript(result.transcript)}

Rubric:
${items}`;
}

// The JSON the judge must return: one verdict per rubric item, in order.
export function verdictSchema(rubric) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: rubric.map((item) => item.id) },
            verdict: { type: 'string', enum: VERDICTS },
            reason: { type: 'string' },
          },
          required: ['id', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
}

// Keeps exactly one verdict per rubric item, in rubric order. Anything missing counts as unscored.
export function cleanVerdicts(parsed, rubric) {
  const byId = new Map((parsed?.items ?? []).filter((item) => VERDICTS.includes(item?.verdict)).map((item) => [item.id, item]));
  return rubric.map((item) => {
    const found = byId.get(item.id);
    return found ? { id: item.id, verdict: found.verdict, reason: String(found.reason ?? '') } : { id: item.id, verdict: null, reason: 'not scored' };
  });
}
