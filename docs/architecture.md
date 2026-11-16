# How Ping is built

## The short version

Ping is three things:
1. **A small Node server** on Render. It decides when to call, rings the phone with a web push, hands out one-minute OpenAI keys, and keeps each user's progress in one JSON file.
2. **A phone web app** (a PWA). It rings, runs the call, and shows Home, Contacts, My Stack and Settings.
3. **OpenAI's speech-to-speech model**, `gpt-realtime`. The phone talks to it directly over WebRTC.

The live call goes from the phone straight to OpenAI. After each recorded call, the phone uploads the recording and transcript to Ping's server for review.

```
            ┌───────────── Render (one instance, 1 GB disk) ─────────────┐
            │  server/index.js  HTTP API, no framework                    │
            │  calls.js  schedule.js  progress.js  stack.js  contacts.js  │
            │  prompt.js persona.js lines.js   tutor.js (session + tools) │
            │  openai.js (only file holding the key)    push.js           │
            │  store.js → data/ping.json                                  │
            └──────┬───────────────────────┬─────────────────────▲────────┘
          web push │        one-minute key │ after each call:    │
           "ring"  ▼                       ▼ timing numbers, and │ the recording + transcript
            ┌──────────────────── the phone (PWA) ───────────────┴────────┐
            │  sw.js  rings and missed calls (works with the app closed)  │
            │  app.js  screens · voice.js  the call                       │
            │  smart-turn.js + models/  on-device turn detection          │
            │  turn-metrics.js  per-call numbers                          │
            └──────────────────────────┬──────────────────────────────────┘
                                       │ WebRTC: audio both ways + events
                                       ▼
            ┌────────────── OpenAI Realtime ──────────────────────────────┐
            │  gpt-realtime: hears audio, thinks, speaks audio             │
            │  gpt-transcribe: writes down what the user said (side job)   │
            └──────────────────────────────────────────────────────────────┘
```

## A call, step by step

| Step | What happens | Where |
| --- | --- | --- |
| 1. Schedule | A random time inside the user's call hours, on the days their frequency allows, in their time zone | `server/schedule.js`, `server/calls.js` (one-second tick) |
| 2. Ring | A web push. The phone re-alerts every 2.5 s for 10 s. With the app open, it also shows a ring screen and plays a ringtone | `server/push.js`, `public/sw.js`, `public/ringtone.js` |
| 3. Missed | No tap within 10 s means a missed call, a voicemail on Home (spoken by `gpt-4o-mini-tts`) and a call-back button | `server/calls.js`, `server/openai.js` |
| 4. Connect | The phone gets a one-minute key from the server and opens WebRTC straight to OpenAI. The session carries Ping's instructions, persona, tools, voice, speed and turn-detection settings | `server/tutor.js` `buildSession`, `public/voice.js` |
| 5. Talk | `gpt-realtime` hears the user's audio and replies in audio. Ping's words fade in on screen as they're spoken | `public/voice.js`, `public/reveal.js` |
| 6. Turn-taking | Who speaks when. Each call is randomly assigned an engine and turn mode (silence or Smart Turn today), or an admin picks. Aizuchi over Ping doesn't count as an answer | `server/tutor.js` `turnDetection`, `public/smart-turn.js`, `public/turn-machine.js`, `public/aizuchi.js` |
| 7. Tools | The model calls `add_to_stack`, `update_settings`, `back_to_conversation` and `end_call`. The phone runs them | `server/tutor.js` `TOOLS`, `public/voice.js` |
| 8. End | At the plan's time limit, on goodbye, or when the user ends it. The phone sends timing numbers, and for a recorded call uploads the audio and transcript. The server updates the streak, and on paid plans saves the heard transcript as memory for later calls | `public/turn-metrics.js`, `public/recorder.js`, `server/recordings.js`, `server/calls.js`, `server/progress.js` |

Calling Ping from the app works the same from step 4, after a 3-second "Calling…" ringback.

## Outside the call

- **My Stack:** saved words, and example sentences looked up one word at a time. The server asks the text model, `TEXT_MODEL`, for sentences and kanji breakdowns. Code: `server/stack.js`, `public/stack.js`.
- **Plans:** Free, Premium and Platinum, on a test switch for now with no payments. Limits are in `PLAN_LIMITS` in `server/contacts.js`.
- **Invite codes:** admin, beta and YC, set in the environment. The code a user joins with decides their role.
- **Admin tools:**
  - ring in 10 seconds
  - record calls on the phone
  - switch turn mode
  - an invite-code report
  - an out-of-credit notice

## Files by job

| Job | Server | Phone |
| --- | --- | --- |
| Call lifecycle | `calls.js`, `schedule.js`, `push.js` | `sw.js`, `ringtone.js`, `app.js` |
| The conversation | `persona.js` (who Ping is), `prompt.js` (instructions, by section), `lines.js` (words said exactly), `tutor.js` (tools + session), `openai.js` | `voice.js`, `reveal.js`, `aizuchi.js` |
| Turn-taking | `tutor.js` (`TURN_MODES`, `SMART_TURN_PATIENCE`), `settings.js` (`SLOW_SPEED_PATIENCE`) | `smart-turn.js`, `turn-machine.js`, `features.js`, `capture-worklet.js` |
| Measurement | `index.js` (logs one `turn-metrics` line per call) | `turn-metrics.js` |
| Progress & stack | `progress.js`, `stack.js` | `stack.js`, `app.js` (Home) |
| Plans & contacts | `contacts.js` | `contacts.js` |
| Settings | `settings.js` | `settings.js` |
| Storage | `store.js` (one JSON file) | `localStorage` (account token, per-phone switches) |
| Call recordings | `recordings.js` (files per user), `calls.js` (who's recorded, `POLICY_VERSION`) | `recorder.js`, `settings.js` (Manage Account switch, admin Call recordings page) |

## How we build and ship

```
idea ─▶ plan (docs/) ─▶ branch ─▶ Claude Code session ─▶ npm test ─▶ commit ─▶ your own test calls ─▶ merge to main ─▶ Render auto-deploy
                                         │
                                         └─ phone testing before merge: local server + a temporary cloudflared https link
```

| Environment | How | Notes |
| --- | --- | --- |
| Local | `npm start` → http://localhost:3000 | Push and the mic need HTTPS on a phone |
| Phone, before merge | `cloudflared tunnel --url http://localhost:3000` | The quick-tunnel link changes every time it starts |
| Live | Render, from `main` | One instance only, since all state is one file. Secrets go under Environment on Render |
| Benchmark | `bench/` (Python, `.venv`) | Runs on your computer only. Audio stays local (`bench/audio/` is ignored) |

## Known weak spots

| Risk | Impact | Fix (see roadmap) |
| --- | --- | --- |
| The account lives on one phone's storage | A lost phone or cleared Safari data loses the streak | Real accounts |
| One JSON file on one instance | Can't scale past one server, and a bad write could corrupt everything | A database, once there are real users |
| Call recordings on a 1 GB disk | A few hundred calls fill it, and then saving data fails | Cloud storage for recordings, before many testers |
| The OpenAI key expires after 7 days | Calls go silent | A long-lived key, restricted to the APIs Ping uses |
| No balance warning from OpenAI | Silent calls when credit runs out (admins now get told) | A usage alert and auto-recharge in OpenAI billing |
| Web push can't ring like a phone | Missed calls on iOS when the app is closed | Snooze or call-me-later, and a native wrapper later |
| The time limit is enforced in the browser | A modified page could stay on longer | The server refuses reconnects, and OpenAI's session limit is the backstop |
