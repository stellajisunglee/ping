# Decision log

The newest decisions are at the top. Each one records what was decided, why, and what evidence it rests on. Add a line whenever you choose between real options. Note it here when a decision is reversed, too; don't delete the old entry.

| Date | Decision | Why | Evidence / status |
| --- | --- | --- | --- |
| 2026-11-14 | **Record calls for review** (both voices and the transcript), on by default for everyone. Locked on for admins and beta testers; YC reviewers and future users can turn it off, which stops future recordings only. Kept until the account is deleted. Private to the Ping team. US adults only, for now | You need to hear testers' real calls to review conversations, build evals and label pauses. Retention is stated only in the Privacy Policy, to keep friction low. Changes the earlier rule that free-plan transcripts never reach the server | Branch `call-recordings`. Privacy Policy and Terms need a lawyer's review |
| 2026-11-14 | **The Deepgram interview drives priorities** for the next few weeks. The next engine to add is the Deepgram Voice Agent | Build evidence for the role's first chapter: persona, turn-taking, repair, evals | [roadmap.md](roadmap.md) |
| 2026-11-11 | **Limit calls per day instead of minutes per month.** Admins and YC reviewers are unlimited | Free 1/day up to 3 min, Premium 3/day up to 5 min, Platinum 5/day up to 10 min. Ping's own call is kept for it, and call-backs don't count | `594aa51`, `d0858c4` |
| 2026-11-10 | **Invite codes only come from the environment** | So the repo can be public. The old codes are still in git history, so don't reuse them | `1f9cff1` |
| 2026-11-10 | **Ping has a life of its own** (Tokyo, the cat Mochi, the coffee shop, a plan for each day of the week) | Asking 「元気？」 got empty answers that sounded like an AI | `cae9936`, `server/persona.js` |
| 2026-11-10 | **Removed adaptive patience** (more patience after a cut-off). Revisit with more calls | Most cut-offs came from Smart Turn's score, not the backup timer (11 of 14). With about 10 calls there's too little data to tune it | Session 6 in `turn-taking-plan.md` |
| 2026-11-10 | **Smart Turn follows "time to answer"**: long = score 0.7 with a 4 s backup | Smart Turn ignored "long", which is why silence felt better on your test calls | Benchmark sweep: 0.7 / 4 s gives 10% cut-offs vs 14% |
| 2026-11-10 | **Silence stays the default and the demo mode** | Predictable. Smart Turn replied ~1 s faster but cut off 3 times in 44 turns | Field data: 6 Smart Turn calls, 4 silence calls |
| 2026-11-10 | **My Stack moved onto Home. Mero shows as "Coming soon"** | Home is the landing screen, and teasing the next contact | `81267af`, `5bf5eef` |
| 2026-11-09 | **Translate rule:** say it in English, then ask again in easier Japanese, never repeating the same sentence | Ping kept repeating itself when asked to translate | `70561da` |
| 2026-11-09 | **Out-of-credit: admin calls hang up and say so.** Beta testers' calls are unchanged | A silent call cost a debugging session. OpenAI doesn't document how it reports this | `70561da` |
| 2026-11-08 | **Answer English questions about Japanese language and culture** in 1–2 sentences, then return to Japanese | These were real questions, but got "try saying it in Japanese" | `bbd1124` |
| 2026-11-08 | **Smart Turn runs on the phone**, with a 2.5 s backup and a fallback to silence mode | Audio stays on the phone, it's free, and ~230 ms per decision | `9989823`, `public/smart-turn.js` |
| 2026-11-07 | **Ruled out Deepgram Flux for turn detection; chose Smart Turn** | Flux cut off 37% of thinking pauses at default settings, or 17% when tuned but ~1 s slower to catch. It also needs a second streaming service. Smart Turn: 11% | `bench/RESULTS.md` (140 pauses, one speaker) |
| 2026-11-06 | **Aizuchi over Ping means carry on, not answer** | うん and はい are listening, not interrupting | `9dde5d6`, `public/aizuchi.js` |
| 2026-11-06 | **Measure before fixing:** per-call timing numbers, no words or audio | You can't tell whether a change helped without numbers. Privacy rule: numbers only | `07b3701`, `public/turn-metrics.js` |
| 2026-11-01 | **The invite code decides the role** (admin or beta, later YC). Onboarding is only an invite code | Get to a working call fast. No names or emails | `8952050` |
| 2026-11-01 | **Plans are a test switch with no payments** | Prove value before building billing | README "Plans" |
| 2026-10-31 | **A PWA with web push, and OpenAI speech-to-speech over WebRTC.** Plain JS, one JSON file, one Render instance | Fastest path to a real phone call, and audio never touches our server. The trade-off: web push can't ring like a phone | `Build Ping` commit, README |
| 2026-10-31 | **Daily call limit off for prototyping** | Unlimited testing. Turned back on before beta | README "Before beta launch" |
