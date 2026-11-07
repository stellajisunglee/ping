"""Finds every pause over 300 ms in the recorded clips, plays the audio around it, and asks whether you
were still thinking (t) or done (d). Each answer is saved to labels.csv straight away, so you can stop
and pick up later. Pauses already labeled are skipped.

Pauses come one clip at a time in turn (the first pause of every clip, then the second, and so on),
so wherever you stop, the labels are spread across every question and take."""

from __future__ import annotations

import os
import sys

import sounddevice

from core import AUDIO_DIR, LABELS, SAMPLE_RATE, Pause, append_label, find_pauses, in_turns, read_clip, read_labels

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

    audio = {path.name: read_clip(path) for path in clips}
    pauses_by_clip = [[(name, start_s, end_s) for start_s, end_s in find_pauses(clip) if (name, start_s) not in done_keys] for name, clip in audio.items()]
    to_label = in_turns(pauses_by_clip)
    print(f"{len(to_label)} pauses left to label.")

    for name, start_s, end_s in to_label:
        clip = audio[name]
        final = end_s >= len(clip) / SAMPLE_RATE - 0.02
        where = "end of clip" if final else f"{end_s - start_s:.2f} s"
        print(f"\n{name}  pause at {start_s:.2f} s ({where})   labeled so far: {counts['thinking']} thinking, {counts['done']} done of ~{TARGET_PAUSES}")
        while True:
            play(clip, start_s - CONTEXT_BEFORE_S, end_s + CONTEXT_AFTER_S)
            answer = input("  t = still thinking, d = done, r = replay, s = skip, q = quit: ").strip().lower()
            if answer == "q":
                return
            if answer == "s":
                break
            if answer in LABELS:
                label = LABELS[answer]
                append_label(Pause(name, start_s, end_s, label))
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
