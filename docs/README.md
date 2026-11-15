# Ping: start here

Ping phones Japanese learners for short speaking practice. It's a web app installed on the phone. Calls arrive as push notifications, and the voice runs on OpenAI's speech-to-speech model over WebRTC.

**Status (Nov 14, 2026):**
- **Live:** https://ping-jmxg.onrender.com, deployed from `main` at `5ca8500`.
- **Tests:** all 226 pass.
- **Users:** admins and invited testers only. The beta isn't open yet.
- **Current focus:** preparing for the Deepgram Staff Conversational Designer interview. See [roadmap.md](roadmap.md).

## The four docs to read

| Doc | Answers |
| --- | --- |
| [architecture.md](architecture.md) | How a call works end to end, what each folder and file does, and how we build and ship |
| [models-and-data.md](models-and-data.md) | Which models Ping runs on, which data matters most, and what we still need to collect |
| [roadmap.md](roadmap.md) | What to do next, in order, and what's parked |
| [decisions.md](decisions.md) | Every major call we've made, why, and the evidence |

## Reference

| File | What it is |
| --- | --- |
| [../README.md](../README.md) | The operating manual: behavior, plans, settings, privacy, deploy. Kept up to date with every behavior change. |
| [turn-taking-plan.md](turn-taking-plan.md) | The six-session turn-taking build plan (Sessions 0–6), with what happened in each. |
| [../bench/README.md](../bench/README.md), [../bench/RESULTS.md](../bench/RESULTS.md) | The end-of-turn benchmark: how to run it, and the results. |
| [spec-changes-and-suggestions.md](spec-changes-and-suggestions.md) | How the build differs from the original product spec, and UX and naturalness ideas. |

## Where everything lives

```
ping/
├── server/        Node server: calls, schedule, plans, stack, OpenAI keys, push      (deployed)
├── public/        The phone app: screens, the call, Smart Turn, turn metrics          (deployed)
│   ├── models/    Smart Turn v3.2 and Silero VAD, run on the phone                   (deployed)
│   └── vendor/    onnxruntime-web, which runs those models                           (deployed)
├── tests/         node --test, 226 tests
├── bench/         Python end-of-turn benchmark + labeled pauses              (in git, never deployed)
├── docs/          This folder: plans, decisions, roadmap
├── scripts/       Setup and icon drawing
├── lab/           Smart Turn browser spike + pasted call metrics              (local only, not in git)
└── data/          The live JSON store and call recordings when running locally (local only, not in git)
```

Secrets live in `.env` (app) and `bench/.env` (Deepgram key for the benchmark). Neither is in git.

## How we work

The rules every build session follows, whether it's you or Claude Code:

1. Explain the change in plain language before coding, then walk through each changed file afterwards.
2. Plain JavaScript, no framework, no build step. Don't add Node dependencies without asking.
3. Run `npm test` before every commit, and all tests must pass.
4. Check OpenAI (and Deepgram) field names against the current docs, never from memory.
5. **Privacy:**
   - Calls are recorded for review (audio and transcript), as the README's "Call recordings" section describes.
   - The in-app Privacy Policy and Terms must always match what the code collects. Change them in the same session.
   - Recordings stay with the Ping team: never shared, sold, or used to identify or copy a voice.
   - Beyond recordings, any new server data must be numbers only, and the README must say so.
6. Update the README in the same session as any behavior change.
7. **Shipping:**
   - Work on a branch.
   - Merge to `main` only after using it on your own calls. `main` deploys to Render automatically.
   - Never push without being asked.
8. Never put keys in chat or in git. NEVER add OpenAI credit yourself.
