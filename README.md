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

Before Home, a new account picks its Japanese level, a JLPT level from N5 (just starting) to N1 (near-fluent), each with a short description for people who've never taken the JLPT. Ping's instructions say the level (`LEVEL_GUIDE`), and it can be changed later in Settings, Manage Account, or by asking Ping on a call. Each call records the level the learner had chosen as it started (`proficiency` in the call log, `selfLevel` in the Calls tab history and progress), to compare with the estimated speaking level.

**Onboarding (beta testers and Free users, once).** Page 1 asks "What should Ping call you?", suggests how Ping will say it in katakana once they stop typing (`POST /api/name/reading`, OpenAI's text model; they can change it and tap "Hear it" to hear Ping's voice say 「ステラさん、こんにちは！」, `POST /api/name/hear`; both count as lookups), their call hours (saying they can also call Ping any time and change this later), and their plan: Platinum for beta testers, with up to 10 minutes a call and up to `DAILY_CALL_LIMIT` calls a day; Free for everyone else, with 3 minutes a call and 1 call a day, and an Upgrade button to a placeholder page (`screen-upgrade`) that lists what Premium and Platinum add, with "Coming soon". Page 2 is the level picker, which also offers "I'm completely new" (level `new`, below N5: Ping uses the simplest Japanese, speaks slowly and says each question in English too; picking it also sets speed 0.85 and long time to answer). Then everyone, admins and YC reviewers included, sees "Connecting to Ping" with moving voice waves for 5 seconds before Home. Accounts that joined before see the onboarding once, pre-filled. The name and its reading can be changed in Manage Account.

**Ping says their name.** Only the kana reading (checked to be kana, at most 20 characters) goes into Ping's instructions and greeting, never the typed name: 「ステラさん」 on formal calls, 「ステラ」 on casual ones, in the greeting and now and then after (prompt version 3).

**An app on phones, a browser tab on computers.** On a phone (iPhone, iPad or Android), Ping only runs as the installed Home Screen app: a phone in a browser tab always gets the "Add Ping to your Home Screen" page, with no way past it, whether or not it has an account there (`needsInstall` in `public/device.js`). iPhones get the Share → Add to Home Screen steps; Android gets an **Install Ping** button when Chrome offers its install prompt (`beforeinstallprompt`), and the menu steps otherwise. The installed app is also the only place a phone lets Ping ring. On a computer, Ping opens in the browser as before, and the notifications page there has "Not now: just use Ping in this browser" (kept per browser in `localStorage`), so admins can use the admin pages from a laptop; that link isn't shown on phones. On the sign-up page, tapping the invite code box focuses it directly (some iPhone Home Screen apps won't otherwise), and tapping Join with the box empty opens the phone's own "Enter your invite code" pop-up instead (`codeToJoin` in `public/device.js`), so there's always a way to type the code. In the app without notifications, Home shows a card saying Ping can't call until notifications are on, with "Turn on calls".

1. Each user gets a call at a random time inside the hours they set, on the days their call frequency allows. The default is daily, between 10:00 and 20:00 in their time zone. Once Ping has called them 3 times in the last 4 weeks, the time leans toward the hours they tend to answer: each hour of the window is weighted by (answered + 1) / (rang + 2), so an hour with no calls stays at even odds, one missed call only nudges it, and no hour of the window is ever ruled out (`hourWeights` in `server/schedule.js`). Admins' test rings don't count.
2. The server sends a push and the phone shows "Ping is calling". The phone confirms the push arrived, and that starts the 10 seconds. The phone rings again every 2.5 seconds until then. Each ring is a new notification that replaces the last, because an iPhone only plays the notification sound for a new one. If the app is open, it shows a ringing screen and plays a ringtone (`public/ringtone.js`). iPhones only play web audio that a tap started, so the app prepares its audio on the first tap anywhere and rings through it later. The ringtone follows the phone's silent switch. A web app can't play its own ringtone when it's closed or in the background, so then the iPhone's notification sound is all there is.
3. Tapping the notification answers. The browser gets a one-minute key from the server and connects straight to OpenAI over WebRTC. When the contact calls, it greets the user and first asks if it's a good time (「今、お時間大丈夫ですか？」, or 「今、話せる？」 when casual). If yes, it asks the question. If not, it says out loud that it'll call another time, and only then hangs up (every contact, Ping or custom, is told to say the goodbye before ending the call); the phone also hangs up after hearing that goodbye even if the voice engine forgets to. When the user calls, the contact thanks them for calling and goes straight to the question. Calls stop at the plan's longest call (see "Plans").
4. If nobody taps in 10 seconds, the call is missed. The notification changes to "Missed call", and a voicemail appears as a small card at the top of the Calls tab, with Play and Call back; a dot on the tab shows until it's heard.
5. If the phone never confirms the push, for example because it's offline, the call counts as missed after 30 seconds.

Tapping after the 10 seconds opens the Calls tab, with the voicemail.

After a call that connected, one page asks two quick questions, each answered with one tap from 1 to 5: how often Ping cut you off (1 never, 5 all the time), and how natural it felt (1 not at all, 5 like a real conversation). Under them is an optional comment box whose grey placeholder, "What felt natural or unnatural about this call?", clears when it's tapped. Done saves the ratings and the comment; Skip saves nothing. They're stored with the account (`ratings`: the latest 200, or all of them for admin and beta tester accounts), with the comment trimmed to 1,000 characters (`comment`, or null). The server log's `call-rating` line and the call log say only whether there was a comment (`commented`), never its words. Admins read comments in the Call log and beside a recorded call on the Call recordings page.

Calling a contact from Contacts, the Calls tab or the voicemail rings for 3 seconds first ("Calling…", with Japan's ringback tone), then the call connects. Ending it while it rings cancels it before anything starts.

On a call, the contact can explain a word in one short English sentence and save it to the user's stack, however the user asks ("what does X mean?", "what do you mean by X?", 「Xってどういう意味？」), even when the transcript misspells the word. Repeating the contact's word back as a question (「忙しい？」 right after it said 忙しい) counts as asking what it means, not as a question about the contact's day. If a word can't be saved, the contact is told why so it can try again with the word written properly. The contact never asks the same question more than twice in a row, and answers what the user asked first. It can also translate what it just said into English when the user didn't understand it (then ask again in simpler Japanese, never repeating the same sentence), and answer a question asked in English about Japanese language or culture in one or two short sentences. That includes "how do you say...?", which also saves the word, and it works even when the question is off the contact's topic. The answer comes as its own message, and the contact then picks the conversation back up in Japanese as a second message. The contact can also nudge the user back to Japanese when they say anything else in English, say 「ちょっとわかりません」 if they steer off topic, and change settings when asked in plain English. The screen shows a live transcript with `*added to stack*` for each new word (or `*already in your stack*` when it was saved before), and buttons for speaker, mute, speed and end call. The contact's words fade in as they're said, not when the text arrives. OpenAI writes a reply in about a second but takes several seconds to say it, and over WebRTC it sends no timing for single words, so the app paces the text from the speed setting and from how long earlier replies took to say. When the user cuts the contact off, OpenAI reports how much audio was heard, and the line is cut to about that point and ends with "…". A paid plan saves only what was heard.

Ping has a life of her own, so asking 「元気？」, 「今、何してる？」 or 「明日の予定は？」 gets a real answer, like a friend's. She's 25, lives in Setagaya, Tokyo, with タロウ (Taro), her orange-and-white cat, grew up in Kanagawa, studied sociology, and works part-time as a barista at 喫茶こもれび. Her personality is in every call's instructions: warm, curious, observant, opinionated and a little sarcastic, though she only ever teases herself, タロウ or the situation, never the learner's Japanese, and drops it when they're struggling. She calls herself 私, uses natural fillers, and speaks friendly です/ます on formal calls and タメ口 on casual ones. Each day of the week has its own plan, picked by the user's date, and a few small stories run through the week from Monday to Sunday (a new drink at the café, a photo zine, a trip home to Kanagawa). It's the same week for everyone, not a memory of any user, so Ping doesn't talk as if the learner already knows it. The call is told, on the user's clock, which parts of Ping's day are done (with a small thing that happened), what she's doing now, what she plans for later, and tomorrow's plans, so every call on the same day tells the same story and Ping never says how a plan turned out before it happens. A call before 5:00 still belongs to the night before. Ping keeps the focus on the user, says honestly that she's an AI if asked, and when the talk turns to something she doesn't know, like investing, she says so warmly instead of making anything up. Her facts, personality and week are in `server/persona.js`, and the instructions built from them in `server/prompt.js`. Custom contacts get none of this: they make up small details that fit their topic.

OpenAI stops the contact's audio as soon as the user makes a sound, and the app, not OpenAI, decides when the contact replies. If the user talked over the contact with only aizuchi, like うん or はい, the app waits for the transcript (usually under half a second), then has the contact carry on from where it was cut off instead of answering. Anything else, or a transcript that doesn't arrive within 1.5 seconds, gets a normal reply.

**Engines and turn detection, randomized per call.** Every call is assigned an engine and a turn detection mode when it first connects, at random but balanced per person: each call goes to the combination that person has had least (`comboCounts` on the account), so even a few calls each compare fairly. A reconnect keeps the same assignment. The random mix is the beta's six-way comparison: OpenAI `gpt-realtime` with silence, with Smart Turn and with semantic turn detection, Deepgram's Voice Agent, OpenAI GPT-Live (full duplex) and ElevenLabs Agents (`RANDOM_MIX` in `server/experiment.js`); an engine whose keys aren't set on the server is left out. A new caller gets each of the six once in their first four calls; someone who already had calls gets semantic until it catches up. If the server has no `DEEPGRAM_API_KEY`, Deepgram is left out of the mix. If Deepgram refuses a call token, that call falls back to `gpt-realtime` with silence (`FALLBACK_COMBO`), and the call log marks it `fallback`; an admin who picked Deepgram themselves sees the error instead. Admins can turn on "Choose them myself" in Manage Plan and pick an engine and turn mode for their own calls; those calls are marked `manual` and don't count toward the balance. Manage Calls tells everyone that conversations may feel different from call to call. New engines (gpt-live-1, Pipecat) join `ENGINES` once built, and the mix only after a few admin test calls and a Privacy Policy update naming the new company. Engines that decide turns themselves have no turn mode, so theirs is blank.

The **call log** keeps one entry per call that connected (`callLog` in the data file, the latest 5,000): the account's invite code and id, when, the engine, the turn mode it was assigned and the one it actually ended in (Smart Turn can fall back to silence), whether it was random or manual, and how it went: length, gap before replies, wait after the user stopped, suspected cut-offs, times the user talked over Ping, barge-ins, ignored aizuchi, turns, Deepgram's own reported latency, and the user's two ratings. The page shows n/a for what the call's engine can't measure. Numbers and ids only. Admins see it under Settings, Admin tools, Call log (`GET /api/admin/calls` has every field). Deleting an account removes its entries.

**Controlled call topics (admins only).** To compare the six configurations under the same conditions, an admin can switch Manage Plan's "Call topic mode" from randomized to controlled and pick a test scenario (`SCENARIOS` in `server/scenarios.js`: Weekend Plans, Daily Life, Vocabulary Help, Recent Activities). Every call they get or make then opens with that scenario's question, one of Ping's usual ones (`weekend`, `did`, `day` and `lately`), on whichever engine and turn mode the call is assigned or they picked: the topic and the engine are set separately. Nothing else changes, and nothing about the test is sent to OpenAI or Deepgram: the scenario's instructions, example and expected behavior are for the admin only. Controlled calls don't move the random question rotation. The call screen shows a collapsed checklist; each pass, fail or unclear is saved straight away to `scenarioChecks` in the data file, one record per checkpoint (`callId`, `scenarioId`, `checkpointId`, `result`), never with the ratings. Every call log entry says `topicMode` (`randomized` or `controlled`) and `scenarioId` (null unless controlled). The scenario only sets the question for Ping; a custom contact asks about its own topic.

So calls stay comparable after the full call record is removed (7 days), each entry also keeps:
- **The call:** `contactId`, `questionId`, and `endReason`, the first reason the phone reported (missing if it never reported one, for example when the app was closed).
- **Settings as the call started:** `proficiency`, `formality`, `thinkingTime`, `speed`, and the call window and frequency (`callStartHour`, `callEndHour`, `frequency`). A change made during the call, or a reconnect, doesn't rewrite them.
- **Build:** `buildCommit`, from Render's `RENDER_GIT_COMMIT`; null where it isn't set, like a laptop.
- **Prompt:** `promptVersion` (`PROMPT_VERSION` in `server/prompt.js`). Raise it whenever what a contact is told changes; `tests/instructions-snapshot.test.js` fails until you do.
- **What the engine was actually sent,** from the call's first session (`callConfig` in `server/experiment.js`):
  - OpenAI: `realtimeModel`, `transcriptionModel` (null if the session had to start without one), `voice` (a custom contact's own voice), `voiceSpeed`, and turn detection: `turnDetection` (`server_vad` or `semantic_vad`), `silenceMs` or `eagerness`, and on Smart Turn calls `smartTurnDoneAt` and `smartTurnBackupMs`.
  - Deepgram: `thinkModel`, `listenModel`, `voice`, `voiceSpeed`, and `turnDetection` `flux` with `eotThreshold` and `eotTimeoutMs`.
  - Fields that don't apply to the engine are null. A call that never got a session that started (Deepgram refused a manual call, say) has none of them.
- **A fallback:** `fallbackFromEngine`, `fallbackFromTurnMode` and `fallbackFromAssigned` keep what it was first assigned, beside the engine it actually ran on.

Entries from before these fields simply don't have them.

**OpenAI GPT-Live.** A full-duplex engine, `gpt-live` (`server/live.js`, `public/live-call.js`): it listens while it speaks and decides when to talk itself, so these calls have no turn mode (`turnDetection` `full-duplex` in the call log). There's no browser key: the phone makes a WebRTC offer, sends it to Ping's server (`POST /api/calls/:id/live`), the server creates the session at OpenAI's `POST /v1/live/sessions` and returns OpenAI's answer, and the audio then goes straight between the phone and OpenAI. The session carries Ping's instructions (plus a note that it can't call tools itself), the Japanese voice `harema`, the greeting as a developer message in `session.input`, and `delegation` to a backend model (`gpt-4.1-mini`) that runs Ping's four tools; the phone gets each finished `function_call` inside a `response.event` and answers with `response.item.create` and `response.create` on the same data channel. GPT-Live sends no audio start or stop events on WebRTC, so its transcript deltas stand in for when each side is speaking. Settings changed mid-call go in as `session.instructions.append` notes, since its voice and instructions are fixed for the session. Near the time limit it gets a goodbye note; at the limit the phone sends `session.close`. If GPT-Live can't start a randomly assigned call, the server falls back to gpt-realtime with silence and the phone starts again (409, `fallback`). Tested end to end once from a browser (Nov 23): the greeting came word for word, a typed 「さんぽって何？」 went to the backend as `add_to_stack` for 散歩, the result went back on the data channel and Ping explained it (in Japanese rather than English), and `session.close` ended it; 41 seconds billed. Model `gpt-live-1.1` (`GPT_LIVE_MODEL`), about $0.05 a minute plus the backend model.

**ElevenLabs Agents.** A cascaded engine, `elevenlabs` (`server/elevenlabs.js`, `public/elevenlabs-call.js`), with ElevenLabs' own turn-taking model (`turn_v3`, set to `patient`). One Ping agent is created once with `npm run setup-elevenlabs` (needs `ELEVENLABS_API_KEY` and a Japanese `ELEVENLABS_VOICE_ID` from the Voice Library; prints `ELEVENLABS_AGENT_ID`): Ping's four tools as client tools, `gpt-4.1-mini` as the LLM like Deepgram calls, 24 kHz output and 16 kHz input (what the phone already plays and records), per-call overrides allowed for the prompt, first message, language and speed, a signed URL required, and nothing kept at ElevenLabs: no voice recording, audio deleted, and transcripts deleted straight away (`retention_days` 0; ElevenLabs' stricter `zero_retention_mode` refuses `gpt-4.1-mini`). Each call, the server gets a 15-minute signed WebSocket URL and the overrides (Ping's instructions, the greeting, `ja`, speed squeezed into ElevenLabs' 0.7–1.2); the phone sends `conversation_initiation_client_data`, streams its microphone as base64 PCM, plays the agent's audio, answers `ping` and `client_tool_call`, and skips audio from a reply the learner interrupted. Recorded calls keep both voices. Without its keys, or if the signed URL fails, a random call falls back to gpt-realtime with silence. Set up and tested on Nov 23: a conversation started with Ping's overrides greeted by name in Japanese, with 24 kHz audio out and 16 kHz in. Running the setup again reuses Ping's tools on the account but makes a new agent.

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
- **Japanese you've spoken,** under My Stack, with a switch (kept per phone) to **Japanese vs English**: for each of the last 20 calls, a bar split into the share of their turns in Japanese and mostly in English, and the average of the last 5 calls. The first view: the minutes of Japanese spoken on calls in all, and a step chart of them adding up call by call (tap or move along it to read each call's total). After 5 graded calls it also says "Your speaking sounds about N4" (see "Learning progress").

**Does Japanese fit into their day?** For each learner, over the last 4 weeks (`habit` in `server/calls.js`), admins see in the plan page's Invite codes list: the share of Ping's calls they answered and how many seconds the phone rang first (from when the ring reached the phone), how many calls they started themselves, practice days a week (per week they've had the account), and the north star: minutes of Japanese this week from Ping's calls they answered, which they didn't have to plan. Each call in the history keeps the hour it rang in, its pick-up time, the level they'd chosen, and whether it was an admin's test ring, which the numbers leave out.

The **Calls tab** lists recent calls to and from contacts, like a phone's recent calls (`public/recents.js`): the contact, incoming with its length, outgoing (with an arrow), missed or declined (in red), or not connected, and when (the time today, Yesterday, the weekday this week, or the date). Tapping a call calls that contact back; ⓘ opens its details: when, how it went, the Japanese spoken and characters said on it, words saved, and the transcript on a paid plan. Each account keeps this history (`callHistory`, the latest 200, or all of them for admin and beta tester accounts), so it outlives the 7-day call records. The latest voicemail is a small card at the top.

- **Streak:** days in a row with a connected call, answered or called back. Days off in the user's schedule don't break it. Home also shows the all-time best. The server keeps the last 14 practice days as day numbers, for Home's week. Streaks from before that are filled in from their count.
- **Words:** words the user didn't understand, saved by the voice model. Each plan keeps the latest ones up to its limit (25 on Free, 100 on Premium, no limit on Platinum), replacing the oldest. Anyone can remove a word.
- **Sentences:** example sentences, looked up one word at a time and stored only if the user saves them, on any plan. They have their own limit, the same number as words. Each shows its Japanese, romaji and English translation, like a word. Sentences saved before romaji was added show without it. Swipe left to remove. Tapping a sentence lists the words in it that have kanji, each with its reading, romaji and meaning, as written in the sentence and in dictionary form (食べに → 食べる). Any of them can be added to Words, which follows the same plan limit, so a full list drops its oldest word. The list is looked up the first time a sentence is opened and kept with the sentence after that.

### Each saved word's progress

A word saved on a call (`add_to_stack`) is **met**. From a day later it's due to **come back**: when a call starts, up to 2 due words, oldest first, are picked (`dueWords` in `server/word-progress.js`) and the contact's instructions ask it to use each once, naturally, at the learner's level, without quizzing them (a WORDS TO BRING BACK section; prompt version 4). After the call the phone matches the transcript against the stack (by kanji, or kana of 2+ characters) and sends word ids only (`POST /api/calls/:id/words`): words the contact said (came back), words the learner said (**used**), and words they asked about again. A word that came back without being asked about again is **understood**. Stages only go forward. Each time a word comes back it's due again after 3, 7, 14, then 30 days. The Words list and each word's page show its stage. The call log counts `wordsBroughtBack`, `wordsCameBack`, `wordsUnderstood` and `wordsUsed` and keeps the events; the SQLite export has each word's progress in `words` and the events in `word_events`.

### Per-turn timing and help by type

After every connected call the phone also sends one record per reply the contact gave and one event per time the learner asked for help (`POST /api/calls/:id/turns`, `public/turn-records.js`). Numbers and short type names only. Each reply record has: when it started (`atMs`, from the call connecting), how long the learner spoke before it, how long they took to start answering, the estimated wait before the turn was called over (`endWaitMs`), the gap the learner heard (`gapMs`), how long the reply played, what ended the learner's turn (`vad`, `smartTurn`, `backup`, `flux` or `model`), whether the learner cut in within 1.5 s (`cutOff`) or talked over it, aizuchi carried through, and the engine's own latency where it reports one. Lined up with a recorded call's audio, these are labeled turn-taking data from Japanese learners.

Help events come from the tools the contact calls: `lookup` (a word's meaning), `slower`, `faster`, `normal-speed`, `more-time`, `less-time`, `easier`, `harder` (a level change, told apart by the level before it), `formality`, `stop-calls`, `start-calls`, `culture-question` and `end-call`, each with when and which reply it followed. The call log keeps both lists and a count of each type (`help_lookup`, `help_slower`, …); the SQLite export puts them in `turns` and `help_events`.

### Learning progress

After every call that connected, the phone works out numbers about the learner's Japanese from the call's transcript and sends only the numbers (`POST /api/calls/:id/learning`, `public/learning-metrics.js`), on any plan, recorded or not:

| Field | What it is |
| --- | --- |
| `learnerTurns`, `japaneseChars`, `avgTurnChars` | The learner's lines, the Japanese characters they said, and characters per line. Japanese has no spaces, so length is counted in characters |
| `englishTurnPercent` | Share of their lines with more English letters than Japanese characters |
| `newWords`, `stackWordsUsed` | Words saved to the stack during the call, and words already in the stack that they said (matched by kanji or kana) |
| `helpRequests` | Lines asking for help: what a word means, a translation, to repeat or slow down, how to answer, in English or Japanese (`HELP_PATTERNS`) |
| `distinctWords` and `jlptN5Words` … `jlptN1Words`, `offListWords` | Different words they used, found with the browser's Japanese word splitter (`Intl.Segmenter`), and how many are on each JLPT list. Particles, verb endings and fillers aren't counted. The splitter often breaks a verb into pieces, so a verb is matched by its stem when it can be and otherwise counts as off-list: read these as rough |

The timing summary (`public/turn-metrics.js`) adds `userSpeechMs` and `agentSpeechMs` (how long each side spoke, estimated from the same speech events) and `answerStartMedianMs` (how long the learner took to start answering after the contact finished a turn). The call log keeps every timing number the phone sends (P90s, Smart Turn's numbers and the rest), and works out `userCallSharePercent` (the learner's share of speaking time) and `avgTurnMs` (speaking time per turn).

**Estimated speaking level.** A recorded call with 3 or more learner lines is sent to OpenAI's `gpt-4.1-mini` (`LEVEL_MODEL`) once, in the background, to estimate the learner's speaking level from the transcript: a JLPT level overall, for vocabulary and for grammar, a confidence, and a one-line reason (`gradeLevel` in `server/openai.js`). Only calls whose transcript is already kept for review are graded, so no new text leaves the phone. The call log keeps the levels and confidence; the reason stays with the account and shows beside the recording. Each call costs a fraction of a cent.

**What the learner sees.** Under My Stack on Home, a chart of the minutes of Japanese they've spoken on calls, adding up call by call, so it only ever grows. Japanese minutes are their speaking time less the share of lines that were mostly English. Once 5 calls have been graded, it also says "Your speaking sounds about N4", the middle of the last 5 estimates (`LEVEL_SAMPLE`), so one off day doesn't move it. Each account keeps a progress history (`progress`, one entry per call: speaking time, English share, characters, level) and its estimates (`levelEstimates`), the latest 1,000 each, or all of them for admin and beta tester accounts.

The JLPT word list (`public/jlpt-words.json`, about 13,600 written forms) is built from [open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) (MIT), which comes from Jonathan Waller's JLPT lists at tanos.co.uk (CC BY). A word on more than one list keeps its easiest level.

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
| Plan | Can switch freely | Platinum (10 minutes a call), and can't change it |
| "Ring my phone in 10 seconds" (Settings, Admin tools) | Yes | No |
| Record calls on this phone (Settings, Admin tools) | Yes | No |
| Calls recorded for review (see "Call recordings") | Always | Always. YC reviewers can turn it off |
| Call recordings page (Settings, Admin tools) | Yes | No |
| Calls a day | No limit | No plan limit, but `DAILY_CALL_LIMIT` (10 on Render) caps them, which Home and the onboarding say |
| Onboarding (name, call hours, plan; then level) | No, just the level picker | Yes, once. YC reviewers skip it |
| Engine and turn detection | Randomized per call, or "Choose them myself" on the plan page | Randomized per call |
| Call log (Settings, Admin tools) | Yes | No |
| What's kept about their calls | Everything, until an admin deletes the call or the account is deleted | Everything, until an admin deletes the call or the account is deleted. YC reviewers' calls follow the usual limits |
| OpenAI out of credit, or the contact can't talk | The call screen says why, with where to add credit when it's credit, then the call ends | The call screen says "Ping can't talk right now. Please try again later." (with the contact's name), then the call ends. No billing details |

The server enforces both limits. Accounts created before there were two codes are admins.

A fourth code, `FREE_INVITE_CODE`, is for everyone else until sign-up opens: those accounts start on Free (3 minutes a call, 1 call a day), go through the onboarding, and keep the usual data limits.

A third code, `YC_INVITE_CODE`, is for YC reviewers. It gives the beta tester's version, so no admin settings, but on Premium instead of Free, with no limit on calls a day, and its accounts are counted separately. Reviewers start with 4 example words and 3 example sentences in their stack (`STARTER_STACK` in `server/stack.js`), so the stack isn't empty when they first look. Like other beta testers, reviewers can't change their plan. Which plan each code starts on is `PLAN_FOR_CODE` in `server/index.js`. Codes aren't case-sensitive.

Admins see "Invite codes" at the bottom of the plan page (Settings, then Upgrade Plan or Manage Plan). For each code it shows how many accounts joined, how many made a call, how many calls connected in all, and the 20 newest accounts with when they joined, their calls and their words. Joining is what creates an account, so each account is one phone or browser, and someone who deletes their account and rejoins counts twice. Codes and call counts are only recorded from this version on, so older accounts show "before this was tracked".

**Recording calls (admins only).** iPhone screen recordings go silent once a call opens the microphone: the phone switches to its voice-call audio mode, and screen recording leaves that out, as it does for FaceTime. So with "Record calls on this phone" on, the app mixes the microphone and the contact's voice in the browser and records them with `MediaRecorder` (`public/recorder.js`): .m4a on an iPhone, .webm elsewhere. After the call, "Save last call's recording" in Settings opens the share sheet, or downloads the file where there isn't one. The recording is only in the phone's memory: nothing is uploaded, the next recorded call replaces it, and closing the app loses it. For a demo video, screen record the call too and line the two up; the ring in the screen recording marks where the call starts. The switch is kept per phone, in `localStorage`.

## Call recordings

Calls are recorded so the Ping team can listen to them and read their transcripts, to improve Ping's conversations.

- **Who's recorded:** every account, from the call's first connection. Admin and beta tester accounts always are, as part of testing. YC reviewers and any future accounts can turn off "Use my calls to improve Ping" in Manage Account. That stops recording calls that start after it, and keeps calls already recorded. Whether a call is recorded is decided once, when it first connects (`call.recorded`), and the server refuses uploads for any other call.
- **How:** the phone records both voices with the same recorder admins use for demo videos (`public/recorder.js`). After the call it uploads the audio (`POST /api/calls/:id/recording`, .m4a from an iPhone or .webm, up to 25 MB) and the transcript (`POST /api/calls/:id/transcript`, the same request paid plans already send). The transcript is what was heard: a line Ping was cut off in ends where it stopped.
- **Where:** files on the server's disk, outside the main JSON store: `DATA_DIR/recordings/<user id>/<call id>.json` (who, when, which contact, turn mode, length, transcript) and `.m4a` or `.webm` beside it (`server/recordings.js`).
- **How long:** until the user deletes their account, which deletes their recordings too. Nothing removes them automatically. An admin can also delete one call (its recording, transcript, rating, comment, call log entry and checklist results) with "Delete this call" on the Call recordings or Call log page (`DELETE /api/admin/calls/:id`).
- **Admin and beta testers' data:** nothing of theirs expires or is trimmed (`keepsEverything` in `server/calls.js`): their full call records aren't removed after 7 days, their ratings aren't capped at 200, and when the call log passes 5,000 entries only other accounts' oldest entries go. Admins' scenario checklist results are never trimmed either. Everyone else keeps the usual limits.
- **Listening:** admins open Settings, Admin tools, Call recordings. Each call shows the account kind (admin, beta tester or YC reviewer) and the first characters of its account id, and opens to a player and the transcript.
- **Telling users:** the join screen says calls are recorded, and the Privacy Policy and Terms say how. When the policy changes in a way that affects people, raise `POLICY_VERSION` in `server/calls.js`: accounts that saw an older version get a one-time card on Home about what changed (`policyNoticeFor`). Version 2 is call recording; version 3 names Deepgram beside OpenAI; version 4 adds post-call comments, that admin and beta testers' call data is kept until deleted, the learning numbers and the speaking-level estimate. Someone who never saw version 2 gets the recording card, which points to the full policy; someone who did gets a short "Privacy Policy updated" card.
- **Space:** a 3-minute call is about 1.5–3 MB, so Render's 1 GB disk holds a few hundred calls. Admin tools shows how much the recordings and the data file take and how full the disk is (`GET /api/admin/storage`), and says when it passes 80%. Move recordings to cloud storage before there are many testers.

OpenAI's docs don't say how a Realtime call reports running out of credit, so the app treats any call error, failed reply or refused connection whose type or code mentions "quota" or "credit" as out of credit. Two failed replies in a row, for any reason, also mean the contact can't talk (one is retried). Either way the call screen shows the notice for three seconds before the call ends (`public/voice.js`). The app has no documented way to read the remaining balance, so it can only tell once credit has run out, not when it's running low. For that, set a usage alert or auto-recharge in OpenAI's billing settings.

## Analyzing the data

Ping's data lives on Render's disk in more than one place: `DATA_DIR/ping.json` (accounts, the call log, call history, progress, ratings, level estimates), `DATA_DIR/recordings/<user>/<call>.json` (transcripts) and the audio beside them. To analyze it on a laptop:

1. Make a random key of at least 32 characters (for example `openssl rand -hex 24`) and set it as `EXPORT_KEY` both on Render and in your laptop's `.env`. Without it the export is off.
2. Run `npm run pull-data`. It downloads everything to `~/ping-data` (or `PING_DATA_DIR`): the raw export as `raw/ping-<date>.json`, any audio not already there under `audio/`, and **one SQLite file**, `ping-<date>.sqlite`, copied to `ping-latest.sqlite`. Each run is a dated snapshot, so calls the server later removes (other accounts' after 7 days) stay on the laptop.
3. Open the SQLite file with pandas, R, DB Browser for SQLite or any SQL tool.

In the SQLite file each fact is stored once (`scripts/build-db.js`), even where the server keeps copies:

| Table | One row per |
| --- | --- |
| `learners` | account: invite code, plan, joined, chosen level, call hours, when they chose a level and finished onboarding, whether they gave a name (the name itself stays out) |
| `calls` | call, connected or not: who started it, outcome, hour, pick-up time, length, level chosen at the time, test ring or not |
| `call_setup` | connected call: engine, turn mode, topic, settings, build, prompt version, what the engine was sent |
| `turn_metrics`, `learning_metrics` | connected call: the phone's timing numbers, and the learner's Japanese |
| `ratings`, `level_estimates` | rated or graded call, with the comment or the model's reason |
| `turns`, `help_events` | reply the contact gave (its timing), and request for help by type |
| `words`, `word_events` | saved word with its progress (stage, times it came back, times used), and each time a word came back, was understood, used or asked about again |
| `settings_changes` | change to a tracked setting (level, call window, frequency, pace, formality, calls on or off): when, from, to, and whether it was asked for during a call |
| `words`, `sentences`, `scenario_checks`, `recordings`, `transcript_lines`, `feedback` | as named |

Levels also come as numbers (`selfLevelRank`, `levelRank`, `estimatedLevelRank`: 0 completely new, 1 N5 … 5 N1, with the old beginner, intermediate and advanced at 1, 3 and 5), so they sort and compare. Each connected call's `call_setup` row has the call window and frequency as it started.

Two views do the usual joins: `call_facts` (one row per call with everything, plus talk share, average turn and Japanese minutes) and `learner_weeks` (each learner's weeks since joining: Ping's calls, answered, calls they started, and unplanned Japanese minutes). `node scripts/pull-data.js --from <DATA_DIR>` builds the same file from a local folder instead of the server.

The export (`GET /api/export`, and `/api/export/audio/:callId`) needs the `X-Export-Key` header, counts wrong keys toward the same limit as wrong invite codes, and never includes sign-in tokens or push subscriptions. The pulled folder holds transcripts and recordings: keep it on the laptop, outside any git repository.

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
| `LEVEL_MODEL` | Estimates a learner's speaking level from a recorded call | `gpt-4.1-mini` |
| `EXPORT_KEY` | Lets `npm run pull-data` download the data for analysis (see "Analyzing the data"). At least 32 random characters, the same on Render and in your laptop's `.env` | The export is off |
| `GPT_LIVE_MODEL`, `GPT_LIVE_VOICE`, `GPT_LIVE_BACKEND_MODEL` | GPT-Live's model, voice, and the backend model that runs its tools | `gpt-live-1.1`, `harema`, `gpt-4.1-mini` |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | ElevenLabs Agents. The agent comes from `npm run setup-elevenlabs`, which also needs `ELEVENLABS_VOICE_ID` (a Japanese voice) | ElevenLabs is left out of the random mix |
| `ELEVENLABS_LLM` | The LLM the Ping agent was set up with, for the call log | `gpt-4.1-mini` |
| `DEEPGRAM_THINK_MODEL`, `DEEPGRAM_VOICE` | The model that writes Deepgram calls' replies, and their voice | `gpt-4.1-mini`, `flux-ayumi-ja` |
| `DAILY_CALL_LIMIT` | How many calls a user can start per day, including test rings. Admins and YC reviewers aren't limited; for beta testers it's their only limit (10 for the beta) | No limit |
| `FREE_INVITE_CODE` | The invite code for Free accounts, until sign-up opens | No one can join on Free |

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
| Engines, and which engine and turn mode combinations calls are randomized across | `gpt-realtime` with silence, with Smart Turn and with semantic; Deepgram's Voice Agent (only when `DEEPGRAM_API_KEY` is set); GPT-Live (needs the OpenAI key); and ElevenLabs Agents (only when `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` are set) | `ENGINES`, `RANDOM_MIX` and `FALLBACK_COMBO` in `server/experiment.js` |
| `turnMode`: how Ping decides the user has finished talking | `silence` (OpenAI's `server_vad`), `semantic` (`semantic_vad`) or `smartTurn` (Smart Turn on the phone) | `TURN_MODES` and `SEMANTIC_EAGERNESS` in `server/tutor.js` |
| Smart Turn's timings: quiet before asking, the backup, and what counts as too slow | 0.2 s, 2.5 s, 0.6 s | `TURN` and `SLOW_DECISION_MS` in `public/turn-machine.js` |
| Smart Turn's score and backup per time to answer | short 0.5 and 2 s, normal 0.5 and 2.5 s, long 0.7 and 4 s | `SMART_TURN_PATIENCE` in `server/tutor.js` |
| Default speed and allowed range | 1.0, from 0.6 to 1.5 | `server/settings.js` |
| Japanese levels | JLPT N5 (easiest) to N1, default N5. Everyone picks one before they first reach Home; accounts from before keep their old level's place (beginner N5, intermediate N3, advanced N1) until they do | `PROFICIENCY_LEVELS` and `LEGACY_LEVELS` in `server/settings.js`, `LEVEL_GUIDE` in `server/prompt.js` |
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

- During a call, audio goes directly from the browser to the call's voice engine: OpenAI (gpt-realtime or GPT-Live), ElevenLabs (which keeps no audio and deletes transcripts straight away), or Deepgram (whose agent sends the transcript to an OpenAI model to write replies). Ping's server doesn't take part in the live call. The Privacy Policy names OpenAI, Deepgram and Render as the companies that handle calls.
- **Calls are recorded.** After each recorded call, the phone uploads the recording (both voices) and the transcript to Ping's server, where only admins can listen to them. They're kept until the user deletes their account. See "Call recordings". They're never sold, shared, or used to identify or copy anyone's voice.
- At the end of a call, the app also sends timing numbers to the server to measure conversation quality, numbers about the learner's Japanese worked out on the phone from the transcript (see "Learning progress"), and the two 1-5 ratings if the user answers them. All are numbers only; an optional comment can go with the ratings.
- A recorded call's transcript, already kept for review, is also sent to OpenAI once to estimate the learner's speaking level. The estimate (levels, confidence and a one-line reason written by the model) is kept with the account.
- In Smart Turn mode, the voice detector and Smart Turn run on the phone, and send no audio anywhere themselves. The call's recording is uploaded as above. Smart Turn adds only the same kind of timing numbers: how many turns Smart Turn or the backup ended, how long decisions and loading took, and whether the call fell back to silence mode.
- Transcripts appear on the call screen. A recorded call's transcript is kept for review on any plan. On a paid plan, the text of the last 20 calls is also stored with the account to personalize later calls. A free-plan call that isn't recorded sends no transcript to the server.
- The server stores each user's time zone, settings (including their JLPT level), plan, streak (with the day numbers of their last 14 practice days), contacts, stack, push subscription, voicemail list, recent call times and how each call went (for the Calls tab), learning progress numbers and level estimates, whether they've turned recording off, and which version of the Privacy Policy they've seen, in one JSON file. Calls are deleted from it after 7 days, except admin and beta testers' (see "Call recordings"). Recordings are separate files.
- A comment left after a call is the one piece of free text Ping keeps besides recordings and transcripts. It's stored with the account and only admins can read it.
- The only name is the one they give Ping to call them, and how to say it in kana. The reading goes to the voice services in Ping's instructions; the typed name stays on Ping's server. There are no emails, though a recording can include anything the user says. "Delete my account" removes everything for that user, recordings included.
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
  - **Older phones:** the nine fields every version has sent (up to `callSeconds`) are required. Fields added since are optional, so a phone still running an older app is accepted, and what it didn't send is saved as null, never 0. Unknown fields, wrong types and out-of-range values (over an hour for times, a day for `callSeconds`, 100,000 for counts) still reject the whole set.
  - **What each engine can measure:** null means "can't be measured here", not zero.
    - On Deepgram, `bargeIns` and `ignoredAizuchi` are null, because Deepgram answers aizuchi like any turn and the phone can't tell them apart. `turnEndWait` and `replyGap` are null, because Flux's `EndOfTurn` doesn't say when the learner went quiet.
    - `talkOvers` counts every time Ping's voice was cut because the user spoke, on every engine. On OpenAI, `bargeIns` is `talkOvers` minus `ignoredAizuchi`.
  - **Deepgram's own latency:** `providerLatencyMedianMs`, `providerLatencyP90Ms` and `providerLatencyCount`, from `total_latency` in its `LatencyReport` (or `AgentStartedSpeaking`) messages. Deepgram defines it as "user utterance end to first audio byte", as Deepgram judged the utterance's end. It isn't measured by the phone, so it's shown apart from the gap before reply and isn't the same measurement. Null on OpenAI.
- `public/app.js`: signing up, Home, ringing and the call screen, with no framework or build step.
- `public/stack.js`, `public/contacts.js`, `public/settings.js`: the other screens.
- `public/lib.js`: what the screens share.
- `evals/`: conversation evals. Scripted learner situations played against Ping's real instructions on OpenAI's Realtime model in text, scored by exact checks and a Claude judge, with tools to check the judge against your own labels. Runs only on a developer's computer and needs `ANTHROPIC_API_KEY` in `.env` for the judge. See `evals/README.md`.
- `bench/`: a Python benchmark of end-of-turn detectors on Japanese learner speech. It runs only on a developer's computer and is never deployed. See `bench/README.md`.
- `scripts/build-icons.js`: draws the "ping" logo into `public/icons`.
- `scripts/pull-data.js` and `scripts/build-db.js`: copy the data to a laptop and build one SQLite file for analysis.
