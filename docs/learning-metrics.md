# Measuring learning in Ping (proposal)

**In short:** Ping can measure language acquisition from what it already captures in every call: timing, the learner's own words, and the stack. The moat isn't any one metric. It's a growing, longitudinal record of how real learners' speaking changes, tied to what Ping did, which no text app or tutor marketplace has. Start with numbers the phone can compute for everyone, add deeper analysis of recorded calls, and anchor everything with a repeated check-in question so "learning" claims hold up.

## What to measure

Grouped by what each one tells you. Bold ones are the strongest first picks.

### Fluency: is speaking getting easier?

| Metric | What it is | Should go | Source |
| --- | --- | --- | --- |
| **Answer start time** | Seconds from the end of Ping's question to the learner starting to answer. Your "thinking time shrinks" question | Down | Timing on the phone (already logged per turn) |
| **Pauses inside answers** | Pauses over 0.5 s per minute of the learner's speech, and their median length | Down | Timing on the phone (voice detector) |
| **Speaking share** | The learner's speaking time as a share of the call | Up | Timing on the phone |
| Answer length | Average length of the learner's turns, in morae (Japanese syllable beats) | Up | Transcript |
| Speech rate | Morae per second while speaking | Up | Transcript and timing |

### Independence: do they need less help?

| Metric | What it is | Should go | Source |
| --- | --- | --- | --- |
| **English share** | The share of the learner's turns that are mostly English | Down | Transcript, on the phone |
| **Help requests** | "What does X mean?", "say that in English", "how do you say...?" per call | Down | Ping's tool calls, on the phone |
| Repair success | After Ping rephrases, does the learner answer in Japanese next? | Up | Transcript |

### Vocabulary: are words moving from "heard" to "said"?

| Metric | What it is | Should go | Source |
| --- | --- | --- | --- |
| **Stack-to-speech** | Of the words saved to the stack, how many the learner later says themselves on a call, and how many days that takes. Your "do they use stack words later" question | Up, and sooner | Stack plus the learner's transcript lines, matched on the phone |
| Active vocabulary | Distinct words the learner has used, over time | Up | Transcript, split into words |
| Vocabulary level | The mix of JLPT levels (N5 easiest, N1 hardest) among words they use | Toward harder levels | Transcript plus a JLPT word list (check its license first) |

### Grammar and accuracy (recorded calls, analyzed afterwards)

| Metric | What it is | Should go | Source |
| --- | --- | --- | --- |
| Grammar range | Which patterns they use (past tense, て-form, 〜たい, 〜と思う, conditionals), by JLPT level | Wider | An LLM labels recorded transcripts |
| Accuracy | Errors per 100 morae, by type, and recurring errors that stop recurring | Down | An LLM labels recorded *audio* (see the trap below) |

### Conversation skill: the part only a voice product can see

| Metric | What it is | Should go | Source |
| --- | --- | --- | --- |
| **Japanese fillers** | Using えーと / あの to hold the turn instead of silence or English "um" | Up | Transcript |
| Learner aizuchi | Saying うん / へえ while Ping talks, like a Japanese listener | Up | Timing plus the aizuchi detector the app already has |
| Initiative | The learner asks Ping questions back | Up | Transcript |

Fillers link learning straight back to turn detection. A learner who learns to say えーと while thinking gets cut off less, because the pause no longer sounds finished. That's a measurable bridge between conversation design and acquisition, and a strong story for Deepgram.

## Make it hold up: a repeated check-in question

Everyday calls change topic, so raw numbers move for reasons that aren't learning. Every two weeks or so, Ping asks the same simple check-in question (for example 「週末は何をしましたか？」) at the same speed. Comparing answers to the *same* prompt, you get like-for-like on:
- answer start time
- answer length
- pauses
- English share
- errors

That's the number you can defend: "Learners' answers to the same question got 40% longer and started 1.2 s sooner after six weeks." The figures there are only an example of the form, not a result.

## The traps

- **Speech-to-text hides learner mistakes.** Transcription models tidy speech up, so 公園を行きました may come back as 公園に行きました. Accuracy has to be judged from audio, or with transcription told to keep errors, never from a cleaned transcript. Worth testing early. It's also a good thing to raise with Deepgram, since it's an ASR design question.
- **Settings change the numbers.** Moving from beginner to intermediate, or changing speed or time to answer, makes Ping harder. Compare within the same settings, or use the check-in.
- **Ping adapts too.** As Ping gets better at waiting, cut-offs fall whether or not the learner improved. Keep Ping's changes and learner metrics apart, with each call's engine and settings recorded beside its numbers.
- **Small numbers.** A few testers for a few weeks shows direction, not proof. Say so.
- **Don't optimize the wrong thing.** Streaks and minutes measure habit, not acquisition. Keep them, but don't call them learning.

## Privacy

The tiers follow Ping's existing rules:

1. **Numbers computed on the phone, for everyone,** including people who turned recording off: answer start time, pauses, speaking share, English share, help requests, stack words used. Only numbers and stack word ids go to the server, the same as today's timing numbers.
2. **Analysis of recorded calls:** grammar, accuracy, vocabulary level. Only for calls that were recorded. The Privacy Policy needs one more line first: recordings and transcripts are also analyzed to measure progress.
3. **Showing progress to the learner,** for example on Home: "You've said 5 of your saved words on calls." This is what makes it motivating and not just research.

## Why it's a moat

- **The data:** months of real learner speech, timing and outcomes, tied to what Ping did. That's hard to copy and gets more valuable with every call.
- **Personalization:** as a learner's answer start time shrinks, Ping can wait less. As stack words become spoken words, Ping can bring in new ones. The product adapts to measured progress, not just to settings.
- **Proof:** schools, companies and paying users want evidence that speaking improved. A defensible before-and-after on the same check-in question is that evidence.
- **Later models:** learner-specific turn detection and error detection, trained on this data with consent.

## Suggested order

1. **Now:** the phone-computed numbers (tier 1), added to the per-call numbers Ping already sends. Includes stack-to-speech, since it's the clearest learning signal and the easiest to explain.
2. **Next:** the check-in question, plus an offline analysis script over recorded calls (tier 2), built like `evals/`.
3. **Then:** progress on Home (tier 3), once the numbers have been checked against your own reading of a few learners' calls.
