# Ping

An app that calls you to practice speaking Japanese. Ping, an AI friend, phones you at a random time and asks an open-ended question. It's a web app you install on your phone. The voice runs over WebRTC and the "phone call" arrives as a web push notification.

## Run it

```bash
npm install
npm run setup
```

`npm run setup` creates a `.env` file with push keys. Add your `OPENAI_API_KEY` to that file, then:

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
2. The server sends a push and the phone shows "Ping is calling". The phone confirms the push arrived, and that starts the 10 seconds. The notification re-alerts every 2.5 seconds until then.
3. Tapping the notification answers. The browser gets a one-minute key from the server and connects straight to OpenAI over WebRTC. When the contact calls, it greets the user and first asks if it's a good time (「今、お時間大丈夫ですか？」, or 「今、話せる？」 when casual). If yes, it asks the question. If not, it says it'll call another time and hangs up; the phone hangs up after hearing that goodbye even if the voice engine forgets to. When the user calls, the contact thanks them for calling and goes straight to the question. Calls stop at the plan's longest call (see "Plans").
4. If nobody taps in 10 seconds, the call is missed. The notification changes to "Missed call", and a voicemail with a call-back button appears on Home.
5. If the phone never confirms the push, for example because it's offline, the call counts as missed after 30 seconds.

Tapping after the 10 seconds opens the voicemail, with the call-back button.

Calling a contact from Contacts or the voicemail rings for 3 seconds first ("Calling…", with Japan's ringback tone), then the call connects. Ending it while it rings cancels it before anything starts.

On a call, the contact can explain a word in one short English sentence and save it to the user's stack, however the user asks ("what does X mean?", "what do you mean by X?", 「Xってどういう意味？」), even when the transcript misspells the word. Repeating the contact's word back as a question (「忙しい？」 right after it said 忙しい) counts as asking what it means, not as a question about the contact's day. If a word can't be saved, the contact is told why so it can try again with the word written properly. The contact never asks the same question more than twice in a row, and answers what the user asked first. It can also translate what it just said into English when the user didn't understand it (then ask again in simpler Japanese, never repeating the same sentence), and answer a question asked in English about Japanese language or culture in one or two short sentences. That includes "how do you say...?", which also saves the word, and it works even when the question is off the contact's topic. The answer comes as its own message, and the contact then picks the conversation back up in Japanese as a second message. The contact can also nudge the user back to Japanese when they say anything else in English, say 「ちょっとわかりません」 if they steer off topic, and change settings when asked in plain English. The screen shows a live transcript with `*added to stack*` for each new word (or `*already in your stack*` when it was saved before), and buttons for speaker, mute, speed and end call. The contact's words fade in as they're said, not when the text arrives. OpenAI writes a reply in about a second but takes several seconds to say it, and over WebRTC it sends no timing for single words, so the app paces the text from the speed setting and from how long earlier replies took to say. When the user cuts the contact off, OpenAI reports how much audio was heard, and the line is cut to about that point and ends with "…". A paid plan saves only what was heard.

Ping has a life of its own, so asking 「元気？」, 「今、何してる？」 or 「明日の予定は？」 gets a real answer, like a friend's: it lives in Tokyo with its cat Mochi and works part-time at a coffee shop. Each day of the week has its own plan, picked by the user's date. The call is told, on the user's clock, which parts of Ping's day are done (with a small thing that happened), what it's doing now, what it plans for later, and tomorrow's plans, so every call on the same day tells the same story and Ping never says how a plan turned out before it happens. A call before 5:00 still belongs to the night before. Ping also mentions small things from its day now and then, keeps the focus on the user, and says honestly that it's an AI if asked. Ping's life and days are in `server/persona.js`. Custom contacts make up small details that fit their topic.

OpenAI stops the contact's audio as soon as the user makes a sound, and the app, not OpenAI, decides when the contact replies. If the user talked over the contact with only aizuchi, like うん or はい, the app waits for the transcript (usually under half a second), then has the contact carry on from where it was cut off instead of answering. Anything else, or a transcript that doesn't arrive within 1.5 seconds, gets a normal reply.

**Smart Turn mode (admins only, for testing).** The phone, not OpenAI, decides when the user has finished talking:
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
- **Words:** words the user didn't understand, saved by the voice model. Free users keep their latest 25, with the oldest replaced, and can't remove any.
- **Sentences:** example sentences, looked up one word at a time and stored only if the user saves them. Each shows its Japanese, romaji and English translation, like a word. Sentences saved before romaji was added show without it. Swipe left to remove.

## Plans

Plans are a test switch under Settings for now, with no payment. Only admins can use it.

| | Free | Premium | Platinum |
| --- | --- | --- | --- |
| Contacts | Ping | Ping | Also create your own |
| Words | Latest 25 | No limit, and can remove | Same |
| Example sentences | No | Yes | Yes |
| Calls remember past conversations | No | Yes | Yes |
| Longest call | 3 minutes | 5 minutes | 10 minutes |
| Calling a contact yourself | Your first call, then only to call back after missing a call | From 120 minutes a month | From 250 minutes a month |

Calls on the paid plans use minutes from the month, counted in the user's time zone, and Ping's own calls count too. Once the minutes run out, Ping still calls, up to the plan's longest call, but the user can't call until the next month. A call the user makes also stops early if the month's minutes run out during it. Home and Contacts show the minutes left, and the plan page shows each plan's limits, which come from the server. Manage Calls, for call times and how the contact talks, is at the bottom of Contacts. The user's plan shows as a badge at the top right of Home (tapping it opens the plan page) and in the upgrade note on Contacts.

On Free, the user can call Ping themselves once on a new account, and after that only to call back when they've missed or declined a call since they last talked. That keeps Free at about one call a day.

How minutes are counted: when a call first connects, its whole limit comes off the month's minutes. When the phone reports the call ended, the part it didn't use goes back. A call whose end never arrives, for example because the app was closed, keeps its whole limit, so a phone can't use more than it's charged for. The limit runs from the call's first connection, so reconnecting doesn't restart it.

Cancelling starts a 30-day window, shown on Home and the plan page. After it, words saved during the subscription, sentences and conversations are removed. Words saved on the free plan stay, and resubscribing in time keeps everything.

Mero is hidden for now, and Contacts shows it greyed out as "Coming soon". To bring it back, give it a topic and remove `hidden` in `server/contacts.js`.

## Admins and beta testers

The invite code someone joins with decides which version they get. It can't be changed later without deleting the account and rejoining.

| | Admin | Beta tester |
| --- | --- | --- |
| Invite code | `ADMIN_INVITE_CODE` | `BETA_INVITE_CODE` |
| Plan | Can switch freely | Stays on Free |
| "Ring my phone in 5 seconds" | Yes | No |
| Turn detection | Can switch between silence, semantic and Smart Turn, on the plan page | Silence, the default |
| OpenAI out of credit | The call hangs up and says so, with where to add credit | The call behaves as before: it connects but the contact stays silent |

The server enforces both limits. Accounts created before there were two codes are admins.

A third code, `YC_INVITE_CODE` (`YC-Demo` by default), is for YC reviewers. It gives the beta tester's version, so no admin settings, but on Premium instead of Free, and its accounts are counted separately. Reviewers start with 4 example words and 3 example sentences in their stack (`STARTER_STACK` in `server/stack.js`), so the stack isn't empty when they first look. Like other beta testers, reviewers can't change their plan. Which plan each code starts on is `PLAN_FOR_CODE` in `server/index.js`. Codes aren't case-sensitive.

Admins see "Invite codes" at the bottom of the plan page (Settings, then Upgrade Plan or Manage Plan). For each code it shows how many accounts joined, how many made a call, how many calls connected in all, and the 20 newest accounts with when they joined, their calls and their words. Joining is what creates an account, so each account is one phone or browser, and someone who deletes their account and rejoins counts twice. Codes and call counts are only recorded from this version on, so older accounts show "before this was tracked".

OpenAI's docs don't say how a Realtime call reports running out of credit, so the app treats any call error, failed reply or refused connection whose type or code mentions "quota" or "credit" as out of credit. The app has no documented way to read the remaining balance, so it can only tell once credit has run out, not when it's running low. For that, set a usage alert or auto-recharge in OpenAI's billing settings.

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
| `ADMIN_INVITE_CODE`, `BETA_INVITE_CODE`, `YC_INVITE_CODE` | The codes people need to join | The defaults in `server/index.js` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Sign the push notifications. Changing them breaks every existing subscription until the user reopens the app | The server won't start |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact for push services | Uses the Render URL |
| `DATA_DIR` | Where user data and the voice message are stored | `./data` |
| `REALTIME_MODEL` | The voice model | `gpt-realtime` |
| `REALTIME_VOICE` | Ping's voice | `marin` |
| `TEXT_MODEL` | Writes example sentences | `gpt-6-luna` |
| `DAILY_CALL_LIMIT` | How many calls a user can start per day, including test rings | No limit |

Other rules:

| Rule | Value | Where to change it |
| --- | --- | --- |
| Ring time | 10 seconds | `RING_MS` in `server/calls.js` |
| Default call hours and frequency | 10:00 to 20:00, daily | `DEFAULT_SETTINGS` in `server/settings.js` |
| Free word limit | 25 | `FREE_WORD_LIMIT` in `server/stack.js` |
| Longest call and monthly minutes per plan | Free 3 min; Premium 5 min, 120 a month; Platinum 10 min, 250 a month | `PLAN_MINUTES` in `server/contacts.js` |
| Cancellation window | 30 days | `CANCEL_WINDOW_MS` in `server/calls.js` |
| Example lookups per user per day | 50 | `MAX_LOOKUPS_PER_DAY` in `server/calls.js` |
| Extra pause time at slow speeds | | `SLOW_SPEED_PATIENCE` in `server/settings.js` |
| `turnMode`: how Ping decides the user has finished talking | `silence` (OpenAI's `server_vad`) for everyone. Admins can switch their own to `semantic` (`semantic_vad`) or `smartTurn` (Smart Turn on the phone) | `TURN_MODES` and `SEMANTIC_EAGERNESS` in `server/tutor.js` |
| Smart Turn's timings: quiet before asking, the backup, and what counts as too slow | 0.2 s, 2.5 s, 0.6 s | `TURN` and `SLOW_DECISION_MS` in `public/turn-machine.js` |
| Smart Turn's score and backup per time to answer | short 0.5 and 2 s, normal 0.5 and 2.5 s, long 0.7 and 4 s | `SMART_TURN_PATIENCE` in `server/tutor.js` |
| Default speed and allowed range | 1.0, from 0.6 to 1.5 | `server/settings.js` |
| Questions and how contacts behave | | `server/tutor.js` |
| Contacts and voices | | `server/contacts.js` |

In semantic mode, "Time to answer" sets how eager OpenAI is to reply instead of a silence length. `normal` and `long` currently behave the same there, because `low` is the lowest eagerness level. In Smart Turn mode it sets how sure Smart Turn must be and how long its backup waits, as well as the silence it falls back to.

The hang-up at the time limit runs in the browser, so someone who modifies the page could stay on longer in a call that's already connected. The server still charges the call's whole limit up front and won't reconnect it past the limit. OpenAI's own session limit is the backstop. Set a monthly budget in your OpenAI account too.

## Before beta launch

Ping is still a prototype, so do these before inviting testers:

- Set `DAILY_CALL_LIMIT` on Render. It's off for prototyping, so any invited user can currently run up the OpenAI bill. 6 is a reasonable starting point.
- Replace the 7-day OpenAI key with a longer-lasting one limited to the Realtime and text-to-speech APIs. Calls stop working when a key expires.
- Set a monthly budget in your OpenAI account, and check that auto-recharge is set the way you want.
- Before sharing the beta code, finish the first three items above, because every tester's calls spend your OpenAI credits.
- Set your own `ADMIN_INVITE_CODE`, `BETA_INVITE_CODE` and `YC_INVITE_CODE` on Render if this repo will ever be shared, since the defaults are in the code.
- Replace the plan test switch with real payments, and remove the `PUT /api/plan` route.
- Have the draft Privacy Policy and Terms of Service in `public/index.html` reviewed by a lawyer.
- Add real accounts in onboarding. An account currently lives on one phone, so losing the app's storage loses access to it.

## Deploy on Render

Use **New > Blueprint** and point it at this repo. `render.yaml` sets up a web service with a 1GB disk, which costs extra on top of the instance. Run `npm run setup` locally and copy the values from `.env` into the prompts Render shows. Run exactly one instance, since all state is in one file on that disk.

## Privacy

- Audio goes directly from the browser to OpenAI during a call. Ping's server never sees it and doesn't record calls.
- At the end of a call, the app sends timing numbers (no audio, no words) to the server to measure conversation quality.
- In Smart Turn mode, the voice detector and Smart Turn run on the phone. The audio they hear never leaves it. The server only gets the same kind of timing numbers: how many turns Smart Turn or the backup ended, how long decisions and loading took, and whether the call fell back to silence mode.
- Transcripts appear on the call screen. On a free plan they're never sent to Ping's server. On a paid plan, the text of the last 20 calls is stored to personalize later calls.
- The server stores each user's time zone, settings, plan, streak (with the day numbers of their last 14 practice days), contacts, stack, push subscription, voicemail list and recent call times, in one JSON file. Calls are deleted after 7 days.
- There are no names or emails. "Delete my account" removes everything for that user.
- Feedback is stored without the sender's account, and also appears in the server logs.
- Contacts say they're an AI if asked, and the join screen says so too.

## How it's built

- `server/calls.js`: the call lifecycle, driven by a one-second tick so a restart picks up where it left off, plus each user's record.
- `server/schedule.js`: picks call times, in the user's time zone.
- `server/progress.js`: streaks.
- `server/stack.js`: the word and sentence banks.
- `server/contacts.js`: contacts, plans and voices.
- `server/tutor.js`: the questions, the voice model's instructions and its tools.
- `server/settings.js`: what users can change, and the limits.
- `server/openai.js`: the only code that holds the OpenAI key.
- `server/push.js`: sends web pushes.
- `server/store.js`: saves state to one JSON file.
- `public/sw.js`: shows the ring and missed call notifications, and handles tapping them.
- `public/voice.js`: the WebRTC call, including running the voice model's tools.
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
- `bench/`: a Python benchmark of end-of-turn detectors on Japanese learner speech. It runs only on a developer's computer and is never deployed. See `bench/README.md`.
- `scripts/build-icons.js`: draws the "ping" logo into `public/icons`.
