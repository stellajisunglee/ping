"""Finds every pause over 300 ms in the recorded clips, plays the audio around it, and asks whether you
were still thinking (t) or done (d). Each answer is saved to labels.csv straight away, so you can stop
and pick up later. Pauses already labeled are skipped."""

from __future__ import annotations

import os
import sys

import sounddevice

from core import AUDIO_DIR, LABELS, SAMPLE_RATE, Pause, append_label, find_pauses, read_clip, read_labels

CONTEXT_BEFORE_S = 3.0  # enough of the sentence to remember what you were saying
CONTEXT_AFTER_S = 1.5  # enough to hear whether you carried on
TARGET_PAUSES = 60


def play(audio, start_s: float, end_s: float) -> None:
    sounddevice.play(audio[int(max(0, start_s) * SAMPLE_RATE) : int(end_s * SAMPLE_RATE)], SAMPLE_RATE)
    sounddevice.wait()


def main() -> None:
    labeled = read_labels()
    done_keys = {(pause.clip, round(pause.start_s, 2)) for pause in labeled}
    counts = {"thinking": sum(p.label == "thinking" for p in labeled), "done": sum(p.label == "done" for p in labeled)}
    clips = sorted(AUDIO_DIR.glob("clip_*.wav"))
    if not clips:
        print("No clips in bench/audio yet. Run record.py first.")
        return

    for path in clips:
        audio = read_clip(path)
        clip_seconds = len(audio) / SAMPLE_RATE
        for start_s, end_s in find_pauses(audio):
            if (path.name, start_s) in done_keys:
                continue
            final = end_s >= clip_seconds - 0.02
            where = "end of clip" if final else f"{end_s - start_s:.2f} s"
            print(f"\n{path.name}  pause at {start_s:.2f} s ({where})   labeled so far: {counts['thinking']} thinking, {counts['done']} done of ~{TARGET_PAUSES}")
            while True:
                play(audio, start_s - CONTEXT_BEFORE_S, end_s + CONTEXT_AFTER_S)
                answer = input("  t = still thinking, d = done, r = replay, s = skip, q = quit: ").strip().lower()
                if answer == "q":
                    return
                if answer == "s":
                    break
                if answer in LABELS:
                    label = LABELS[answer]
                    append_label(Pause(path.name, start_s, end_s, label))
                    counts[label] += 1
                    break
    print(f"\nAll pauses labeled: {counts['thinking']} thinking, {counts['done']} done.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nStopped. Every label so far is saved.")
    # The audio library's own shutdown can hang on a Mac, so leave without it. Labels are saved as you go.
    sys.stdout.flush()
    os._exit(0)
