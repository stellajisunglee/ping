# Ping: changes from the spec, and what to improve next

This compares what this build session shipped (Oct 31 – Nov 10, 2026, commits `673d155` through `5bf5eef`) with `ping - specs (1).md`. It only lists **additions and removals**. Anything built the way the spec describes is left out.

Commits on `turn-taking-v2` after `5bf5eef` came from other sessions and aren't covered here. Examples are calls-per-day plans, the YC invite code, Ping's persona, and the in-app ringtone.

---

## Part 1: Changes from the spec

### Removed or deferred

| Spec item | What happened | Why |
| --- | --- | --- |
| **Onboarding:** email/Google/Discord sign-up, name and pronunciation, pronouns, age, goals, "how did you hear", Minaverse prompt, 60-second voice intro | Replaced by a single **invite code** screen, then install and permission screens. Level and speech style moved to Manage Calls. | Get to a working call fast for prototyping. There are no names or emails, which keeps privacy simple. Real accounts are on the "Before beta launch" list, because an account currently lives on one phone. |
| **My Stack as a separate page/tab** | Removed. The Words and Sentences buttons now sit **on Home**, with counts and empty-state hints. | Your request. Home is the landing screen, so the stack is one tap closer. |
| **Ringing "like a Lyft driver" until answered** (ring and vibrate, 10 s) | It's a web push notification that re-alerts every 2.5 s for 10 s. There's no custom ringtone or vibration while the app is closed. | iOS web apps can't vibrate or play their own sound in the background. The README lists these limits. |
| **Tap to answer in-app** | You answer by tapping the notification. The iOS Answer/Decline buttons are ignored. | It's an iOS limit. |
| **Monthly subscription with payments** | There's an admin-only **test switch** with no payment. | Prototype. The README says to replace it before beta. |
| **Contacts: subscribers only** | Contacts is visible to everyone, with Ping free. Creating a contact is Platinum only, with an upgrade card for others. | The spec says both "premium / platinum" and "platinum only" for creating contacts. The build follows the tier description: Platinum = Premium + create your own. |
| **Hardcoded invite codes** (`minabystella_admin_only`, `beta-01`) | Codes became env settings (`ADMIN_INVITE_CODE`, `BETA_INVITE_CODE`). | Codes in a repo are public once it's shared. |

### Added

**Call experience**
- **Outgoing ringback:** calling Ping shows a 3-second "Calling…" screen with Japan's ringback tone, which you can cancel. Before this, the call connected instantly and felt unlike a phone call.
- **Mero "Coming soon":** Mero shows as a greyed-out row with a disabled Call button. The spec said to hide it. You asked to tease it.
- **Live transcript paced to speech:** Ping's words fade in as they're spoken, not when the text arrives a few seconds early. When you cut Ping off, its line is trimmed to what you heard and ends with "…".
- **Admin out-of-credit notice:** if OpenAI credit runs out, an admin's call hangs up and says so. Before this, calls connected silently, which cost a debugging session. Beta testers see the old behavior.

**What Ping says** (the call rules in `server/tutor.js`)
- **Translate when you don't understand:** Ping says what it just said in English, then asks again in simpler Japanese, and never repeats the same sentence. This fixed the loop you hit, where Ping kept repeating itself.
- **English questions about Japanese language or culture:** Ping answers in 1–2 English sentences, then goes back to Japanese. "How do you say…?" also saves the word.
- **Nudge back to Japanese:** Ping does this when you use English for anything else.
- **Settings by voice:** you can change settings in plain English during a call ("slow down", "give me more time").

**Turn-taking** (none of this is in the spec)
- **Aizuchi handling:** if you only said うん or はい over Ping, it carries on from where it was cut off instead of treating that as an answer.
- **"Time to answer" setting:** short, normal or long. It sets the silence timer to 0.8, 1.3 or 2.5 s, and slower voice speeds wait longer. This extends the spec's "slower speeds should be more tolerating of gaps".
- **Three turn modes, switchable by admins only:**
  - Silence (the default for everyone, and the demo mode)
  - Semantic (OpenAI judges from your words)
  - **Smart Turn** (an on-device model that follows "time to answer")
- **End-of-turn benchmark** (`bench/`): 140 labeled pauses comparing silence timers, Deepgram Flux and Smart Turn. This is why Smart Turn exists.
- **Turn metrics:** each call sends timing numbers only to the server. No audio and no words, in line with the privacy rule.
- **Adaptive patience: built, then removed.** It made Ping more patient after a cut-off. It's parked until there are enough test calls to tune it. See Session 6 in `docs/turn-taking-plan.md`.

**Home redesign** (the spec only asked for streaks, the voicemail and a My Stack button)
- A time-of-day greeting (おはよう / こんにちは / こんばんは, with English underneath).
- A big **"Call Ping now"** button.
- A **7-day row:** ✓ for practiced, 休 for scheduled days off, today outlined. To draw it, the server now keeps the last 14 practice days, as day numbers only.
- A **last-call card:** when, how long, and how many words were saved.

**Settings and other**
- **Manage Calls extras:** call hours, Japanese level and speech style, all beyond the spec's language, speed and frequency.
- **Plan downgrade:** a 30-day window before anything is removed. The spec only covers cancelling.
- **"Delete my account"**, and anonymous feedback.
- **Draft Privacy Policy and Terms pages.**
- **Install screen:** walks iPhone users through Add to Home Screen.
- **`DAILY_CALL_LIMIT`** is turned off for prototyping. Turn it back on before beta.

---

## Part 2: Suggestions

These are ordered by impact within each section, and each is tied to what the data or testing showed.

### Core user experience

1. **Wind calls down instead of cutting them off.** At 3:00 the browser simply hangs up, and the screen says "Calls end after 3 minutes". At about 2:30, tell Ping to wrap up: it should say goodbye in Japanese, and maybe preview tomorrow's topic. An abrupt hang-up is the last thing a learner remembers, and it's the easiest moment to make them want to come back.
2. **Add a post-call recap.** After each call, show:
   - the words saved
   - one thing you said well
   - one phrase to try next time

   The last-call card on Home already has the data. A recap turns three minutes of anxiety into visible progress, which is what brings people back tomorrow.
3. **Bring saved words back in later calls.** Give Ping two or three stack words to use naturally in the next call. That closes the loop between the stack and speaking, which is the core learning mechanic. Today the stack is a list you might never open.
4. **Give a "help me answer" button during a call.** Beginners freeze. One tap could show 2–3 key words or a sentence starter for Ping's last question, without translating everything. It's less humiliating than asking Ping to translate, and it keeps the user speaking Japanese.
5. **Add a one-tap "Did Ping cut you off?" after calls.** Store it as a yes/no number, so it fits the privacy rule. That gives you labeled field data for revisiting adaptive patience, instead of relying on "suspected cut-off" guesses. It's the fastest way to the "lots of test calls" that Session 6 needs.
6. **Add "Call me later" on missed or declined calls.** It would reschedule in about 30 minutes. Web push rings badly when the app is closed, so many calls will be missed through no fault of the user. A snooze saves the day's practice and the streak.
7. **Ask for name and level by voice.** Replace the deferred onboarding form with a 30-second first call where Ping asks your name, how to say it, and why you're learning. This brings back the spec's voice intro, doubles as a demo of the product, and lets Ping greet you by name afterwards.
8. **Get real accounts before beta.** An account tied to one phone's storage means a lost phone or cleared Safari data wipes the streak. That's the fastest way to lose a learner.
9. **Allow streak freezes.** One missed day a week could be forgiven, or earned by calling back. Streak anxiety is a known churn driver for Duolingo-style learners.

### Naturalness of the voice interaction

1. **Encourage instead of staying silent during long thinking pauses.** When Smart Turn keeps saying "still thinking" for 3 seconds or more, Ping could softly say ゆっくりでいいよ ("take your time") or うん… without taking the turn. A human friend does this. It also tells the learner they haven't been cut off, which removes the pressure that causes the pauses.
2. **Lower Ping's volume for aizuchi instead of stopping it.** In the field data, 6 of 16 barge-ins were aizuchi. Ping still stopped mid-sentence each time, then resumed. In Smart Turn mode the app controls interruptions. It could lower Ping's volume for the first ~400 ms of your speech and only stop it if you keep talking. Ping would then sound like it's listening, not like it's being knocked over.
3. **Close the reply gap in silence mode.** You heard 1.9–2.3 s gaps in silence mode against 0.9–1.5 s with Smart Turn. That's the "slow" feeling. Two options:
   - **(a)** Make Smart Turn the demo default once the remaining cut-offs are understood.
   - **(b)** Keep silence, but have Ping start its reply with a short acknowledgement (へえ、 / そうなんだ、). The wait would then sound like listening.
4. **Make Ping easier within a call when you struggle.** If you ask for a translation twice in one call, have Ping switch to easier Japanese and a slightly slower speed for the rest of the call. Today the level only changes when you change it in settings.
5. **Remember past calls on the free plan, on the phone.** Callbacks like "last time you said you were going to Kyoto. How was it?" are the strongest naturalness signal there is. Today only paid plans remember, because free transcripts can't go to the server. A few short facts kept on the phone, and sent only in that call's instructions, would give free users this without breaking the privacy rule.
6. **Use Japanese sentence-final cues for turn-taking.** Japanese marks finished sentences with endings like です, ます, ね and よ, while a pause after a particle (は, が, を) is usually mid-thought. Use these to support Smart Turn's audio-only score once the transcript arrives. This could be a strong, Japanese-specific improvement, and an interesting story for Deepgram.
7. **Benchmark beyond one speaker.** All 140 benchmark pauses are your own speech. Before tuning further, record 3–5 real beginners, ideally at different levels. Their pauses are longer and land in different places, and that's who Ping is for.
8. **Keep Ping's turns short, and vary them.** Check the instructions for a cap of 1–2 short sentences per turn, and for not asking the same type of question twice in a row. Long AI monologues are what make voice tutors feel like lectures instead of calls.
