# Eval baseline: Ping before the persona refactor

Three full runs of `npm run eval` against commit `90c6455` (the last commit before the persona work), on 15 November 2026 (Pacific time; the files are named in UTC). Ping ran on OpenAI `gpt-realtime` in text, and Claude `claude-opus-5-5` judged. Every scenario played its own learner lines, with Ping's day fixed to 15 November at 15:00 (`evals/ping-engine.js`), so the prompt is identical in each run.

A single run varies, so compare tallies over three runs, not one:

```bash
node evals/summarize.js evals/baseline/*.json      # this baseline
node evals/summarize.js evals/runs/<new runs>.json  # after a change
```

The word-for-word prompt this baseline ran on is saved in `tests/fixtures/instructions/`, and `tests/instructions-snapshot.test.js` fails if it changes.

## Results

3 runs. Code checks passed: 82/90. Errors: none playing, none judging. Cells show how many of the 3 runs passed, or how many failed (bold).

| scenario | checks | expectation | level | brevity | warmth | noLoop | register |
| --- | --- | --- | --- | --- | --- | --- | --- |
| word-meaning-japanese | 4/6 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| word-meaning-english | 5/6 | **1/3 fail** | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| how-do-you-say | 6/6 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| translate-request | 9/9 | **3/3 fail** | 3/3 | 3/3 | 3/3 | **3/3 fail** | 3/3 |
| still-lost | 3/3 | **3/3 fail** | 3/3 | 3/3 | 3/3 | **3/3 fail** | **1/3 fail** |
| how-to-answer | 6/6 | **3/3 fail** | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| culture-question | 8/9 | **1/3 fail** | 3/3 | 3/3 | **1/3 fail** | **1/3 fail** | 3/3 |
| english-answer | 3/3 | **3/3 fail** | 3/3 | 3/3 | 3/3 | na | 3/3 |
| short-beginner-answer | 6/6 | 3/3 | 3/3 | 3/3 | 3/3 | na | 3/3 |
| hesitant-answer | 3/3 | **1/3 fail** | 3/3 | 3/3 | 3/3 | na | 3/3 |
| grammar-mistake | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | na | 3/3 |
| asks-about-ping | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | na | 3/3 |
| off-topic | 3/3 | 3/3 | 3/3 | 3/3 | **3/3 fail** | na | 3/3 |
| slow-down | 5/6 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| stop-calling (aspirational) | 0/3 | **3/3 fail** | 3/3 | 3/3 | 3/3 | na | **2/3 fail** |
| goodbye | 6/6 | 3/3 | 3/3 | 3/3 | 3/3 | na | **2/3 fail** |
| not-a-good-time | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | na | 3/3 |
| casual-style | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | na | 3/3 |
| intermediate-learner | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | na | **1/3 fail** |

| rubric item | pass | fail | na |
| --- | --- | --- | --- |
| expectation | 39 | 18 | 0 |
| level | 57 | 0 | 0 |
| brevity | 57 | 0 | 0 |
| warmth | 53 | 4 | 0 |
| noLoop | 15 | 7 | 35 |
| register | 51 | 6 | 0 |

## What fails, by pattern

The judge hasn't been checked against your own labels yet, so read these as leads, not verdicts.

- **Repair repeats the question (every run).** On translate-request and still-lost, Ping translates, then asks the identical Japanese question again (「最近、どうですか？」, 「今、何をしていますか？」), although rule 2 says never to. noLoop fails 3/3 on both.
- **"How should I answer?" gets no example answer (every run).** Ping hints at topics but never offers a sample like 今日は忙しかったです.
- **An English answer isn't nudged toward Japanese (every run).** Ping reacts warmly and carries on in Japanese, without inviting the learner to try it in Japanese. Rule 9 or 10 could each claim this turn.
- **Off topic sounds robotic (every run).** The fixed 「ちょっとわかりません。」 plus the question repeated word for word reads as curt (warmth 3/3 fail).
- **Formal calls slip into casual endings.** Goodbyes (じゃあ、またね, バイバイ), 「そうなんだ」 and 「って聞きました」 inside です/ます calls: register fails in 6 of 57.
- **Stop calling (aspirational) turns calls off without asking** whether they want a break or to stop for good. Expected: this behavior hasn't been built.
- **Code check flakes:** word explanations sometimes end in English or a Japanese sentence quoting English (endsInJapanese 3 misses), and once culture-question skipped its English answer entirely.

Level and brevity never failed.
