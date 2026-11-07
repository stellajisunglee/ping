# End-of-turn benchmark

Compares end-of-turn detectors on Japanese learner speech, to decide whether Ping should move off silence detection. This folder runs only on your computer. It isn't part of the app and is never deployed.

It compares:
- **Silence,** Ping's current rule, at 0.8, 1.3 and 2.5 seconds.
- **Smart Turn v3.2,** Pipecat's open model, run on your laptop for free.
- **Deepgram Flux Multilingual,** at Deepgram's default and a more patient setting. This uses your Deepgram credit.

## Set up

Use Python 3.12 in a virtual environment inside this folder:

```bash
cd bench
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

If `python3.12 -m venv` fails with an `ensurepip` error, your Homebrew Python is broken. Let uv provide its own Python instead:

```bash
uv venv --python 3.12 --managed-python .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

For Deepgram, put your API key in `bench/.env`. The file already exists and git ignores it:

```
DEEPGRAM_API_KEY=your key here
```

## 1. Record

```bash
.venv/bin/python record.py
```

Press Enter to start a clip and Enter to stop. Clips are saved to `bench/audio/` as `clip_001.wav`, `clip_002.wav` and so on, and git ignores that folder. After you finish answering, stay quiet for about a second before stopping.

To redo a take, delete its file. The next recording takes the lowest free number, so the retake gets the same name. If that clip was already labeled, its old labels are removed so you can label it again.

Answer each of Ping's six questions out loud, in Japanese, three times each, for 18 clips:

| Question | English |
| --- | --- |
| 今日はどんな一日ですか？ | What kind of day are you having? |
| 今、何をしていますか？ | What are you doing right now? |
| 今日は何をしましたか？ | What did you do today? |
| 今日は何を食べましたか？ | What did you eat today? |
| 週末は何をしますか？ | What are you doing this weekend? |
| 最近、どうですか？ | How have things been lately? |

- **Take 1:** at your normal level.
- **Take 2:** a harder answer that makes you search for words, like describing something you don't have the vocabulary for.
- **Take 3:** switching to English when you get stuck.

## 2. Label

```bash
.venv/bin/python label.py
```

It finds every pause over 300 ms, plays the 3 seconds before it and 1.5 seconds after it, and asks:
- `t` if you were still thinking
- `d` if you were done
- `r` to replay, `s` to skip, `q` to quit

Labels go to `labels.csv` as you go, so you can stop and come back later. Aim for about 60 labeled pauses, roughly two thirds of them `t`.

## 3. Run

```bash
.venv/bin/python run.py
```

It prints a comparison table and writes:
- `results.csv`: one row per detector and setting
- `decisions.csv`: every detector's verdict on every pause, for digging into why
- `RESULTS.md`: a draft write-up, created only if it doesn't exist yet, so your own edits are never overwritten

Before streaming to Deepgram, it shows how many minutes of audio it will send and the estimated cost, and asks first. 18 clips cost well under $1. To run only the free detectors, use `.venv/bin/python run.py --skip-flux`.

Smart Turn downloads its 9 MB model from Hugging Face on the first run.

## How each detector is scored

- **Cut-off rate:** the share of "still thinking" pauses where the detector ended the turn. Lower is better.
- **Catch rate:** the share of "done" pauses where it ended the turn. Higher is better.
- **Median time to catch:** how long after a "done" pause began the detector ended the turn.

Details:
- **Silence:** ends the turn once a pause reaches the threshold.
- **Smart Turn:** hears the clip up to 200 ms into each pause, which is when a voice detector would ask it, and a probability of 0.5 or more means done. Its time to catch is 200 ms plus the measured inference time.
- **Flux:** each clip is streamed at real-time speed in 80 ms chunks, and every `EndOfTurn` event is timed from the start of the stream.
  - An event inside a "thinking" pause counts as a cut-off, including one that arrives up to 0.3 seconds after you started talking again.
  - Timeout-triggered ends count as catches.
- **Padding:** each clip gets 9 seconds of silence added at the end, longer than any detector's timeout, so the final pause can always be caught.

## Privacy

Your recordings stay in `bench/audio/` on your computer, and git ignores them. Silence and Smart Turn never send audio anywhere. Flux streams each clip to Deepgram, which processes it under Deepgram's own data policy.

## Tests

```bash
.venv/bin/python -m unittest discover -s .
```

These check pause finding and scoring with generated audio, with no microphone or network needed.
