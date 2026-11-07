# Ping turn-taking v2: build plan

Owner: Stella. Builder: Claude Code. Save this file in the repo as `docs/turn-taking-plan.md` and work through it one session at a time.

## Why we're doing this

Ping's users are Japanese learners. They pause mid-sentence to find a word, often after えーと or あの. They switch to English when stuck. They say うん and はい while the other person is talking, which is normal Japanese listening behavior (aizuchi), not an attempt to interrupt.

Ping currently uses OpenAI's `server_vad`, which only listens for silence. That causes two problems:

1. **Cut-offs.** A long thinking pause looks the same as a finished sentence, so Ping can take the turn while the learner is still working on their answer. For a learner, being cut off raises the stakes, which works against Ping's whole low-stakes idea.
2. **False interruptions.** `interrupt_response: true` stops Ping's reply on any sound, so a polite うん cuts Ping off mid-sentence.

The goal is to make these problems measurable first, then test fixes against that measurement, then publish what we learn. Three reasons for this order:

- We can't tell whether a change helped without numbers from real calls.
- The A/B setup lets us compare detectors on the same users instead of guessing.
- The benchmark tells us whether a bigger rebuild (Pipecat with Smart Turn, or Deepgram Flux) is worth doing, before we do it.

This work also doubles as a portfolio piece for voice AI conversation design roles. That means I need to understand and explain every change myself.

## Rules for Claude Code

- Work on a branch named `turn-taking-v2`. Never commit to `main`.
- Do one session at a time. Stop at the end of each session and wait for me.
- Before writing code in a session, tell me in plain language what you will change and why. After the code, walk me through each changed file so I can explain it in an interview.
- Keep the existing style: plain JavaScript, no framework, no build step, `node --test` for tests. Run `npm test` before every commit. All tests must pass.
- Don't add dependencies to the Node app without asking.
- Check OpenAI Realtime event and field names against the current docs before relying on them. Don't guess. Field names I'm unsure of are marked "verify".
- Keep the privacy promises in the README. Transcripts from free-plan users never go to the server. Any new data sent to the server must be numbers only, and the README must say so.
- Update the README in the same session as any behavior change.

---

## Session 0: Orient (no behavior changes)

1. Create the `turn-taking-v2` branch.
2. Read `server/tutor.js`, `server/settings.js`, `server/index.js`, `server/calls.js`, `public/voice.js`, `public/app.js` and `public/settings.js`.
3. Run `npm test` and confirm everything passes.
4. Summarize for me, in under 15 lines:
   - How a call's session is built
   - Where `turnDetection` is used (it's in `buildSession` and in the `PATCH /api/settings` response)
   - Which data channel events `voice.js` handles today

**Done when:** I've read the summary and said go.

---

## Session 1: Turn event log

**Why:** this is the measuring stick for everything after it. Without it, sessions 2 and 3 are opinions.

**What to build**

1. In `public/voice.js`, record a timestamp (`performance.now()`) for each of these data channel events:
   - `input_audio_buffer.speech_started` and `input_audio_buffer.speech_stopped` (new cases; verify the payloads, which should include `audio_start_ms` / `audio_end_ms`)
   - `input_audio_buffer.committed`
   - `response.created`, `response.done`
   - `output_audio_buffer.started`, `output_audio_buffer.stopped`, `output_audio_buffer.cleared`

2. From those, build a per-call summary object:
   - `replyLatencyMs`: for each user turn, the time from `speech_stopped` to the next `output_audio_buffer.started`. Report median, 90th percentile and count.
   - `suspectedCutoffs`: how many times the user started speaking within 1500 ms after Ping's audio started. This is a proxy for "Ping took the turn too early." Put the 1500 in a named constant.
   - `bargeIns`: how many times Ping's audio was cleared because the user spoke.
   - `ignoredAizuchi`: always 0 for now. Session 3 fills it.
   - `userTurns`, `agentTurns`, `callSeconds`.
   - Context: `turnMode` (always `"silence"` for now), `thinkingTime`, `speed`, `proficiency`.

3. When the call ends (any reason), send the summary to a new route, `POST /api/calls/:id/metrics`. Fire and forget; a failure must never block or break the end of a call.

4. In `server/index.js`:
   - Validate the body: numbers only, a known set of keys, reject anything else.
   - Store it on the call record.
   - Print one log line per call, prefixed `turn-metrics` and holding JSON, so I can grep the Render logs.

5. Tests:
   - A pure function that turns an event list into the summary. Put it in a small module so it can be tested without a browser.
   - Tests covering latency, cut-off and barge-in counting.
   - Route tests for good and bad bodies, following the style of `tests/server.test.js`.

6. README:
   - Under Privacy, add one line: "At the end of a call, the app sends timing numbers (no audio, no words) to the server to measure conversation quality."
   - Under How it's built, add the new module.

**Done when:** I make two test calls and see two `turn-metrics` lines with sensible numbers.

---

## Session 2: Semantic turn detection as an admin switch

**Why:** OpenAI's `semantic_vad` decides the turn is over from what was said, not just from silence. It's free to try and should cut down thinking-pause cut-offs. A per-user switch lets me run an A/B on my own calls and the beta testers' calls, using the Session 1 numbers.

**What to build**

1. Add a user-level field `turnMode` with values `"silence"` (default, today's behavior) and `"semantic"`.
   - Only admins can change it. Follow the pattern of `PUT /api/plan` and the `user.role !== 'admin'` checks in `server/index.js`.
   - Beta testers get whatever an admin sets for them, or the default.
   - Give admins a small way to switch it on the settings screen, next to the plan test switch.

2. In `server/tutor.js`, change `turnDetection(thinkingTime, speed)` to `turnDetection({ thinkingTime, speed, turnMode })`:
   - `"silence"` returns today's object, unchanged.
   - `"semantic"` returns `{ type: 'semantic_vad', eagerness, create_response: true, interrupt_response: true }`.
     - Thinking time `short` maps to eagerness `medium`.
     - `normal` and `long` map to `low`.
     - Put the mapping in a named constant with a comment explaining it.

3. Update both call sites (`buildSession` and the `PATCH /api/settings` response) so a mid-call settings change keeps the user's mode.

4. Send `turnMode` in the Session 1 summary.

5. Tests:
   - Both modes and every thinking time map correctly.
   - A non-admin can't change `turnMode`.
   - The existing `server_vad` test still passes unchanged.

6. README:
   - Add `turnMode` to the settings and admin tables.
   - Add one line saying `normal` and `long` currently behave the same under semantic mode, because `low` is the lowest eagerness level.

**Known gap to watch:** if learners in semantic mode still get cut off on long pauses, the next step is a different detector, not more tuning here.

**Done when:** tests pass, and I've made two calls in each mode with the metrics logged.

---

## Session 3: Aizuchi-tolerant interruptions

**Why:** a learner saying うん while Ping talks should not stop Ping. A real interruption should, quickly. This is a turn-taking behavior specific to Japanese, and a good example of conversation design that lives in pipeline settings rather than in the prompt.

**Step 3a: spike first, no commits**

Find out what OpenAI does when:
- `interrupt_response` is `false`
- `create_response` is `true`
- the user says a short うん while a reply is playing

Does it queue a new reply to the うん? Does it error because a response is already active? Log what happens on two test calls and report back before building. The design below depends on the answer.

**Step 3b: build**

1. Set `interrupt_response: false` in both turn modes, so `voice.js` decides when to interrupt.

2. In `voice.js`, when `speech_started` arrives while Ping's audio is playing, start a timer of `AIZUCHI_WINDOW_MS = 500`.
   - If `speech_stopped` arrives before the timer fires, it was aizuchi. Clear the timer, increase `ignoredAizuchi`, and let Ping keep talking.
   - If the timer fires, it's a real interruption. Send `response.cancel` and `output_audio_buffer.clear` (verify both are valid client events for WebRTC sessions), then increase `bargeIns`.

3. Depending on the spike:
   - **If OpenAI queues a reply to the うん:** set `create_response: false`. Create replies from `voice.js` on `input_audio_buffer.committed` instead.
     - Skip the reply when the user's speech was shorter than about 600 ms and overlapped Ping's audio. Use speech duration from the event timestamps, not the transcript, so there's no extra delay waiting for transcription.
     - Keep the existing `response.create` calls in `handleToolCalls` working.
   - **If it doesn't:** keep `create_response: true`.

4. Put `AIZUCHI_WINDOW_MS` and the 600 ms rule in named constants, each with a one-line comment explaining why.

5. Tests:
   - Pull the interruption decision into a pure function: given event timings, it returns "ignore" or "interrupt".
   - Test it at 300 ms, 499 ms, 501 ms and 2000 ms.

6. README: describe the new interruption behavior in two or three sentences under "How a call works".

**Done when:** on a test call, I say うん during Ping's reply and Ping keeps talking. When I talk over Ping properly, it stops within about half a second. The metrics show both.

---

## Session 4: End-of-turn benchmark (`bench/`, Python, never deployed)

**Why:** this answers whether ping should move off silence detection to a stronger model, and the results become a public write-up: "End-of-turn detection on Japanese learner speech." It costs nothing:
- Smart Turn is open source and runs on a laptop CPU.
- Deepgram Flux fits inside the free signup credit.

**Setup**

1. Create `bench/` with:
   - Its own `requirements.txt`
   - A `.env` holding `DEEPGRAM_API_KEY`
   - A `README.md` explaining how to run it
2. Add `bench/.env`, `bench/audio/` and any `.venv` folder to `.gitignore`. Audio never goes into git.
3. Use Python 3.12 in a virtual environment.
4. For Deepgram details, use Deepgram's docs MCP server (`https://developers.deepgram.com/_mcp/server`) or their docs site. Don't guess parameter names.

**Recording protocol (I record, you build the tools)**

1. Write `bench/record.py`: press Enter to start and stop, and it saves a 16 kHz mono WAV to `bench/audio/` with an incrementing name.
2. I answer each of ping's six questions (from `QUESTIONS` in `server/tutor.js`) out loud, three times each, in Japanese:
   - **Take 1:** at my normal level.
   - **Take 2:** a harder version that forces me to search for words. For example, answer "What did you do today?" with something I lack vocabulary for.
   - **Take 3:** mixing in English when stuck.
3. Write `bench/label.py`: for each clip, it finds pauses longer than 300 ms (simple energy threshold), plays the audio around each one, and asks me to label it `t` (still thinking) or `d` (done). Labels go to `bench/labels.csv` with columns `clip, pause_start_s, pause_end_s, label`.
4. Target about 60 labeled pauses, roughly two thirds `thinking`.

**Detectors (`bench/run.py`)**, all run on the same labeled pauses:

1. **Silence baseline** at 0.8, 1.3 and 2.5 seconds (ping's current thresholds). The turn ends at a pause when the pause length is at least the threshold.
2. **Smart Turn v3.** Use the open model from `pipecat-ai/smart-turn`, following its `predict.py` / `inference.py`. Feed the audio from the clip start up to the pause start plus 200 ms of silence. A probability of 0.5 or higher means "done."
3. **Deepgram Flux Multilingual:**
   - `model=flux-general-multi`, with `language_hint=ja` and `language_hint=en`
   - Two settings: the default end-of-turn threshold, and one more patient setting (higher threshold; check the docs for the exact parameter and range)
   - Stream each clip at real-time speed and record every `EndOfTurn` event time
   - An `EndOfTurn` inside a `thinking` pause counts as a cut-off. For a `done` pause, latency is the event time minus the pause start.

**Metrics, per detector and setting:**
- **Cut-off rate:** share of `thinking` pauses where it ended the turn. Lower is better.
- **Catch rate:** share of `done` pauses where it ended the turn. Higher is better.
- **Median time to catch a real end.**

**Outputs**
- `bench/results.csv`
- A comparison table printed to the terminal
- `bench/RESULTS.md`: a draft write-up with method, results table and limitations (one speaker, a small sample, staged difficulty). I'll rewrite the prose myself.

**Done when:** `python bench/run.py` produces the table from my labeled clips, and the Deepgram cost shown in my console is under $5.

---

## After all four sessions

- Merge `turn-taking-v2` only after I've used it on my own calls for a few days.
- Use the Session 1 numbers and the benchmark to decide between three options:
  - Keep OpenAI semantic mode
  - Move to Pipecat with Smart Turn
  - Try Deepgram Flux in the live app
