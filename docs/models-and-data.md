# Models and data

**In short:** the models are interchangeable. What makes Ping good, and what's hard to copy, is the turn-taking data from learner speech, the conversation rules, and the evals that show whether a call was good. Spend effort there first.

## Models in use today

| Model | Job | Runs where | Set in | Why this one |
| --- | --- | --- | --- | --- |
| **OpenAI `gpt-realtime`** | The call itself: hears audio, replies in audio | OpenAI, over WebRTC from the phone | `REALTIME_MODEL` | Speech-to-speech hears tone and hesitation directly, and gives natural rhythm in one hop |
| Voice `marin` | Ping's voice | OpenAI | `REALTIME_VOICE`, or per contact in `server/contacts.js` | Chosen by ear |
| **`gpt-transcribe`** | Writes down what the user said, for the screen and saved words. The model doesn't read it | OpenAI | `TRANSCRIPTION_MODEL` in `server/tutor.js` | Japanese and English in one stream |
| **OpenAI `server_vad` / `semantic_vad`** | Deciding the user has finished (silence and semantic modes) | OpenAI | `TURN_MODES` in `server/tutor.js` | Silence is the demo default: predictable |
| **Silero VAD** | Hears speech start and stop (Smart Turn mode) | The phone (onnxruntime-web) | `public/models/` | Small and fast |
| **Smart Turn v3.2** | "Still thinking or done?" from the last 8 s of audio | The phone, about 230 ms per decision on an iPhone | `public/models/`, `SMART_TURN_PATIENCE` | Fewest cut-offs on the benchmark, free, and audio stays on the phone |
| `TEXT_MODEL` (default `gpt-6-luna`) | Example sentences, and the kanji in a sentence | OpenAI, from the server | `TEXT_MODEL` | Only used outside calls |
| `gpt-4o-mini-tts` | Speaks the voicemail | OpenAI, from the server | `server/openai.js` | Cheap, and good enough for 10 seconds |

## Models to test next

These are for the Deepgram interview work and the engine comparison. See [roadmap.md](roadmap.md).

| Candidate | Type | Japanese | Fit | Priority |
| --- | --- | --- | --- | --- |
| `gpt-realtime-mini` | Speech-to-speech | ✅ | Change one setting | Quick cost-vs-quality check |
| **Deepgram Voice Agent** (Flux/Nova STT, an LLM of your choice, Aura-2/Flux TTS) | Cascaded | Japanese voices confirmed. STT in Japanese still to confirm in the agent | The phone connects directly with a short-lived token | **First.** It's the real cascaded comparison, and the interview story |
| Deepgram + Pipecat + RCS (context bus) | Cascaded, passing along how the user sounded | Same as above | Needs a Python server, so audio would pass through ours | Later: a frontier experiment |
| Gemini Live | Speech-to-speech | Unconfirmed | The phone connects directly | If Japanese checks out |
| Haru-4B, J-Moshi | Open full-duplex | ✅ | Offline benchmark only: no tools, and they don't follow instructions | Naturalness benchmark on your Mac |
| Deepgram Flux (turn detection only) | End of turn | ✅ multilingual | Already benchmarked | Re-test with tuned profiles and more speakers |

## Data, ranked by how much it matters

| # | Data | What it is | Where | Health |
| --- | --- | --- | --- | --- |
| 1 | **Labeled learner pauses** | 140 pauses (100 still thinking, 40 done) from one speaker, labeled by hand | `bench/labels.csv`, `bench/decisions.csv`, audio in `bench/audio/` (local only) | 🔴 **Only one speaker.** It's the biggest gap. Every turn-taking claim depends on it |
| 2 | **Call recordings and transcripts** | Both voices and the heard transcript of every recorded call, from testers and admins (and YC reviewers who leave it on) | `DATA_DIR/recordings/` on the Render disk. Admin page: Settings, Admin tools, Call recordings | 🟡 **New (Nov 14).** This is the raw material for transcript review, quality labels, evals and more labeled pauses. Disk space is limited |
| 3 | **Per-call timing numbers** | Reply gap, wait after the user stops, cut-offs, barge-ins, ignored aizuchi, Smart Turn and backup counts, fallbacks | Render logs (`turn-metrics` lines). A local copy is in `lab/call-metrics.log` | 🟡 About 10 real calls, all yours. Log retention on Render is short, so copy lines out regularly |
| 4 | **Conversation rules and persona** | Ping's ten call rules, the four tools, Ping's week | `server/tutor.js`, `server/persona.js` | 🟢 Versioned in git and tested. They're the product's conversation design, written as code |
| 5 | **Quality labels** | Whether a call was good: cut off? did repair work? stayed at the learner's level? | Doesn't exist yet | 🔴 **Missing.** Needed for evals and for revisiting adaptive patience |
| 6 | User state | Settings, plan, streak with 14 practice days, stack, voicemails, paid-plan memories | `data/ping.json` on the Render disk | 🟢 Works. Privacy rules apply (below) |
| 7 | Benchmark results | Cut-off rate, catch rate and time per detector | `bench/results.csv`, `bench/RESULTS.md` | 🟢 Reproducible with `bench/run.py` |

## What to collect next, and how

1. **More speakers:** 3–5 real beginners, recorded with `bench/record.py` and labeled with `bench/label.py`. This turns "my own speech" into "learners".
2. **Quality labels, kept to numbers:**
   - A one-tap "Did Ping cut you off?" and a 1–5 naturalness rating after each call.
   - Sent as numbers, like the timing data, so the privacy rule holds.
3. **An eval set:** about 20 scripted learner turns (asking what a word means, "I don't understand", an English culture question, a long silence, a mumbled answer, "stop calling me"). Run each engine through them and score:
   - Timing.
   - A rubric applied by an LLM judge, checked against your own labels. Report how often the judge agrees with you.
4. **Transcript review:** listen to testers' calls on the admin Call recordings page. Review weekly: sort failures into types, fix them, and add a test for each. Testers' recordings can also be labeled for pauses, the same way as `bench/`.

## Privacy rules every model or data change must keep

- **The live call** goes from the phone straight to the model provider.
- **Recordings and transcripts** of recorded calls are uploaded after the call, kept until the account is deleted, and heard only by the Ping team. Never shared, sold, or used to identify or copy a voice.
- **Paid plans** also keep the last 20 heard transcripts, to personalize later calls.
- **Any other new server data must be numbers only**, and the README's Privacy section must say so.
- **The Privacy Policy lists every company that handles recordings** (today OpenAI and Render). Adding an engine or a storage provider (Deepgram, cloud storage, an LLM judge reading transcripts) means adding it there first.
- **Ping is for adults in the US.** Testers anywhere else need a different policy first.
