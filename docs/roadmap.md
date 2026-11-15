# Roadmap

**North star for the next few weeks:** the Deepgram Staff Conversational Designer interview. When priorities conflict, pick what deepens conversation-design skill and produces evidence you can show. The job's first chapter is persona, turn-taking and repair, then evals and developer guidance. The roadmap follows the same order.

**Rule for every item:** it isn't done until it produces something you can show: a doc, a table of numbers, or a before-and-after recording.

## Now

| # | Work | Done when | Shows the interviewer |
| --- | --- | --- | --- |
| 0 | **Keep the demo working.** Confirm the Render key isn't the 7-day one, credit is topped up, and `DAILY_CALL_LIMIT` is set | One clean call on the live app | (keeps everything else possible) |
| 1 | **Deepgram Voice Agent as an admin engine.** Flux STT, an OpenAI model through Deepgram, Aura-2 Japanese voice, Ping's tools. Keep a **developer friction log** while building | An admin can call Ping on Deepgram, and the friction log is written | Pipeline fluency, hands-on with their API, designing for developers |
| 2 | **Conversation design spec v1**, in `docs/conversation-design.md`: persona, turn-taking per use case, the repair ladder, no-input and no-match handling, confirmation by stakes, pacing and call endings, with sample dialogs | The spec is written, and each behavior points to the rule or code that implements it | The job's first chapter, done on a real product |
| 3 | **Recruit 3–5 real beginners.** Record and label their pauses, and run Wizard of Oz sessions where you play Ping | At least 3 new speakers in `bench/` | Real users, not just yourself. Wizard of Oz is a listed bonus |
| 4 | **Eval harness v0:** about 20 scripted scenarios × each engine, scored on timing and an LLM-judge rubric checked against your own labels | One report comparing engines, including how often the judge agreed with you | Quality made measurable and repeatable |

## Next

| # | Work | Why |
| --- | --- | --- |
| 5 | **Patience profiles:** tune Flux end-of-turn per "time to answer", then compare silence, Smart Turn and Flux on the new speakers and in calls | Turn-taking tuned per use case, with numbers |
| 6 | **Pacing experiments:** a soft ゆっくりでいいよ ("take your time") during long thinking pauses, a short acknowledgement before replies, turning Ping down instead of stopping it for aizuchi, and winding the call down before the time limit | Latency-aware pacing and backchanneling, the "half-second you can't design away" |
| 7 | **Post-call quality taps:** "Did Ping cut you off?" and a 1–5 naturalness rating, sent as numbers | Field labels for evals and for adaptive patience |
| 8 | **Speech-to-speech vs cascaded memo:** gpt-realtime, gpt-realtime-mini and the Deepgram agent, on latency, cut-offs, rule-following and cost per minute. One page, bottom line first | Speaks directly to Deepgram's platform bet |
| 9 | **Weekly transcript review** of testers' recorded calls (admin Call recordings page) → failure types → fixes → regression tests | A transcript-review practice, as the job describes. Recording ships on `call-recordings` |

## Later

- **RCS / context-bus experiment** with Pipecat: does passing "the learner sounds unsure" make a cascaded agent as patient as speech-to-speech? It needs a Python server, so it stays admin-only.
- **Haru-4B / J-Moshi offline:** a full-duplex naturalness benchmark on your Mac.
- **Adaptive patience:** parked until the quality taps give enough labeled calls. See Session 6 in `turn-taking-plan.md`.
- **Gemini Live**, if Japanese is confirmed.

## Parked: beta and YC readiness

These are not the focus right now, but they must happen before the beta code is shared widely:
- Real accounts, so a lost phone doesn't lose the account
- Move call recordings to cloud storage (the Render disk holds a few hundred calls)
- A lawyer's review of the call-recording Privacy Policy and Terms, and a separate policy before any testers outside the US
- A long-lived OpenAI key with a monthly budget
- Payments to replace the plan test switch
- Lawyer review of the Privacy Policy and Terms

Product ideas from earlier reviews are in `spec-changes-and-suggestions.md` and the Nov 10–11 session summary:
- A post-call recap
- Saved words coming back in calls
- Call-me-later
- Voice onboarding
- Streak freezes

## Open questions

- **When is the interview?** That sets how much of "Next" fits in. If it's under two weeks away, do Now items 0–2 and a small item 4.
- **Which LLM in the Deepgram agent?** An OpenAI model keeps the comparison fair. Claude is an option for a second run.
