# Ping

An app that calls you to practice speaking Japanese. Ping, an AI friend, phones you at a random time and asks an open-ended question. It's a web app you install on your phone. The voice runs over WebRTC and the "phone call" arrives as a web push notification.

## Run it

```bash
npm install
npm run setup
```

`npm run setup` creates a `.env` file with push keys. Add your `OPENAI_API_KEY` and an `ADMIN_INVITE_CODE` of your choice to that file, then:

```bash
npm start
```

Open http://localhost:3000 and join with an invite code (see "Admins and beta testers").

```bash
npm test
```

Browsers only allow push and the microphone on `localhost` or HTTPS, so testing on a phone needs the deployed HTTPS site.

Pages are served "cross-origin isolated" (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`), which Smart Turn needs to run on several threads. A side effect: the app can't load images, scripts or fonts from other sites unless they explicitly allow it. Today it loads nothing from other sites.

## How a call works

1. Each user gets a call at a random time inside the hours they set, on the days their call frequency allows. The default is daily, between 10:00 and 20:00 in their time zone.
2. The server sends a push and the phone shows "Ping is calling". The phone confirms the push arrived, and that starts the 10 seconds. The phone rings again every 2.5 seconds until then. Each ring is a new notification that replaces the last, because an iPhone only plays the notification sound for a new one. If the app is open, it shows a ringing screen and plays a ringtone (`public/ringtone.js`). iPhones only play web audio that a tap started, so the app prepares its audio on the first tap anywhere and rings through it later. The ringtone follows the phone's silent switch. A web app can't play its own ringtone when it's closed or in the background, so then the iPhone's notification sound is all there is.
3. Tapping the notification answers. The browser gets a one-minute key from the server and connects straight to OpenAI over WebRTC. When the contact calls, it greets the user and first asks if it's a good time (「今、お時間大丈夫ですか？」, or 「今、話せる？」 when casual). If yes, it asks the question. If not, it says out loud that it'll call another time, and only then hangs up (every contact, Ping or custom, is told to say the goodbye before ending the call); the phone also hangs up after hearing that goodbye even if the voice engine forgets to. When the user calls, the contact thanks them for calling and goes straight to the question. Calls stop at the plan's longest call (see "Plans").
4. If nobody taps in 10 seconds, the call is missed. The notification changes to "Missed call", and a voicemail with a call-back button appears on Home.
5. If the phone never confirms the push, for example because it's offline, the call counts as missed after 30 seconds.

Tapping after the 10 seconds opens the voicemail, with the call-back button.

After a call that connected, one page asks two quick questions, each answered with one tap from 1 to 5: how often Ping cut you off (1 never, 5 all the time), and how natural it felt (1 not at all, 5 like a real conversation). Done saves both; Skip saves nothing. They're stored as numbers with the account (`ratings`, the latest 200), logged as one `call-rating` line per call, and shown beside a recorded call on the admin Call recordings page.

Calling a contact from Contacts or the voicemail rings for 3 seconds first ("Calling…", with Japan's ringback tone), then the call connects. Ending it while it rings cancels it before anything starts.

On a call, the contact can explain a word in one short English sentence and save it to the user's stack, however the user asks ("what does X mean?", "what do you mean by X?", 「Xってどういう意味？」), even when the transcript misspells the word. Repeating the contact's word back as a question (「忙しい？」 right after it said 忙しい) counts as asking what it means, not as a question about the contact's day. If a word can't be saved, the contact is told why so it can try again with the word written properly. The contact never asks the same question more than twice in a row, and answers what the user asked first. It can also translate what it just said into English when the user didn't understand it (then ask again in simpler Japanese, never repeating the same sentence), and answer a question asked in English about Japanese language or culture in one or two short sentences. That includes "how do you say...?", which also saves the word, and it works even when the question is off the contact's topic. The answer comes as its own message, and the contact then picks the conversation back up in Japanese as a second message. The contact can also nudge the user back to Japanese when they say anything else in English, say 「ちょっとわかりません」 if they steer off topic, and change settings when asked in plain English. The screen shows a live transcript with `*added to stack*` for each new word (or `*already in your stack*` when it was saved before), and buttons for speaker, mute, speed and end call. The contact's words fade in as they're said, not when the text arrives. OpenAI writes a reply in about a second but takes several seconds to say it, and over WebRTC it sends no timing for single words, so the app paces the text from the speed setting and from how long earlier replies took to say. When the user cuts the contact off, OpenAI reports how much audio was heard, and the line is cut to about that point and ends with "…". A paid plan saves only what was heard.

Ping has a life of her own, so asking 「元気？」, 「今、何してる？」 or 「明日の予定は？」 gets a real answer, like a friend's. She's 25, lives in Setagaya, Tokyo, with タロウ (Taro), her orange-and-white cat, grew up in Kanagawa, studied sociology, and works part-time as a barista at 喫茶こもれび. Her personality is in every call's instructions: warm, curious, observant, opinionated and a little sarcastic, though she only ever teases herself, タロウ or the situation, never the learner's Japanese, and drops it when they're struggling. She calls herself 私, uses natural fillers, and speaks friendly です/ます on formal calls and タメ口 on casual ones. Each day of the week has its own plan, picked by the user's date, and a few small stories run through the week from Monday to Sunday (a new drink at the café, a photo zine, a trip home to Kanagawa). It's the same week for everyone, not a memory of any user, so Ping doesn't talk as if the learner already knows it. The call is told, on the user's clock, which parts of Ping's day are done (with a small thing that happened), what she's doing now, what she plans for later, and tomorrow's plans, so every call on the same day tells the same story and Ping never says how a plan turned out before it happens. A call before 5:00 still belongs to the night before. Ping keeps the focus on the user, says honestly that she's an AI if asked, and when the talk turns to something she doesn't know, like investing, she says so warmly instead of making anything up. Her facts, personality and week are in `server/persona.js`, and the instructions built from them in `server/prompt.js`. Custom contacts get none of this: they make up small details that fit their topic.

OpenAI stops the contact's audio as soon as the user makes a sound, and the app, not OpenAI, decides when the contact replies. If the user talked over the contact with only aizuchi, like うん or はい, the app waits for the transcript (usually under half a second), then has the contact carry on from where it was cut off instead of answering. Anything else, or a transcript that doesn't arrive within 1.5 seconds, gets a normal reply.

**Engines and turn detection, randomized per call.** Every call is assigned an engine and a turn detection mode when it first connects, at random but balanced per person: each call goes to the combination that person has had least (`comboCounts` on the account), so even a few calls each compare fairly. A reconnect keeps the same assignment. The random mix is the beta's four-way comparison: OpenAI `gpt-realtime` with silence, with Smart Turn and with semantic turn detection, and Deepgram's Voice Agent (`RANDOM_MIX` in `server/experiment.js`). A new caller gets each of the four once in their first four calls; someone who already had calls gets semantic until it catches up. If the server has no `DEEPGRAM_API_KEY`, Deepgram is left out of the mix. If Deepgram refuses a call token, that call falls back to `gpt-realtime` with silence (`FALLBACK_COMBO`), and the call log marks it `fallback`; an admin who picked Deepgram themselves sees the error instead. Admins can turn on "Choose them myself" in Manage Plan and pick an engine and turn mode for their own calls; those calls are marked `manual` and don't count toward the balance. Manage Calls tells everyone that conversations may feel different from call to call. New engines (gpt-live-1, Pipecat) join `ENGINES` once built, and the mix only after a few admin test calls and a Privacy Policy update naming the new company. Engines that decide turns themselves have no turn mode, so theirs is blank.

The **call log** keeps one entry per call that connected (`callLog` in the data file, the latest 5,000): the account's invite code and id, when, the engine, the turn mode it was assigned and the one it actually ended in (Smart Turn can fall back to silence), whether it was random or manual, and how it went: length, gap before replies, wait after the user stopped, suspected cut-offs, barge-ins, ignored aizuchi, turns, and the user's two ratings. Numbers and ids only. Admins see it under Settings, Admin tools, Call log (`GET /api/admin/calls` has every field). Deleting an account removes its entries.

So calls stay comparable after the full call record is removed (7 days), each entry also keeps:
- **The call:** `contactId`, `questionId`, and `endReason`, the first reason the phone reported (missing if it never reported one, for example when the app was closed).
- **Settings as the call started:** `proficiency`, `formality`, `thinkingTime`, `speed`. A change made during the call, or a reconnect, doesn't rewrite them.
- **Build:** `buildCommit`, from Render's `RENDER_GIT_COMMIT`; null where it isn't set, like a laptop.
- **Prompt:** `promptVersion` (`PROMPT_VERSION` in `server/prompt.js`). Raise it whenever what a contact is told changes; `tests/instructions-snapshot.test.js` fails until you do.
- **What the engine was actually sent,** from the call's first session (`callConfig` in `server/experiment.js`):
  - OpenAI: `realtimeModel`, `transcriptionModel` (null if the session had to start without one), `voice` (a custom contact's own voice), `voiceSpeed`, and turn detection: `turnDetection` (`server_vad` or `semantic_vad`), `silenceMs` or `eagerness`, and on Smart Turn calls `smartTurnDoneAt` and `smartTurnBackupMs`.
  - Deepgram: `thinkModel`, `listenModel`, `voice`, `voiceSpeed`, and `turnDetection` `flux` with `eotThreshold` and `eotTimeoutMs`.
  - Fields that don't apply to the engine are null. A call that never got a session that started (Deepgram refused a manual call, say) has none of them.
- **A fallback:** `fallbackFromEngine`, `fallbackFromTurnMode` and `fallbackFromAssigned` keep what it was first assigned, beside the engine it actually ran on.

Entries from before these fields simply don't have them.

**Deepgram Voice Agent.** A second engine, `deepgram-agent`, built differently from OpenAI's speech-to-speech model: Deepgram Flux (`flux-general-multi`, hinted Japanese and English) hears the learner and decides when their turn is over, an OpenAI model run by Deepgram (`DEEPGRAM_THINK_MODEL`, default `gpt-4.1-mini`) writes the reply from Ping's same instructions and tools, and a Japanese Flux voice (`DEEPGRAM_VOICE`, default `flux-ayumi-ja`) speaks it.
- **Connecting:** the server mints a 30-second Deepgram token per call (the key needs Deepgram's Member role) and sends the agent settings (`server/deepgram.js`). The phone connects straight to Deepgram with the token as the `bearer` WebSocket subprotocol, streams the microphone as 16 kHz 16-bit audio through the same worklet Smart Turn uses, and plays Deepgram's 24 kHz audio through the call's `<audio>` element, so the speaker button and recording work (`public/deepgram-call.js`).
- **Turns:** Flux's patience follows "time to answer" (`FLUX_PATIENCE`: how sure Flux must be the learner is done, and the silence that ends the turn anyway); the voice's speed follows the speed setting. Both update mid-call. These calls have no turn mode, so it's blank in the call log.
- **What's different from OpenAI calls:** Deepgram speaks the greeting itself; near the time limit the phone has it say a fixed goodbye (`TIME_UP_LINES`), because Deepgram can't take a mid-call instruction; there's no aizuchi carry-on rule or Smart Turn; transcripts come without fillers like えーと; and the timing numbers can't tell when the learner actually went quiet, only when Flux ended the turn.
- **Rollout:** in the random mix for everyone since Nov 16, after the Privacy Policy named Deepgram (version 3). Admins can also pick it with "Choose them myself". What building on it was like: `docs/deepgram-friction-log.md`.

**Smart Turn mode.** The phone, not OpenAI, decides when the user has finished talking:
- A call starts in silence mode while the phone loads Smart Turn, about 12 MB the first time and from the phone's cache after that. Once Smart Turn is loaded and hearing the microphone, the app switches OpenAI's own turn detection off.
- Silero, a small voice detector, hears when the user starts and stops talking. After 0.2 seconds of quiet, Smart Turn v3.2 listens to the last 8 seconds and decides whether they've finished. If it says yes, the app ends the turn straight away. If it keeps saying "still thinking", the turn ends after 2.5 seconds of quiet anyway. On a `long` time to answer, Smart Turn has to be surer (a score of 0.7 instead of 0.5) and the backup waits 4 seconds.
- When the user talks over the contact, the app stops the contact's audio itself, and OpenAI trims the reply to what was heard. The aizuchi rule above works the same way.
- If the phone pauses the microphone audio Smart Turn hears, which iOS can do when the audio output changes, the app restarts it. If the models can't load, the audio stays stopped for 3 seconds, or Smart Turn decides too slowly (twice over 0.6 seconds, or once over 1.5), the call switches back to silence mode. The call's numbers record why (`smartTurnFallback`: 1 couldn't load, 2 too slow, 3 audio stopped) and how many restarts there were (`audioRestarts`).

On a benchmark of the developer's own speech, Smart Turn with the 2.5-second backup cut off thinking pauses about 14% of the time, against 33% for the 1.3-second silence rule, and usually noticed a finished answer within a quarter of a second. On an iPhone, each decision took about 230 ms. See `bench/` and `docs/turn-taking-plan.md`.

## Progress and My Stack

Home is the first screen after joining:
- **A greeting from the contact,** by the time of day: 「おはよう！」, 「こんにちは！」 or 「こんばんは！」, with the English underneath.
- **A "Call Ping now" button,** which calls whoever calls the user, under their call schedule.
- **The streak and this week,** Sunday to Saturday: a tick for each day with a connected call, 休 for days off in the schedule, and the best streak. Days still to come are empty.
- **The last call,** if one connected in the past week: when, how long, and how many words it saved, with a button to see them.
- **My Stack's Words and Sentences buttons,** with how many of each. Empty, they say how to fill them.

- **Streak:** days in a row with a connected call, answered or called back. Days off in the user's schedule don't break it. Home also shows the all-time best. The server keeps the last 14 practice days as day numbers, for Home's week. Streaks from before that are filled in from their count.
- **Words:** words the user didn't understand, saved by the voice model. Each plan keeps the latest ones up to its limit (25 on Free, 100 on Premium, no limit on Platinum), replacing the oldest. Anyone can remove a word.
- **Sentences:** example sentences, looked up one word at a time and stored only if the user saves them, on any plan. They have their own limit, the same number as words. Each shows its Japanese, romaji and English translation, like a word. Sentences saved before romaji was added show without it. Swipe left to remove. Tapping a sentence lists the words in it that have kanji, each with its reading, romaji and meaning, as written in the sentence and in dictionary form (食べに → 食べる). Any of them can be added to Words, which follows the same plan limit, so a full list drops its oldest word. The list is looked up the first time a sentence is opened and kept with the sentence after that.

## Plans

Plans are a test switch under Settings for now, with no payment. Only admins can use it. The limits are `PLAN_LIMITS` in `server/contacts.js`, and the app reads them from the server, so the plan page always matches what's enforced.

| | Free | Premium | Platinum |
| --- | --- | --- | --- |
| Calls a day, Ping's included | 1 | 3 | 5 |
| Longest call | 3 minutes | 5 minutes | 10 minutes |
| Saved words, and saved sentences | Latest 25 of each | Latest 100 of each | No limit |
| Contacts | Ping | Ping, plus more as they're added | Also create your own |
| Calls remember past conversations | No | Yes | Yes |

How the day's calls work, in the user's time zone:
- On a day Ping's scheduled call comes (it rang today, or it's set for later today), one of the day's calls is kept for it, so the user can make one fewer themselves: none on Free, 2 on Premium, 4 on Platinum. Ping's call always comes. On a day it doesn't call, the user can make all of them.
- Missing or declining a call lets the user call back once, and that call back doesn't count.
- A new account's first call doesn't count either, so someone can try Ping before its first call.
- A call that breaks within 30 seconds of connecting, or before it connects (it dropped, failed, or the contact couldn't talk), gives one call that doesn't count, at most twice a day. Hanging up or the contact ending the call always counts. The phone reports why each call ended, and the server measures the time itself (`RETRY_WITHIN_SECONDS` and `MAX_RETRIES_PER_DAY` in `server/calls.js`).
- `DAILY_CALL_LIMIT`, if set, is a safety net on top: the most calls a user can start in a day, call backs included.
- Admins and YC reviewers can call as often as they like, past both the plan and `DAILY_CALL_LIMIT` (`unlimitedCalls` in `server/calls.js`). Each call still lasts only as long as their plan allows.

Home and Contacts show how many calls are left today and how long calls last on the plan. Manage Calls, for call times and how the contact talks, is at the bottom of Contacts. The user's plan shows as a badge at the top right of Home (tapping it opens the plan page) and in the upgrade note on Contacts. A call's time limit runs from its first connection, so reconnecting doesn't restart it.

Moving to a smaller plan starts a 30-day window, shown on Home and the plan page, during which nothing is removed. After it, the stack keeps the newest words and sentences up to the new plan's limit, and on Free saved conversations are removed. Upgrading in time cancels it.

Mero is hidden for now, and Contacts shows it greyed out as "Coming soon". To bring it back, give it a topic and remove `hidden` in `server/contacts.js`.

## Admins and beta testers

The invite code someone joins with decides which version they get. It can't be changed later without deleting the account and rejoining.

| | Admin | Beta tester |
| --- | --- | --- |
| Invite code | `ADMIN_INVITE_CODE` | `BETA_INVITE_CODE` |
| Plan | Can switch freely | Stays on Free |
| "Ring my phone in 10 seconds" (Settings, Admin tools) | Yes | No |
| Record calls on this phone (Settings, Admin tools) | Yes | No |
| Calls recorded for review (see "Call recordings") | Always | Always. YC reviewers can turn it off |
| Call recordings page (Settings, Admin tools) | Yes | No |
| Calls a day | No limit | The plan's limit |
| Engine and turn detection | Randomized per call, or "Choose them myself" on the plan page | Randomized per call |
| Call log (Settings, Admin tools) | Yes | No |
| OpenAI out of credit, or the contact can't talk | The call screen says why, with where to add credit when it's credit, then the call ends | The call screen says "Ping can't talk right now. Please try again later." (with the contact's name), then the call ends. No billing details |

The server enforces both limits. Accounts created before there were two codes are admins.

A third code, `YC_INVITE_CODE`, is for YC reviewers. It gives the beta tester's version, so no admin settings, but on Premium instead of Free, with no limit on calls a day, and its accounts are counted separately. Reviewers start with 4 example words and 3 example sentences in their stack (`STARTER_STACK` in `server/stack.js`), so the stack isn't empty when they first look. Like other beta testers, reviewers can't change their plan. Which plan each code starts on is `PLAN_FOR_CODE` in `server/index.js`. Codes aren't case-sensitive.

Admins see "Invite codes" at the bottom of the plan page (Settings, then Upgrade Plan or Manage Plan). For each code it shows how many accounts joined, how many made a call, how many calls connected in all, and the 20 newest accounts with when they joined, their calls and their words. Joining is what creates an account, so each account is one phone or browser, and someone who deletes their account and rejoins counts twice. Codes and call counts are only recorded from this version on, so older accounts show "before this was tracked".

**Recording calls (admins only).** iPhone screen recordings go silent once a call opens the microphone: the phone switches to its voice-call audio mode, and screen recording leaves that out, as it does for FaceTime. So with "Record calls on this phone" on, the app mixes the microphone and the contact's voice in the browser and records them with `MediaRecorder` (`public/recorder.js`): .m4a on an iPhone, .webm elsewhere. After the call, "Save last call's recording" in Settings opens the share sheet, or downloads the file where there isn't one. The recording is only in the phone's memory: nothing is uploaded, the next recorded call replaces it, and closing the app loses it. For a demo video, screen record the call too and line the two up; the ring in the screen recording marks where the call starts. The switch is kept per phone, in `localStorage`.

## Call recordings

Calls are recorded so the Ping team can listen to them and read their transcripts, to improve Ping's conversations.

- **Who's recorded:** every account, from the call's first connection. Admin and beta tester accounts always are, as part of testing. YC reviewers and any future accounts can turn off "Use my calls to improve Ping" in Manage Account. That stops recording calls that start after it, and keeps calls already recorded. Whether a call is recorded is decided once, when it first connects (`call.recorded`), and the server refuses uploads for any other call.
- **How:** the phone records both voices with the same recorder admins use for demo videos (`public/recorder.js`). After the call it uploads the audio (`POST /api/calls/:id/recording`, .m4a from an iPhone or .webm, up to 25 MB) and the transcript (`POST /api/calls/:id/transcript`, the same request paid plans already send). The transcript is what was heard: a line Ping was cut off in ends where it stopped.
- **Where:** files on the server's disk, outside the main JSON store: `DATA_DIR/recordings/<user id>/<call id>.json` (who, when, which contact, turn mode, length, transcript) and `.m4a` or `.webm` beside it (`server/recordings.js`).
- **How long:** until the user deletes their account, which deletes their recordings too. Nothing removes them automatically.
- **Listening:** admins open Settings, Admin tools, Call recordings. Each call shows the account kind (admin, beta tester or YC reviewer) and the first characters of its account id, and opens to a player and the transcript.
- **Telling users:** the join screen says calls are recorded, and the Privacy Policy and Terms say how. When the policy changes in a way that affects people, raise `POLICY_VERSION` in `server/calls.js`: accounts that saw an older version get a one-time card on Home about what changed (`policyNoticeFor`). Version 2 is call recording; version 3 names Deepgram beside OpenAI. Someone who never saw version 2 gets the recording card, which points to the full policy; someone who did gets a short "Privacy Policy updated" card.
- **Space:** a 3-minute call is about 1.5–3 MB, so Render's 1 GB disk holds a few hundred calls. Move recordings to cloud storage before there are many testers.

OpenAI's docs don't say how a Realtime call reports running out of credit, so the app treats any call error, failed reply or refused connection whose type or code mentions "quota" or "credit" as out of credit. Two failed replies in a row, for any reason, also mean the contact can't talk (one is retried). Either way the call screen shows the notice for three seconds before the call ends (`public/voice.js`). The app has no documented way to read the remaining balance, so it can only tell once credit has run out, not when it's running low. For that, set a usage alert or auto-recharge in OpenAI's billing settings.

## Limits of web push

- There's no ringtone or full-screen call screen when the app is closed. The call is a normal notification, with whatever sound and vibration the phone gives notifications, repeated during the 10 seconds where the phone allows it. The in-app ring screen, ringtone and vibration only appear when the app is open, and iPhones don't allow web apps to vibrate.
- The speaker button only works where the browser lets a page choose the audio output. Where it can't, the call screen says so.
- iPhones need iOS 16.4 or later, and the app must be added to the Home Screen. The app walks users through this. iOS ignores the Answer and Decline notification buttons, so users tap the notification itself.
- Do Not Disturb and Focus modes can hide or delay calls.

## Settings

Set these as environment variables, in `.env` locally or under the service's **Environment** tab on Render. Never commit them.

| Setting | What it does | If it's not set |
| --- | --- | --- |
| `OPENAI_API_KEY` | Powers calls and the voice message | Calls and voice messages don't work. The message still shows as text |
| `ADMIN_INVITE_CODE`, `BETA_INVITE_CODE`, `YC_INVITE_CODE` | The codes people need to join. Don't reuse the built-in codes older versions had, since they're in this repo's history | No one can join with that code. With none set, no one can join at all |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Sign the push notifications. Changing them breaks every existing subscription until the user reopens the app | The server won't start |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact for push services | Uses the Render URL |
| `DATA_DIR` | Where user data and the voice message are stored | `./data` |
| `REALTIME_MODEL` | The voice model | `gpt-realtime` |
| `REALTIME_VOICE` | Ping's voice | `marin` |
| `TEXT_MODEL` | Writes example sentences and lists a sentence's kanji words | `gpt-6-luna` |
| `DEEPGRAM_API_KEY` | Deepgram's Voice Agent engine. Needs the Member role or higher, to mint call tokens | Deepgram calls say Deepgram isn't set up |
| `DEEPGRAM_THINK_MODEL`, `DEEPGRAM_VOICE` | The model that writes Deepgram calls' replies, and their voice | `gpt-4.1-mini`, `flux-ayumi-ja` |
| `DAILY_CALL_LIMIT` | How many calls a user can start per day, including test rings. Admins and YC reviewers aren't limited | No limit |

Other rules:

| Rule | Value | Where to change it |
| --- | --- | --- |
| Ring time | 10 seconds | `RING_MS` in `server/calls.js` |
| Default call hours and frequency | 10:00 to 20:00, daily | `DEFAULT_SETTINGS` in `server/settings.js` |
| Free word limit | 25 | `FREE_WORD_LIMIT` in `server/stack.js` |
| Calls a day, longest call and saved items per plan | Free 1, 3 min, 25; Premium 3, 5 min, 100; Platinum 5, 10 min, no limit | `PLAN_LIMITS` in `server/contacts.js` |
| Cancellation window | 30 days | `CANCEL_WINDOW_MS` in `server/calls.js` |
| Lookups per user per day (example sentences and a sentence's kanji words together) | 50 | `MAX_LOOKUPS_PER_DAY` in `server/calls.js` |
| Extra pause time at slow speeds | | `SLOW_SPEED_PATIENCE` in `server/settings.js` |
| Engines, and which engine and turn mode combinations calls are randomized across | `gpt-realtime` with silence, with Smart Turn and with semantic, and Deepgram's Voice Agent (only when `DEEPGRAM_API_KEY` is set) | `ENGINES`, `RANDOM_MIX` and `FALLBACK_COMBO` in `server/experiment.js` |
| `turnMode`: how Ping decides the user has finished talking | `silence` (OpenAI's `server_vad`), `semantic` (`semantic_vad`) or `smartTurn` (Smart Turn on the phone) | `TURN_MODES` and `SEMANTIC_EAGERNESS` in `server/tutor.js` |
| Smart Turn's timings: quiet before asking, the backup, and what counts as too slow | 0.2 s, 2.5 s, 0.6 s | `TURN` and `SLOW_DECISION_MS` in `public/turn-machine.js` |
| Smart Turn's score and backup per time to answer | short 0.5 and 2 s, normal 0.5 and 2.5 s, long 0.7 and 4 s | `SMART_TURN_PATIENCE` in `server/tutor.js` |
| Default speed and allowed range | 1.0, from 0.6 to 1.5 | `server/settings.js` |
| Questions and how contacts behave | | `server/lines.js` (questions, greetings), `server/prompt.js` (instructions), `server/persona.js` (Ping's life) |
| Contacts and voices | | `server/contacts.js` |

In semantic mode, "Time to answer" sets how eager OpenAI is to reply instead of a silence length. `normal` and `long` currently behave the same there, because `low` is the lowest eagerness level. In Smart Turn mode it sets how sure Smart Turn must be and how long its backup waits, as well as the silence it falls back to.

The hang-up at the time limit runs in the browser, so someone who modifies the page could stay on longer in a call that's already connected. The server still won't reconnect it past the limit. OpenAI's own session limit is the backstop. Set a monthly budget in your OpenAI account too.

## Before beta launch

Ping is still a prototype, so do these before inviting testers:

- Set `DAILY_CALL_LIMIT` on Render. It's off for prototyping, so any invited user can currently run up the OpenAI bill. 6 is a reasonable starting point.
- Replace the 7-day OpenAI key with a longer-lasting one limited to the Realtime and text-to-speech APIs. Calls stop working when a key expires.
- Set a monthly budget in your OpenAI account, and check that auto-recharge is set the way you want.
- Before sharing the beta code, finish the first three items above, because every tester's calls spend your OpenAI credits.
- Set `ADMIN_INVITE_CODE`, `BETA_INVITE_CODE` and `YC_INVITE_CODE` on Render. There are no defaults, so no one can join without them.
- Replace the plan test switch with real payments, and remove the `PUT /api/plan` route.
- Have the draft Privacy Policy and Terms of Service in `public/index.html` reviewed by a lawyer, especially the call recordings. They're written for adults in the US only. Testers anywhere else need a different policy first (for example GDPR in the EU and UK).
- Move call recordings off the Render disk to cloud storage, which also needs adding to the Privacy Policy's list of companies that handle them.
- Add real accounts in onboarding. An account currently lives on one phone, so losing the app's storage loses access to it.

## Deploy on Render

Use **New > Blueprint** and point it at this repo. `render.yaml` sets up a web service with a 1GB disk, which costs extra on top of the instance. Run `npm run setup` locally and copy the values from `.env` into the prompts Render shows. Run exactly one instance, since all state is in one file on that disk.

## Privacy

Ping is for adults in the US, and the Privacy Policy and Terms in the app are drafts written for US users only.

- During a call, audio goes directly from the browser to the call's voice engine: OpenAI, or Deepgram (whose agent sends the transcript to an OpenAI model to write replies). Ping's server doesn't take part in the live call. The Privacy Policy names OpenAI, Deepgram and Render as the companies that handle calls.
- **Calls are recorded.** After each recorded call, the phone uploads the recording (both voices) and the transcript to Ping's server, where only admins can listen to them. They're kept until the user deletes their account. See "Call recordings". They're never sold, shared, or used to identify or copy anyone's voice.
- At the end of a call, the app also sends timing numbers to the server to measure conversation quality, and the two 1-5 ratings if the user answers them. Both are numbers only.
- In Smart Turn mode, the voice detector and Smart Turn run on the phone, and send no audio anywhere themselves. The call's recording is uploaded as above. Smart Turn adds only the same kind of timing numbers: how many turns Smart Turn or the backup ended, how long decisions and loading took, and whether the call fell back to silence mode.
- Transcripts appear on the call screen. A recorded call's transcript is kept for review on any plan. On a paid plan, the text of the last 20 calls is also stored with the account to personalize later calls. A free-plan call that isn't recorded sends no transcript to the server.
- The server stores each user's time zone, settings, plan, streak (with the day numbers of their last 14 practice days), contacts, stack, push subscription, voicemail list, recent call times, whether they've turned recording off, and which version of the Privacy Policy they've seen, in one JSON file. Calls are deleted from it after 7 days. Recordings are separate files (see "Call recordings").
- There are no names or emails, though a recording can include anything the user says. "Delete my account" removes everything for that user, recordings included.
- Feedback is stored without the sender's account, and also appears in the server logs.
- Contacts say they're an AI if asked, and the join screen says so too.

## How it's built

- `server/calls.js`: the call lifecycle, driven by a one-second tick so a restart picks up where it left off, plus each user's record.
- `server/schedule.js`: picks call times, in the user's time zone.
- `server/progress.js`: streaks.
- `server/stack.js`: the word and sentence banks.
- `server/contacts.js`: contacts, plans and voices.
- `server/persona.js`: who Ping is: her facts, personality, speech style and week (`PING_PERSONA`, `PING_DAYS`). The one place her identity is defined.
- `server/prompt.js`: the voice model's instructions, built from sections in a fixed order, with the turn rules as a list.
- `server/lines.js`: what a contact says word for word: the questions, greetings, goodbyes and voicemail.
- `server/tutor.js`: the voice session: its tools and turn detection. Re-exports the instructions and lines, so callers still import from here.
- `server/settings.js`: what users can change, and the limits.
- `server/openai.js`: the only code that holds the OpenAI key.
- `server/push.js`: sends web pushes.
- `server/store.js`: saves state to one JSON file.
- `server/recordings.js`: call recordings and transcripts, as files outside the JSON store.
- `server/experiment.js`: the engines, and the random mix each call's engine and turn mode come from.
- `server/deepgram.js`: Deepgram call tokens and the agent settings built from Ping's instructions and tools.
- `public/sw.js`: shows the ring and missed call notifications, and handles tapping them.
- `public/voice.js`: the WebRTC call, including running the voice model's tools. A call assigned to Deepgram is handed to `public/deepgram-call.js`, which runs it over a WebSocket with the same callbacks.
- `public/aizuchi.js`: decides whether talking over the contact was only aizuchi, so the contact carries on instead of answering.
- `public/smart-turn.js`: Smart Turn mode on the phone. It loads the WebAssembly runtime and the two models, listens to the call's microphone through `public/capture-worklet.js`, and reports when the user starts talking and when their turn is over.
- `public/turn-machine.js`: the rules Smart Turn mode follows, as plain functions with no browser code, so they're fully tested.
- `public/reveal.js`: estimates how much of the contact's reply has been said, so the call screen shows words as they're spoken.
- `public/features.js`: turns audio into the spectrogram Smart Turn expects, matching the Python feature extractor the benchmark used.
- `public/vendor/` and `public/models/`: third-party files, each with its version in the path and its license next to it. `onnxruntime-web` 1.30.0 (MIT, Microsoft) runs the models. Smart Turn v3.2 CPU (BSD 2-Clause, Daily/Pipecat) is from `pipecat-ai/smart-turn-v3` on Hugging Face. Silero VAD (MIT, Silero Team) is from `snakers4/silero-vad`, as of October 2026. The server compresses them and lets browsers keep them for good, so a new version needs a new path.
- `public/turn-metrics.js`: turns a call's turn-taking event times into numbers, such as reply latency, suspected cut-offs, barge-ins, and an estimate of how long OpenAI waited after the user stopped talking before ending their turn (`turnEndWait`) and the gap the user heard before Ping replied (`replyGap`). The server uses it to check what the phone sends, and logs one `turn-metrics` line per call.
- `public/app.js`: signing up, Home, ringing and the call screen, with no framework or build step.
- `public/stack.js`, `public/contacts.js`, `public/settings.js`: the other screens.
- `public/lib.js`: what the screens share.
- `evals/`: conversation evals. Scripted learner situations played against Ping's real instructions on OpenAI's Realtime model in text, scored by exact checks and a Claude judge, with tools to check the judge against your own labels. Runs only on a developer's computer and needs `ANTHROPIC_API_KEY` in `.env` for the judge. See `evals/README.md`.
- `bench/`: a Python benchmark of end-of-turn detectors on Japanese learner speech. It runs only on a developer's computer and is never deployed. See `bench/README.md`.
- `scripts/build-icons.js`: draws the "ping" logo into `public/icons`.
