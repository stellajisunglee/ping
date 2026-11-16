// Adds up several eval runs of the same scenarios, so a change can be compared with a baseline.
// A single run varies from one to the next, so compare tallies over a few runs, not one run.
//   node evals/summarize.js evals/baseline/*.json
// Prints a Markdown table: checks passed, and for each rubric item how many runs failed it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function summarize(runs, rubricIds) {
  const ids = [...new Set(runs.flatMap((run) => run.scenarios.map((scenario) => scenario.id)))];
  const totals = Object.fromEntries(rubricIds.map((id) => [id, { pass: 0, fail: 0, na: 0, unscored: 0 }]));
  const checks = { passed: 0, total: 0 };
  const errors = { play: 0, judge: 0 };
  const scenarios = ids.map((id) => {
    const played = runs.map((run) => run.scenarios.find((scenario) => scenario.id === id)).filter(Boolean);
    const passed = played.reduce((count, scenario) => count + scenario.checks.filter((check) => check.ok).length, 0);
    const total = played.reduce((count, scenario) => count + scenario.checks.length, 0);
    checks.passed += passed;
    checks.total += total;
    errors.play += played.filter((scenario) => scenario.error).length;
    errors.judge += played.filter((scenario) => scenario.judge?.error).length;
    const items = Object.fromEntries(
      rubricIds.map((itemId) => {
        const verdicts = played.map((scenario) => scenario.judge?.items.find((item) => item.id === itemId)?.verdict ?? 'unscored');
        for (const verdict of verdicts) totals[itemId][verdict ?? 'unscored'] += 1;
        return [itemId, { pass: verdicts.filter((v) => v === 'pass').length, fail: verdicts.filter((v) => v === 'fail').length, runs: played.length }];
      }),
    );
    return { id, aspirational: Boolean(played[0]?.aspirational), checks: { passed, total }, items };
  });
  return { runs: runs.length, commits: [...new Set(runs.map((run) => run.commit))], scenarios, checks, totals, errors };
}

const cell = ({ pass, fail, runs }) => (fail ? `**${fail}/${runs} fail**` : pass ? `${pass}/${runs}` : 'na');

export function toMarkdown(summary, rubricIds) {
  const rows = summary.scenarios.map(
    (scenario) => `| ${scenario.id}${scenario.aspirational ? ' (aspirational)' : ''} | ${scenario.checks.passed}/${scenario.checks.total} | ${rubricIds.map((id) => cell(scenario.items[id])).join(' | ')} |`,
  );
  const totals = rubricIds.map((id) => `| ${id} | ${summary.totals[id].pass} | ${summary.totals[id].fail} | ${summary.totals[id].na} | ${summary.totals[id].unscored} |`);
  return [
    `${summary.runs} runs, commit ${summary.commits.join(', ')}. Checks passed: ${summary.checks.passed}/${summary.checks.total}. Errors: ${summary.errors.play} playing, ${summary.errors.judge} judging.`,
    '',
    `| scenario | checks | ${rubricIds.join(' | ')} |`,
    `| --- | --- | ${rubricIds.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
    '| rubric item | pass | fail | na | unscored |',
    '| --- | --- | --- | --- | --- |',
    ...totals,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Give one or more run files, for example evals/baseline/*.json');
  const rubricIds = JSON.parse(readFileSync(new URL('./rubric.json', import.meta.url), 'utf8')).map((item) => item.id);
  const runs = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  console.log(toMarkdown(summarize(runs, rubricIds), rubricIds));
}
