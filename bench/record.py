"""Records answers as 16 kHz mono WAV clips in bench/audio/, named clip_001.wav, clip_002.wav and so on.
Each new clip takes the lowest free number, so to redo a take, delete its file and record again.
Press Enter to start a clip and Enter again to stop. Type q and Enter to finish."""

from __future__ import annotations

import os
import sys

import numpy as np
import sounddevice
import soundfile

from core import AUDIO_DIR, SAMPLE_RATE, drop_labels, next_free_clip_number, release_within


def stop_stream(stream) -> None:
    stream.abort(ignore_errors=True)
    stream.close(ignore_errors=True)


def record_clip(path) -> tuple[float, bool]:
    """Records until Enter, saves the clip, then lets go of the microphone. Returns the length and whether it let go."""
    chunks = []
    stream = sounddevice.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", callback=lambda data, *_: chunks.append(data.copy()))
    stream.start()
    try:
        input("  Recording. Answer, then stay quiet for a second, then press Enter to stop.")
    except KeyboardInterrupt:
        release_within(lambda: stop_stream(stream))
        raise
    # Save before letting go of the microphone, so a stuck microphone can't lose the recording.
    captured = list(chunks)
    audio = np.concatenate(captured)[:, 0] if captured else np.zeros(0, dtype=np.float32)
    soundfile.write(path, audio, SAMPLE_RATE, subtype="PCM_16")
    return len(audio) / SAMPLE_RATE, release_within(lambda: stop_stream(stream))


def main() -> None:
    AUDIO_DIR.mkdir(exist_ok=True)
    while True:
        path = AUDIO_DIR / f"clip_{next_free_clip_number([path.name for path in AUDIO_DIR.iterdir()]):03d}.wav"
        if input(f"Press Enter to record {path.name}, or q then Enter to finish: ").strip().lower() == "q":
            break
        seconds, released = record_clip(path)
        print(f"  Saved {path.name} ({seconds:.1f} s)")
        if not released:
            print("  The microphone didn't let go, which can happen with a Bluetooth headset. Your clip is saved.")
            print("  Run record.py again to carry on, ideally with the Mac's own microphone.")
            break
        if dropped := drop_labels(path.name):
            print(f"  Removed {dropped} old labels for {path.name}, since it's a new recording. Label it again with label.py.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nStopped. A clip still being recorded wasn't saved.")
    # The audio library's own shutdown can hang on a Mac, which is what stopped Ctrl+C from working.
    # Every finished clip is already saved, so leave without it.
    sys.stdout.flush()
    os._exit(0)
