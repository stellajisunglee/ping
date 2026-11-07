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

**Added after Session 3:** `replyLatencyMs` starts when OpenAI decides the turn is over, so it hides the detector's own wait. In semantic mode at `low` eagerness that wait reached 7 seconds while reply latency read under 1 second. The summary now also estimates `turnEndWait` (from the user going quiet to OpenAI ending the turn) and `replyGap` (from the user going quiet to Ping's voice), using the audio times OpenAI puts on the speech events. Compare modes on `replyGap`, not `replyLatency`.

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

**What the spike found** (two rounds, both turn modes)

- Over WebRTC, OpenAI clears Ping's unplayed audio (`output_audio_buffer.cleared`, then `conversation.item.truncated`) the moment it detects speech, whatever `create_response` and `interrupt_response` are set to. No setting lets Ping talk through an うん, so the original design (`interrupt_response: false` plus a 500 ms window in `voice.js`) can't work.
- With `interrupt_response: false`, a reply that's cut while still being generated keeps generating, and its later audio plays anyway. Ping skips words. So `interrupt_response` stays `true`.
- After an うん, Ping usually restarted the sentence it was cut off in, because it can see its reply was trimmed to what was heard.
- In semantic mode, the event timestamps include OpenAI's own waiting, so a 「うん。」 measured about 1.2 seconds. Speech length from events can't spot aizuchi. The transcript can, and it arrives about 0.3 to 0.5 seconds after the turn ends.

**Step 3b: build (revised after the spike)**

The goal changes from "うん doesn't stop Ping" to "うん doesn't derail Ping."

1. Set `create_response: false` and keep `interrupt_response: true` in both turn modes. OpenAI still stops Ping when the user speaks, and the app asks for every reply.
2. In `voice.js`, when a turn ends (`input_audio_buffer.committed`):
   - If it didn't start while Ping was speaking, reply straight away.
   - If it did, wait for its transcript, up to `TRANSCRIPT_WAIT_MS`. If the words are only aizuchi, add a one-off system message telling Ping to carry on from where it was cut off without restarting, then reply, and count it as `ignoredAizuchi`. Otherwise reply normally. A failed or missing transcript gets a normal reply.
   - A turn that ends while a reply is still being written waits for that reply to finish.
3. Put the aizuchi word list and the decision in a pure module (`public/aizuchi.js`). The decision returns "reply", "wait" or "resume".
4. `bargeIns` now counts only talk-overs that weren't aizuchi.
5. Tests for the word list, every decision, and each reply path in `voice.js`.
6. README: describe the behavior under "How a call works".

**Done when:** on a test call, I say うん during Ping's reply and Ping picks up where it left off within about a second, without restarting or answering the うん. When I talk over Ping properly, it stops and answers me. The metrics show `ignoredAizuchi` and `bargeIns` separately.

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

**What the benchmark found** (140 labeled pauses: 100 thinking, 40 done, 17 of the done ones at the end of an answer)

| Detector | Cut-offs | Typical wait after a real end |
| --- | --- | --- |
| Silence 1.3 s (Ping today) | 33% | 1.3 s |
| Smart Turn v3.2 | 11% | 0.23 s |
| Smart Turn with a 2.5 s silence backup | 14% | 0.23 s, never over 2.5 s |
| Flux, patient setting | 17% | 1.06 s |

- Smart Turn missed 4 of the 17 end-of-answer pauses, so it needs a silence backup.
- Flux didn't beat Smart Turn, so Deepgram isn't needed.
- Smart Turn should run in the browser, not on the server. Ping's audio goes from the phone straight to OpenAI and never touches the server. Running it on the server would add a network hop, server cost, and voice passing through the server.
- Session 5 was added for Smart Turn. Adaptive patience moved to Session 6, so it's built once, for the detector Ping will actually use.

---

## Session 5: Smart Turn in the browser

**Why:** the benchmark says Smart Turn with a silence backup cuts learners off less than half as often as Ping's current 1.3-second rule, and replies about four times sooner. It's free and runs on the phone, so the audio never leaves the device. Two things are still unknown:
- How fast it runs in a phone browser.
- Whether it still works on the cleaned-up audio a call uses (echo cancellation, noise suppression, volume leveling). The benchmark used raw laptop recordings.

**Step 5a: spike first, no commits**

1. Ask me before adding anything new. The candidates:
   - `onnxruntime-web`, the library that runs the models
   - The Smart Turn v3.2 CPU model
   - Silero VAD, the small voice detector that tells Smart Turn when to look

   For each one, give me its size and license. Serve them from `public/` rather than a CDN, to keep the no-build-step setup.
2. Build a throwaway test page that runs Silero and Smart Turn on the live mic, using the same audio settings a call uses. Show each verdict on screen as I talk, plus:
   - How long the models took to download and load
   - Smart Turn's time per decision (median and slowest)
   - Silero's time per audio frame
3. Smart Turn takes Whisper-style log-mel features, not raw audio. Write that conversion in plain JavaScript. Check it against the Python feature extractor's output from `bench/`, using a small saved fixture.
4. Check the current OpenAI docs on how Ping tells OpenAI the turn is over. The preferred design keeps `server_vad` at a long silence (the backup) for barge-ins and long pauses. Find out whether the app can end the turn early (for example with `input_audio_buffer.commit` over WebRTC) while `server_vad` is on. If it can't, explain what turning OpenAI's detection off would mean for the Session 3 barge-in and aizuchi handling.
5. I test on my phone and on a laptop, with AirPods and on speaker. Report the numbers, and whether Ping's own voice ever triggers it.

**Go/no-go:** go ahead if Smart Turn's slowest decision on my phone is under about 300 ms, and its verdicts match my sense of when I'm done. Otherwise stop, and we decide from the numbers.

**Step 5b: build (after I say go on the spike)**

1. Add a third turn mode, `smartTurn`, to the admin switch from Session 2, so the three modes can be compared on the Session 1 numbers.
2. In `smartTurn` mode:
   - OpenAI keeps `server_vad` with a long silence, about 2.5 s, as the backup. This is subject to what 5a found.
   - When the user goes quiet, the browser runs Smart Turn. If the model says done, Ping ends the turn right away and replies through the existing `requestReply` path, so the Session 3 aizuchi rules still apply.
3. Keep the browser logic in its own file (for example `public/smart-turn.js`). Split it into pure functions that can be tested without a model or mic:
   - The log-mel features
   - The pause-and-decide logic
   - The fallback rule
4. Fallback: if the models fail to load, or a decision takes too long, that call quietly falls back to silence mode. A slow phone can never make Ping worse than today.
5. The service worker saves the model files in advance, so only the first call ever downloads them.
6. Add numbers to the Session 1 summary and the server's list of allowed fields:
   - `smartTurnEnds`: turns Smart Turn ended
   - `backupEnds`: turns the silence backup ended
   - `smartTurnMedianMs` and `smartTurnP90Ms`: decision times
   - `modelLoadMs`
   - `smartTurnFallback`: 0 or 1

   Numbers only, as always. Compare modes on `replyGap` and `suspectedCutoffs`.
7. Tests:
   - The features match the Python fixture within a small tolerance.
   - The decision logic is right for done, not done, and a slow model.
   - The fallback works.
   - The new metric fields pass `cleanMetrics`.
   - Route tests still show only admins can pick the mode.
8. README:
   - Add `smartTurn` to the admin table.
   - Explain the behavior under "How a call works".
   - Under privacy, say that Smart Turn runs on the phone and the audio stays there.

**Done when:** on my phone in `smartTurn` mode, most turns end within about half a second of my finishing, `suspectedCutoffs` is no worse than silence mode over several calls, and the metrics show `smartTurnEnds` well above `backupEnds`.

---

## Session 6: Adaptive patience within a call

**Why:** sessions 1 to 5 compare fixed settings. This one lets Ping react during the call: when it cuts the learner off, it waits longer for the rest of that call. It's a simple feedback rule built on the Session 1 measurement, and it only comes after the comparison so the earlier numbers stay clean. It applies to whichever detector the earlier sessions point to. After the benchmark, that's expected to be `smartTurn`.

**What to build**

1. In `voice.js`, when a suspected cut-off happens (the user starts speaking within `SUSPECTED_CUTOFF_WINDOW_MS` of Ping's audio starting, and Session 3 didn't classify it as aizuchi), raise Ping's patience one step for the rest of the call:
   - **Silence mode:** multiply the silence length by `PATIENCE_STEP`, capped at `MAX_SILENCE_MS`.
   - **Semantic mode:** move eagerness down one level, for example `medium` to `low`. `low` is the floor, so a user already at `low` stays there.
   - **Smart Turn mode:** raise the probability Smart Turn needs to call a turn done by `SMART_TURN_STEP`, for example 0.5 to 0.6, capped at `MAX_SMART_TURN_THRESHOLD`. Also lengthen the silence backup the same way silence mode does. The threshold lives in the browser, so it needs no `session.update`. The backup does.
   - Send any OpenAI change with `session.update`, through the same path as `updateVoice`, so it waits for Ping's turn to end. Check in the current docs that `turn_detection` can change mid-session, and don't guess.

2. Only ever step up, never back down, during a call, and stop after `MAX_PATIENCE_STEPS`. Put all three values in named constants, each with a one-line comment explaining why.

3. Keep the change to that call only. Don't save it to the user's settings, so every call starts from the same baseline and the numbers stay comparable. Whether to carry patience across calls is a later decision, made with data.

4. Add an admin switch, `adaptivePatience` (default off), next to the turn mode switch, so I can compare the same detector with and without adaptation.

5. Add `patienceSteps` to the Session 1 summary and to the server's list of allowed fields. The server adds `adaptivePatience` to the log line from the user's settings, the same way it adds `turnMode`, so the phone still sends numbers only.

6. Tests:
   - Pull the decision into a pure function: given the current turn detection and the steps taken so far, it returns the next turn detection, or nothing at the cap.
   - Test all three modes, the caps and the semantic floor.
   - Route tests show a non-admin can't change `adaptivePatience`.

7. README: explain the behavior in two or three sentences under "How a call works", and add `adaptivePatience` to the admin table.

**Known gap to watch:** the cut-off count is a proxy. A learner answering quickly after a very short reply from Ping can look like a cut-off and make Ping slower than needed. The step cap limits the damage. If calls start to feel sluggish, tighten what counts as a cut-off before tuning the steps.

**Done when:** on a test call, I get cut off on purpose and Ping waits noticeably longer afterwards. Over several calls, the metrics show `patienceSteps` above 0, and fewer suspected cut-offs with the switch on than off.

---

## After all six sessions

- Merge `turn-taking-v2` only after I've used it on my own calls for a few days.
- Use the Session 1 numbers from real calls to pick the default turn mode: silence, semantic or `smartTurn`. The benchmark points to `smartTurn`. Deepgram Flux was ruled out by the benchmark.
- Use the Session 6 numbers to decide whether adaptive patience stays on, and whether it should carry across calls.

## Known issues to fix later

- **The call transcript shows words Ping never said.** OpenAI writes a reply in about a second but takes several seconds to speak it, so the full reply appears on screen right away. When the user interrupts, OpenAI cuts the audio and trims its own copy of the reply (`conversation.item.truncated`), but the screen keeps the whole text. Fix: on `conversation.item.truncated`, cut or grey out the unheard part of that line. Found in the Session 3a spike.
