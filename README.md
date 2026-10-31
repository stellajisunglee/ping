# Ping

Mina, an AI friend, phones you once a day and asks a simple question in Japanese. It's a web app you install on your phone. The voice runs over WebRTC and the "phone call" arrives as a web push notification.

## Run it

```bash
npm install
npm run setup
```

`npm run setup` creates a `.env` file with push keys and an invite code. Add your `OPENAI_API_KEY` to that file, then:

```bash
npm start
```

Open http://localhost:3000 and join with the `INVITE_CODE` from `.env`.

```bash
npm test
```

Browsers only allow push and the microphone on `localhost` or HTTPS, so testing on a phone needs the deployed HTTPS site.

## How a call works

1. Each user gets one call a day at a random time between 10:00 and 20:00 in their own time zone.
2. The server sends a push and the phone shows "Mina is calling". The phone confirms the push arrived, and that starts the 10 seconds.
3. Tapping the notification answers. The browser gets a one-minute key from the server and connects straight to OpenAI over WebRTC. Mina greets the user and asks the question.
4. If nobody taps in 10 seconds, the call is missed. The notification changes to "Missed call", and a voice message with a call-back button appears in the app.
5. If the phone never confirms the push, for example because it's offline, the call counts as missed after 30 seconds.

Tapping after the 10 seconds opens the voice message, with the call-back button.

On a call, Mina can explain a word in one short English sentence, nudge the user back to Japanese, and change settings when asked in plain English: speed, how long she waits for an answer, and whether she keeps calling.

## Limits of web push

- There's no ringtone or full-screen call screen when the app is closed. The call is a normal notification, with whatever sound and vibration the phone gives notifications. The in-app ring screen and ringtone only appear when the app is open.
- iPhones need iOS 16.4 or later, and the app must be added to the Home Screen. The app walks users through this. iOS ignores the Answer and Decline notification buttons, so users tap the notification itself.
- Do Not Disturb and Focus modes can hide or delay calls.

## Settings

Set these as environment variables, in `.env` locally or under the service's **Environment** tab on Render. Never commit them.

| Setting | What it does | If it's not set |
| --- | --- | --- |
| `OPENAI_API_KEY` | Powers calls and the voice message | Calls and voice messages don't work. The message still shows as text |
| `INVITE_CODE` | The code people need to join | Nobody can join, because each call costs money |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Sign the push notifications. Changing them breaks every existing subscription until the user reopens the app | The server won't start |
| `VAPID_SUBJECT` | A `mailto:` or `https:` contact for push services | Uses the Render URL |
| `DATA_DIR` | Where user data and the voice message are stored | `./data` |
| `REALTIME_MODEL` | The voice model | `gpt-realtime` |
| `REALTIME_VOICE` | Mina's voice | `marin` |
| `MAX_CALL_SECONDS` | Where a call ends | 180 |
| `DAILY_CALL_LIMIT` | How many calls a user can start per day, including test rings | No limit |

Other rules:

| Rule | Value | Where to change it |
| --- | --- | --- |
| Ring time | 10 seconds | `RING_MS` in `server/calls.js` |
| Daily call hours | 10:00 to 20:00 | `WINDOW_START_HOUR`, `WINDOW_END_HOUR` in `server/schedule.js` |
| Default speed and allowed range | 0.9, from 0.6 to 1.5 | `server/settings.js` |
| Questions and Mina's behavior | | `server/tutor.js` |

The call length limit and the hang-up run in the browser, so someone who modifies the page could stay on longer. OpenAI's own session limit is the backstop. Set a monthly budget in your OpenAI account too.

## Before beta launch

Ping is still a prototype, so do these before inviting testers:

- Set `DAILY_CALL_LIMIT` on Render. It's off for prototyping, so any invited user can currently run up the OpenAI bill. 6 is a reasonable starting point.
- Replace the 7-day OpenAI key with a longer-lasting one limited to the Realtime and text-to-speech APIs. Calls stop working when a key expires.
- Set a monthly budget in your OpenAI account, and check that auto-recharge is set the way you want.

## Deploy on Render

Use **New > Blueprint** and point it at this repo. `render.yaml` sets up a web service with a 1GB disk, which costs extra on top of the instance. Run `npm run setup` locally and copy the values from `.env` into the prompts Render shows. Run exactly one instance, since all state is in one file on that disk.

## Privacy

- Audio goes directly from the browser to OpenAI during a call. Ping's server never sees it and doesn't record calls or keep transcripts.
- The server stores each user's time zone, settings, push subscription, voice message list and recent call times, in one JSON file. Calls are deleted after 7 days.
- There are no names or emails. "Delete my account" removes everything for that user.
- Mina says she's an AI if asked, and the join screen says so too.

## How it's built

- `server/calls.js`: the call lifecycle, driven by a one-second tick so a restart picks up where it left off.
- `server/schedule.js`: picks call times, in the user's time zone.
- `server/tutor.js`: the questions, Mina's instructions and her tools.
- `server/settings.js`: what users can change, and the limits.
- `server/openai.js`: the only code that holds the OpenAI key.
- `server/push.js`: sends web pushes.
- `server/store.js`: saves state to one JSON file.
- `public/sw.js`: shows the ring and missed call notifications, and handles tapping them.
- `public/voice.js`: the WebRTC call, including running Mina's settings and hang-up tools.
- `public/app.js`: the screens, with no framework or build step.
- `scripts/build-icons.js`: draws the app icons into `public/icons`.
