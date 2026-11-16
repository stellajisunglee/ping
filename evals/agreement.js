// How often the judge agrees with your hand labels. Run after labeling:
//   node evals/agreement.js evals/runs/<run>.json
// Reads evals/labels/<run>.csv. Items either side left unscored are skipped.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function parseLabels(csv) {
  return csv
    .trim()
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((row) => {
      const [scenario, item, label] = row.split(',');
      return { scenario, item, label };
    });
}

// Cohen's kappa: agreement beyond what two raters would reach by chance, from 0 (chance) to 1 (perfect).
function kappa(pairs) {
  const total = pairs.length;
  if (!total) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / total;
  const labels = [...new Set(pairs.flat())];
  const expected = labels.reduce((sum, label) => {
    const a = pairs.filter(([first]) => first === label).length / total;
    const b = pairs.filter(([, second]) => second === label).length / total;
    return sum + a * b;
  }, 0);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

const rounded = (value) => (value === null ? null : Math.round(value * 100) / 100);

export function agreement(run, labels) {
  const judged = new Map();
  for (const scenario of run.scenarios) {
    for (const item of scenario.judge?.items ?? []) judged.set(`${scenario.id}|${item.id}`, item);
  }
  const pairs = [];
  const disagreements = [];
  const byItem = {};
  for (const { scenario, item, label } of labels) {
    const judge = judged.get(`${scenario}|${item}`);
    if (!judge?.verdict || !label) continue;
    pairs.push([judge.verdict, label]);
    byItem[item] ??= { compared: 0, agreed: 0 };
    byItem[item].compared += 1;
    if (judge.verdict === label) byItem[item].agreed += 1;
    else disagreements.push({ scenario, item, judge: judge.verdict, you: label, reason: judge.reason });
  }
  const agreed = pairs.filter(([a, b]) => a === b).length;
  return {
    compared: pairs.length,
    agreement: pairs.length ? rounded(agreed / pairs.length) : null,
    kappa: rounded(kappa(pairs)),
    byItem: Object.fromEntries(Object.entries(byItem).map(([item, counts]) => [item, { ...counts, agreement: rounded(counts.agreed / counts.compared) }])),
    disagreements,
  };
}

export const labelsPathFor = (runPath) => join('evals', 'labels', basename(runPath).replace(/\.json$/, '.csv'));

if (import.meta.url === `file://${process.argv[1]}`) {
  const runPath = process.argv[2];
  if (!runPath) {
    console.error('Usage: node evals/agreement.js evals/runs/<run>.json');
    process.exit(1);
  }
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const result = agreement(run, parseLabels(readFileSync(labelsPathFor(runPath), 'utf8')));
  console.log(`Compared ${result.compared} items. Agreement ${Math.round((result.agreement ?? 0) * 100)}%, kappa ${result.kappa ?? '-'}.`);
  console.table(Object.fromEntries(Object.entries(result.byItem).map(([item, counts]) => [item, `${counts.agreed}/${counts.compared}`])));
  for (const miss of result.disagreements) console.log(`- ${miss.scenario} / ${miss.item}: judge ${miss.judge}, you ${miss.you}. Judge said: ${miss.reason}`);
}
