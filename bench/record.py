"""Records answers as 16 kHz mono WAV clips in bench/audio/, named clip_001.wav, clip_002.wav and so on.
Press Enter to start a clip and Enter again to stop. Type q and Enter to finish."""

from __future__ import annotations

import re

import numpy as np
import sounddevice
import soundfile

from core import AUDIO_DIR, SAMPLE_RATE


def next_clip_number() -> int:
    numbers = [int(match.group(1)) for path in AUDIO_DIR.glob("clip_*.wav") if (match := re.fullmatch(r"clip_(\d+)\.wav", path.name))]
    return max(numbers, default=0) + 1


def record_clip(path) -> float:
    chunks = []
    stream = sounddevice.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", callback=lambda data, *_: chunks.append(data.copy()))
    with stream:
        input("  Recording. Answer, then stay quiet for a second, then press Enter to stop.")
    audio = np.concatenate(chunks)[:, 0] if chunks else np.zeros(0, dtype=np.float32)
    soundfile.write(path, audio, SAMPLE_RATE, subtype="PCM_16")
    return len(audio) / SAMPLE_RATE


def main() -> None:
    AUDIO_DIR.mkdir(exist_ok=True)
    while True:
        path = AUDIO_DIR / f"clip_{next_clip_number():03d}.wav"
        if input(f"Press Enter to record {path.name}, or q then Enter to finish: ").strip().lower() == "q":
            break
        seconds = record_clip(path)
        print(f"  Saved {path.name} ({seconds:.1f} s)")


if __name__ == "__main__":
    main()
