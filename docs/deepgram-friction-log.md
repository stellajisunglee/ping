# Deepgram Voice Agent: developer friction log

Notes from building Ping's Deepgram engine, written as a developer meets the platform: what was confusing, what broke, what was great, and what a Japanese language-learning app needs that a typical agent doesn't. Each entry has what happened, why it matters, and what would fix it.

Setup for the first tests (Nov 15, 2026): Node 22's built-in WebSocket to `wss://agent.deepgram.com/v1/agent/converse`, the listen model `flux-general-multi` with `language_hints: ["ja"]`, think through OpenAI `gpt-4.1-mini` managed by Deepgram, a Japanese voice, and a 3.7-second Japanese learner line made with macOS text-to-speech (Kyoko), streamed as 24 kHz linear16.

## Friction

### 1. The Japanese Aura-2 voices reject `speed`, and the failure is noisy

- **What happened:** with `aura-2-izanami-ja` and `speed: 1.0`, the agent sent three `SPEAK_REQUEST_FAILED` warnings ("Requested model does not support the 'speed' parameter"), then a fatal `FAILED_TO_SPEAK`, and closed the connection. Without `speed` it worked.
- **Why it matters:** the docs give Aura-2 a speed range of 0.7–1.5 with no language caveat. Slower speech is central to a learning app; Ping's learners set it, and slow speeds also make Ping wait longer through pauses.
- **What worked:** the Flux TTS Japanese voices (`flux-ayumi-ja`, `version: "v2"`) accept `speed` (tested at 0.85).
- **Would fix it:** say on the voices page which voices support `speed`, or reject it at `Settings` time with one clear `INVALID_SETTINGS` error instead of three warnings and a fatal one. The Aura-2 `-ja` voices are also missing from the Settings reference's voice list, though the TTS models page lists them.

### 2. Minting a browser token needs a role the error doesn't name

- **What happened:** `POST /v1/auth/grant` with an existing project key returned `403 {"err_code":"FORBIDDEN","err_msg":"Insufficient permissions."}`.
- **Why it matters:** Ping's phones connect to voice engines directly, so audio never touches Ping's server. That needs a short-lived token per call. The docs say the key needs Member permissions or higher, but the error doesn't say which permission is missing.
- **Would fix it:** name the required role or scope in the 403.

### 3. How a browser passes the token to the agent socket isn't documented

- **What happened:** browsers can't set an `Authorization` header on a WebSocket, so the token has to travel as a subprotocol. The docs show `Sec-WebSocket-Protocol: token, <key>` for Listen and Speak, but not for the Voice Agent. The Browser Agent SDK page says the token goes in a subprotocol "handled internally", and the SDK source passes `Authorization: Bearer <token>` through a client whose browser behavior isn't visible.
- **Resolved (Nov 16):** with a Member-level key, `new WebSocket(url, ['bearer', token])` connects; `['token', token]` is refused. One line in the docs would have saved the experiment.
- **Would fix it:** one line on the token-auth page with the exact subprotocol for `/v1/agent/converse`.

### 4. The docs disagree with each other in places

- `audio.input.sample_rate` default: 16000 on the configure page, 24000 in the reference (Ping sets it explicitly).
- `KeepAlive` interval: every 8 seconds in the docs, 10 in the SDK.
- Allowed OpenAI think models: 19 on the LLM models page, 8 in the Settings reference.
- **Would fix it:** generate the guides' tables from the same schema as the reference.

### 5. The transcript drops fillers, which a learning app needs

- **What happened:** the learner said 「えーと、週末は、友達と映画を見ました。」 The user `ConversationText` came back as 「週末は友達と映画を見ました。」, without えーと.
- **Why it matters:** for most agents, dropping fillers is a feature. For language learning they're signal. Fillers show a learner holding the turn while thinking (the behavior that should *prevent* cut-offs), and they're one of Ping's planned measures of progress. A cleaned transcript can also hide learner mistakes.
- **Would fix it:** a documented option to keep disfluencies, like Nova's filler-word option, for the agent's listen provider too, at least in the transcript events even if the LLM gets the clean version.

### 6. Start-of-speech detection looked slow (to verify)

- **What happened:** `UserStartedSpeaking` arrived about 1.6 seconds after the learner audio began streaming.
- **Why it matters:** that event is the barge-in signal. If it's late, Ping keeps talking over the learner.
- **Status:** may be the synthetic audio (text-to-speech can start with silence). Re-test with real speech before drawing a conclusion.

### 7. Mid-call updates: one confirms, the speed barely changes

- `UpdateListen` (Flux's patience) is confirmed with `ListenUpdated`, and `UpdateSpeak` with `SpeakUpdated`. Neither shape is spelled out on the pages I read; I sent `{type, listen}` and `{type, speak}` and checked the confirmations live.
- The same Japanese line took 4.96 s at speed 1.0 and 5.52 s at 0.7: about 11% slower, where 0.7 suggests about 30%. For learners who ask Ping to slow down, that may not be enough. Worth testing by ear, and asking whether the voice can go slower.

### 8. No way to steer one reply mid-call

- On OpenAI, Ping adds a one-off instruction before a reply (for example "time is nearly up, say goodbye", or "carry on from where you were cut off" after an aizuchi). The Voice Agent has `InjectAgentMessage` (say these exact words) and `UpdatePrompt` (change the whole prompt), but nothing like "for the next reply only, do this". So Ping's time-limit goodbye is a fixed line, and the aizuchi carry-on rule can't work here.
- **Would fix it:** a one-turn instruction message, or a documented "append to prompt" behavior for `UpdatePrompt`.

### 9. A reply's audio can arrive before its words

- In a browser call, the second reply's first audio frames arrived just before its `ConversationText`. A client that ties the transcript to the voice (Ping fades each line in as it's spoken) has to expect either order. Not mentioned on the pages I read.

### 10. Text frames must be JSON messages, and the error doesn't say which one

- A bug of mine sent microphone audio as a text frame (`{}`) instead of binary. The agent replied with a fatal `UNPARSABLE_CLIENT_MESSAGE` ("Text message received from client did not match any of the formats we expect") and closed. Fair, but echoing the message's first bytes or its `type` would have pointed straight at the cause.

## What was great

- **Japanese worked first time** with `flux-general-multi` and `language_hints: ["ja"]`, and the transcript was accurate (`languages: ["ja"]` on the user message).
- **Fast replies:** the turn ended about 0.8 s after the learner stopped (with `eot_threshold: 0.8`), and the agent started speaking about 0.6 s after that: 0.51 s to think, 0.06 s to start speaking. That's roughly 1.4 s from the learner stopping to Ping talking, inside the range Ping's Smart Turn mode gets (0.9–1.5 s) and faster than its silence mode (1.9–2.3 s).
- **`AgentStartedSpeaking` breaks latency into parts** (`total_latency`, `ttt_latency`, `tts_latency`). That's exactly what a latency budget needs, though it requires `experimental: true` in `Settings`.
- **`greeting`** makes "the agent speaks first", which every phone-call app needs, a one-line setting.
- **`EndOfTurn` and `EndOfThought`** events make turn timing measurable without guessing.
- **A full call worked in a real browser (Nov 16):** Ping's greeting, the learner's line transcribed correctly, Ping's reply about 1.1 s after the learner finished, and the transcript and voice in sync. The microphone was a recorded line fed in as a fake microphone, because the test browser blocks real ones; a phone test is still to come.

## Open questions for the build

- Which `eot_threshold` and `eot_timeout_ms` match Ping's "time to answer" (short, normal, long)? The benchmark's patient setting (0.85 and 8 s) cut off 17% of thinking pauses on one speaker.
- Does Flux's end-of-turn treat Japanese sentence endings (です, ね, よ) differently from mid-sentence particles? Test with the labeled pauses in `bench/`.
- How should Ping's speed setting map to the Flux voice's `speed` (0.5–1.5)?
