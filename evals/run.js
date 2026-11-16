// Runs the eval set: each scenario against Ping, then the code checks, then the Claude judge.
//   npm run eval                       every scenario
//   npm run eval -- --only goodbye,slow-down
//   npm run eval -- --no-judge         code checks only (no Anthropic key needed)
// Writes evals/runs/<time>.json and prints a summary.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './checks.js';
import { runScenario } from './ping-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(join(HERE, file), 'utf8'));

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const useJudge = !process.argv.includes('--no-judge');
  const only = option('only')?.split(',');
  const engineModel = option('model') ?? process.env.REALTIME_MODEL ?? 'gpt-realtime';
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing from .env.');
  if (useJudge && !process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is missing from .env. Add it, or run with --no-judge.');

  const rubric = read('rubric.json');
  const scenarios = read('scenarios.json').filter((scenario) => !only || only.includes(scenario.id));
  const judge = useJudge ? (await import('./judge.js')).createJudge() : null;
  const commit = (() => {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim();
    } catch {
      return null;
    }
  })();

  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`${scenario.id} ... `);
    const played = await runScenario(scenario, { apiKey: process.env.OPENAI_API_KEY, model: engineModel });
    const checks = runChecks(scenario.checks, played.transcript);
    const judged = judge && !played.error ? await judge(scenario, played, rubric) : null;
    results.push({ id: scenario.id, area: scenario.area, aspirational: Boolean(scenario.aspirational), ...played, checks, judge: judged });
    const failedChecks = checks.filter((check) => !check.ok).length;
    const failedItems = judged?.items.filter((item) => item.verdict === 'fail').length ?? 0;
    console.log(played.error ? `error: ${played.error}` : `${checks.length - failedChecks}/${checks.length} checks, ${failedItems} rubric fails`);
  }

  const at = new Date().toISOString();
  const run = { at, commit, engine: { provider: 'openai', model: engineModel }, judge: judge ? { provider: 'anthropic', model: results.find((r) => r.judge)?.judge.model ?? null } : null, scenarios: results };
  mkdirSync(join(HERE, 'runs'), { recursive: true });
  const file = join(HERE, 'runs', `${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);

  // Summary: aspirational scenarios describe behavior Ping doesn't have yet, so they're listed apart.
  const row = (scenario) => ({
    checks: scenario.error ? 'error' : `${scenario.checks.filter((c) => c.ok).length}/${scenario.checks.length}`,
    ...Object.fromEntries((scenario.judge?.items ?? []).map((item) => [item.id, item.verdict ?? '-'])),
  });
  console.table(Object.fromEntries(results.filter((s) => !s.aspirational).map((s) => [s.id, row(s)])));
  const aspirational = results.filter((s) => s.aspirational);
  if (aspirational.length) {
    console.log('Aspirational (behavior Ping should have but may not yet):');
    console.table(Object.fromEntries(aspirational.map((s) => [s.id, row(s)])));
  }
  console.log(`Saved ${file}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
