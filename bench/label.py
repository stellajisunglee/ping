"""Finds every pause over 300 ms in the recorded clips, plays the audio around it, and asks whether you
were still thinking (t) or done (d). A soft beep marks where the pause being asked about starts. Each answer is saved to labels.csv straight away, so you can stop
and pick up later. Pauses already labeled are skipped.

Each clip's final pause comes first, since those are nearly all the "done" pauses. The rest come
one clip at a time in turn, so wherever you stop, the labels are spread across every question and take."""

from __future__ import annotations

import os
import sys

import sounddevice

from core import AUDIO_DIR, LABELS, SAMPLE_RATE, Pause, append_label, find_pauses, labeling_order, read_clip, read_labels, with_beep

CONTEXT_BEFORE_S = 3.0  # enough of the sentence to remember what you were saying
CONTEXT_AFTER_S = 1.5  # enough to hear whether you carried on
TARGET_PAUSES = 60


def play(audio, pause_start_s: float, pause_end_s: float) -> None:
    """Plays the speech before the pause, a soft beep where the pause starts, then the pause and what came after."""
    start_s = max(0.0, pause_start_s - CONTEXT_BEFORE_S)
    snippet = audio[int(start_s * SAMPLE_RATE) : int((pause_end_s + CONTEXT_AFTER_S) * SAMPLE_RATE)]
    sounddevice.play(with_beep(snippet, pause_start_s - start_s), SAMPLE_RATE)
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
    to_label = labeling_order(pauses_by_clip, lambda pause: pause[2] >= len(audio[pause[0]]) / SAMPLE_RATE - 0.02)
    print(f"{len(to_label)} pauses left to label.")

    for name, start_s, end_s in to_label:
        clip = audio[name]
        final = end_s >= len(clip) / SAMPLE_RATE - 0.02
        where = "end of clip" if final else f"{end_s - start_s:.2f} s"
        print(f"\n{name}  pause at {start_s:.2f} s ({where})   labeled so far: {counts['thinking']} thinking, {counts['done']} done of ~{TARGET_PAUSES}")
        while True:
            play(clip, start_s, end_s)
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
