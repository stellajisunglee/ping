# Conversation evals

Checks what Ping *says and does* on a fixed set of learner situations, so changes to its instructions, model or engine can be compared with numbers instead of impressions. `bench/` is the other half: it measures *when* Ping takes the turn, from audio.

## How it works

1. **Scenarios** (`scenarios.json`): each one is a learner situation. Ping's question, the learner's settings, one or more learner lines, what good behavior looks like (`expect`), and exact checks. `aspirational: true` marks behavior Ping should have but may not yet, reported apart so it doesn't hide regressions.
2. **Playing** (`ping-engine.js`): each scenario runs against Ping's real instructions and tools (`server/tutor.js`) on OpenAI's Realtime model, in text. The learner's lines go in as typed text, so speech recognition and timing are out of scope here. Tools are answered the way the app answers them.
3. **Code checks** (`checks.js`): exact and free. Which tools Ping called, whether it used English, whether its last line was Japanese, how many sentences it said, and word-for-word repeats.
4. **The judge** (`judge.js`): Claude (`claude-opus-5-5`) scores each conversation on the six items in `rubric.json`: pass, fail or doesn't apply, with a one-sentence reason. It's a different model family from Ping's, so it isn't grading its own family's writing.
5. **Your labels** (`label.js`, `agreement.js`): you score a sample blind, and agreement shows how far the judge can be trusted, item by item.

## Run it

Needs `OPENAI_API_KEY` in `.env`, and `ANTHROPIC_API_KEY` for the judge. Get an Anthropic key from the Claude Console (console.anthropic.com), set a monthly spend limit there, and add `ANTHROPIC_API_KEY=...` to `.env` yourself. Never paste it anywhere else. The key is only used on your computer; Render doesn't need it.

```bash
npm run eval
```

```bash
npm run eval -- --only goodbye,slow-down
```

```bash
npm run eval -- --no-judge
```

Each run is saved to `runs/<time>.json` with the transcripts, check results, verdicts and reasons, the git commit, and which models ran.

## Compare with the baseline

`baseline/` holds three runs from before the persona refactor, with the results in `baseline/README.md`. Runs vary, so after a change make three runs and compare the tallies:

```bash
node evals/summarize.js evals/baseline/*.json
node evals/summarize.js evals/runs/<your three runs>.json
```

## Check the judge (about 30 minutes, once)

```bash
node evals/label.js evals/runs/<run>.json
```

It shows one conversation at a time, in random order, and asks the six rubric questions without showing the judge's answers. Press `p` pass, `f` fail, `n` doesn't apply, `s` skip, `q` save and quit. About 8 conversations (48 answers) is enough. Then:

```bash
node evals/agreement.js evals/runs/<run>.json
```

It prints overall agreement, Cohen's kappa (agreement beyond chance: above about 0.6 is good, above 0.8 is strong), agreement per rubric item, and every disagreement with the judge's reason.

- **Where you mostly agree:** trust the judge for that item, and spot-check after big changes.
- **Where you don't:** the rubric wording is usually the cause. Fix `rubric.json`, re-run, and label again. Your labels are the ground truth.

## Add a scenario

From a tester's call: describe the failure in your own words as a new scenario. Never paste a tester's real lines; the recordings are private. Run it to see it fail, fix Ping, and it stays in the set as a regression test.

## Costs

Each run spends a little on OpenAI (text replies from the Realtime model) and on Anthropic (one judge call per scenario, at Claude Opus 5.5 rates). Use `--only` while iterating.
