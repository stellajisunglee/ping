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

## How a call works

1. Each user gets a call at a random time inside the hours they set, on the days their call frequency allows. The default is daily, between 10:00 and 20:00 in their time zone.
2. The server sends a push and the phone shows "Ping is calling". The phone confirms the push arrived, and that starts the 10 seconds. The notification re-alerts every 2.5 seconds until then.
3. Tapping the notification answers. The browser gets a one-minute key from the server and connects straight to OpenAI over WebRTC. The contact greets the user and asks the question. Calls last up to 3 minutes.
4. If nobody taps in 10 seconds, the call is missed. The notification changes to "Missed call", and a voicemail with a call-back button appears on Home.
5. If the phone never confirms the push, for example because it's offline, the call counts as missed after 30 seconds.

Tapping after the 10 seconds opens the voicemail, with the call-back button.

On a call, the contact can explain a word in one short English sentence and save it to the user's stack, nudge them back to Japanese, say 「ちょっとわかりません」 if they steer off topic, and change settings when asked in plain English. The screen shows a live transcript with `*added to stack*` for each new word, and buttons for speaker, mute, speed and end call.

## Progress and My Stack

- **Streak:** days in a row with a connected call, answered or called back. Days off in the user's schedule don't break it. Home also shows the all-time best.
- **Words:** words the user didn't understand, saved by the voice model. Free users keep their latest 25, with the oldest replaced, and can't remove any.
- **Sentences:** example sentences, looked up one word at a time and stored only if the user saves them. Swipe left to remove.

## Plans

Plans are a test switch under Settings for now, with no payment. Only admins can use it.

| | Free | Premium | Platinum |
| --- | --- | --- | --- |
| Contacts | Ping | Ping | Also create your own |
| Words | Latest 25 | No limit, and can remove | Same |
| Example sentences | No | Yes | Yes |
| Calls remember past conversations | No | Yes | Yes |

Cancelling starts a 30-day window, shown on Home, My Stack and the plan page. After it, words saved during the subscription, sentences and conversations are removed. Words saved on the free plan stay, and resubscribing in time keeps everything.

Mero is hidden for now. To bring it back, give it a topic and remove `hidden` in `server/contacts.js`.

## Admins and beta testers

The invite code someone joins with decides which version they get. It can't be changed later without deleting the account and rejoining.

| | Admin | Beta tester |
| --- | --- | --- |
| Invite code | `ADMIN_INVITE_CODE` | `BETA_INVITE_CODE` |
| Plan | Can switch freely | Stays on Free |
| "Ring my phone in 5 seconds" | Yes | No |

The server enforces both limits. Accounts created before there were two codes are admins.

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
| `ADMIN_INVITE_CODE`, `BETA_INVITE_CODE` | The codes people need to join | The defaults in `server/index.js` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Sign the push notifications. Changing them breaks every existing subscription until the user reopens the app | The server won't start |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact for push services | Uses the Render URL |
| `DATA_DIR` | Where user data and the voice message are stored | `./data` |
| `REALTIME_MODEL` | The voice model | `gpt-realtime` |
| `REALTIME_VOICE` | Ping's voice | `marin` |
| `TEXT_MODEL` | Writes example sentences | `gpt-6-luna` |
| `MAX_CALL_SECONDS` | Where a call ends | 180 |
| `DAILY_CALL_LIMIT` | How many calls a user can start per day, including test rings | No limit |

Other rules:

| Rule | Value | Where to change it |
| --- | --- | --- |
| Ring time | 10 seconds | `RING_MS` in `server/calls.js` |
| Default call hours and frequency | 10:00 to 20:00, daily | `DEFAULT_SETTINGS` in `server/settings.js` |
| Free word limit | 25 | `FREE_WORD_LIMIT` in `server/stack.js` |
| Cancellation window | 30 days | `CANCEL_WINDOW_MS` in `server/calls.js` |
| Example lookups per user per day | 50 | `MAX_LOOKUPS_PER_DAY` in `server/calls.js` |
| Extra pause time at slow speeds | | `SLOW_SPEED_PATIENCE` in `server/settings.js` |
| Default speed and allowed range | 0.9, from 0.6 to 1.5 | `server/settings.js` |
| Questions and how contacts behave | | `server/tutor.js` |
| Contacts and voices | | `server/contacts.js` |

The call length limit and the hang-up run in the browser, so someone who modifies the page could stay on longer. OpenAI's own session limit is the backstop. Set a monthly budget in your OpenAI account too.

## Before beta launch

Ping is still a prototype, so do these before inviting testers:

- Set `DAILY_CALL_LIMIT` on Render. It's off for prototyping, so any invited user can currently run up the OpenAI bill. 6 is a reasonable starting point.
- Replace the 7-day OpenAI key with a longer-lasting one limited to the Realtime and text-to-speech APIs. Calls stop working when a key expires.
- Set a monthly budget in your OpenAI account, and check that auto-recharge is set the way you want.
- Before sharing the beta code, finish the first three items above, because every tester's calls spend your OpenAI credits.
- Set your own `ADMIN_INVITE_CODE` and `BETA_INVITE_CODE` on Render if this repo will ever be shared, since the defaults are in the code.
- Replace the plan test switch with real payments, and remove the `PUT /api/plan` route.
- Have the draft Privacy Policy and Terms of Service in `public/index.html` reviewed by a lawyer.
- Add real accounts in onboarding. An account currently lives on one phone, so losing the app's storage loses access to it.

## Deploy on Render

Use **New > Blueprint** and point it at this repo. `render.yaml` sets up a web service with a 1GB disk, which costs extra on top of the instance. Run `npm run setup` locally and copy the values from `.env` into the prompts Render shows. Run exactly one instance, since all state is in one file on that disk.

## Privacy

- Audio goes directly from the browser to OpenAI during a call. Ping's server never sees it and doesn't record calls.
- Transcripts appear on the call screen. On a free plan they're never sent to Ping's server. On a paid plan, the text of the last 20 calls is stored to personalize later calls.
- The server stores each user's time zone, settings, plan, streak, contacts, stack, push subscription, voicemail list and recent call times, in one JSON file. Calls are deleted after 7 days.
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
- `public/app.js`: signing up, Home, ringing and the call screen, with no framework or build step.
- `public/stack.js`, `public/contacts.js`, `public/settings.js`: the other screens.
- `public/lib.js`: what the screens share.
- `scripts/build-icons.js`: draws the "ping" logo into `public/icons`.
