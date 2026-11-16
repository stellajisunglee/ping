// Hand-label a run, blind to the judge, to check how far the judge can be trusted.
//   node evals/label.js evals/runs/<run>.json
// Shows each conversation, in random order, and asks the same rubric questions the judge answered.
// Keys: p pass, f fail, n doesn't apply, s skip, q save and quit. Answers go to evals/labels/<run>.csv,
// and a second session picks up where the last one stopped. Then run evals/agreement.js.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { labelsPathFor, parseLabels } from './agreement.js';
import { describeLearner, formatTranscript } from './judge-prompt.js';

const KEYS = { p: 'pass', f: 'fail', n: 'na' };

const runPath = process.argv[2];
if (!runPath) {
  console.error('Usage: node evals/label.js evals/runs/<run>.json');
  process.exit(1);
}
const run = JSON.parse(readFileSync(runPath, 'utf8'));
const rubric = JSON.parse(readFileSync(new URL('./rubric.json', import.meta.url), 'utf8'));
const scenarios = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));
const labelsPath = labelsPathFor(runPath);
const labels = existsSync(labelsPath) ? parseLabels(readFileSync(labelsPath, 'utf8')) : [];
const done = new Set(labels.map((label) => `${label.scenario}|${label.item}`));

// Conversations in random order, each one's questions together, so you read each conversation once.
const queue = run.scenarios
  .filter((scenario) => !scenario.error && scenario.judge)
  .map((scenario) => ({ scenario, order: Math.random() }))
  .sort((a, b) => a.order - b.order)
  .flatMap(({ scenario }) => rubric.map((item) => ({ scenario, item })))
  .filter(({ scenario, item }) => !done.has(`${scenario.id}|${item.id}`));

function save() {
  mkdirSync(dirname(labelsPath), { recursive: true });
  writeFileSync(labelsPath, ['scenario,item,label', ...labels.map((label) => `${label.scenario},${label.item},${label.label}`)].join('\n') + '\n');
  console.log(`\nSaved ${labels.length} labels to ${labelsPath}. Next: node evals/agreement.js ${runPath}`);
}

function show({ scenario, item }) {
  const spec = scenarios.find((candidate) => candidate.id === scenario.id);
  console.clear();
  console.log(`${queue.length} left\n`);
  console.log(`Scenario: ${spec?.title ?? scenario.id}\n${describeLearner(scenario.settings)}\nExpectation: ${spec?.expect ?? ''}\n`);
  console.log(formatTranscript(scenario.transcript));
  console.log(`\n${item.question}\n  Pass: ${item.pass}\n  Fail: ${item.fail}`);
  console.log('\n[p] pass  [f] fail  [n] doesn\'t apply  [s] skip  [q] quit');
}

if (!queue.length) {
  console.log('Everything in this run is labeled.');
  process.exit(0);
}
emitKeypressEvents(process.stdin);
process.stdin.setRawMode?.(true);
show(queue[0]);
process.stdin.on('keypress', (text, key) => {
  if (key?.ctrl && key.name === 'c') text = 'q';
  if (text === 'q') {
    save();
    process.exit(0);
  }
  if (!KEYS[text] && text !== 's') return;
  const current = queue.shift();
  if (KEYS[text]) labels.push({ scenario: current.scenario.id, item: current.item.id, label: KEYS[text] });
  if (!queue.length) {
    save();
    process.exit(0);
  }
  show(queue[0]);
});
