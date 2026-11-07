"""The parts of the end-of-turn benchmark that need no microphone, speaker or network:
finding pauses, reading and writing labels, and scoring each detector. Only needs numpy."""

from __future__ import annotations

import csv
import re
import statistics
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

BENCH_DIR = Path(__file__).resolve().parent
AUDIO_DIR = BENCH_DIR / "audio"
LABELS_CSV = BENCH_DIR / "labels.csv"
DECISIONS_CSV = BENCH_DIR / "decisions.csv"
RESULTS_CSV = BENCH_DIR / "results.csv"
RESULTS_MD = BENCH_DIR / "RESULTS.md"
ENV_FILE = BENCH_DIR / ".env"

SAMPLE_RATE = 16_000
LABEL_COLUMNS = ["clip", "pause_start_s", "pause_end_s", "label"]
LABELS = {"t": "thinking", "d": "done"}

MIN_PAUSE_S = 0.3  # shorter gaps are just the spaces between words
FRAME_S = 0.02
# A frame counts as silence below this point between the clip's background noise (0) and its speech (1).
# Relative to each clip, so quiet recordings and noisy rooms work the same way.
SILENCE_SHARE = 1 / 3
# Silence added after every clip, longer than any detector's own timeout, so a final pause can always be caught.
END_PAD_S = 9.0
# An end-of-turn event can arrive just after the user starts talking again. It still cuts them off.
LATE_EVENT_GRACE_S = 0.3


@dataclass(frozen=True)
class Pause:
    clip: str
    start_s: float
    end_s: float
    label: str | None = None


def find_pauses(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> list[tuple[float, float]]:
    """Pauses of at least MIN_PAUSE_S after the first speech, including one that runs to the end of the clip."""
    frame = int(FRAME_S * sample_rate)
    frames = len(audio) // frame
    if frames == 0:
        return []
    rms = np.sqrt(np.mean(audio[: frames * frame].reshape(frames, frame) ** 2, axis=1))
    loudness = 20 * np.log10(rms + 1e-10)
    noise_level, speech_level = np.percentile(loudness, [10, 95])
    silent = loudness < noise_level + SILENCE_SHARE * (speech_level - noise_level)

    pauses = []
    heard_speech = False
    run_start = None
    for index, is_silent in enumerate(silent):
        if not is_silent:
            if heard_speech and run_start is not None:
                pauses.append((run_start, index))
            heard_speech = True
            run_start = None
        elif heard_speech and run_start is None:
            run_start = index
    if heard_speech and run_start is not None:
        pauses.append((run_start, frames))

    return [
        (round(start * FRAME_S, 2), round(end * FRAME_S, 2))
        for start, end in pauses
        if (end - start) * FRAME_S >= MIN_PAUSE_S
    ]


def in_turns(groups: list[list]) -> list:
    """The first item of every group, then the second of every group, and so on."""
    longest = max((len(group) for group in groups), default=0)
    return [group[index] for index in range(longest) for group in groups if index < len(group)]


def is_final(pause: Pause, clip_seconds: float) -> bool:
    return pause.end_s >= clip_seconds - FRAME_S


def available_silence_s(pause: Pause, clip_seconds: float) -> float:
    """How long the silence lasts. A final pause runs on into the padding added after the clip."""
    length = pause.end_s - pause.start_s
    return length + END_PAD_S if is_final(pause, clip_seconds) else length


def next_free_clip_number(names: list[str]) -> int:
    """The lowest clip number not in use, so deleting a bad take frees its number for the retake."""
    used = {int(match.group(1)) for name in names if (match := re.fullmatch(r"clip_(\d+)\.wav", name))}
    number = 1
    while number in used:
        number += 1
    return number


def release_within(stop, seconds: float = 2.0) -> bool:
    """Runs `stop` in the background and waits at most `seconds` for it. Returns whether it finished.
    Releasing a microphone can hang on a Mac, especially with a Bluetooth headset, so nothing may wait on it forever."""
    worker = threading.Thread(target=stop, daemon=True)
    worker.start()
    worker.join(seconds)
    return not worker.is_alive()


def read_labels(path: Path = LABELS_CSV) -> list[Pause]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as file:
        return [
            Pause(row["clip"], float(row["pause_start_s"]), float(row["pause_end_s"]), row["label"])
            for row in csv.DictReader(file)
        ]


def append_label(pause: Pause, path: Path = LABELS_CSV) -> None:
    new_file = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        if new_file:
            writer.writerow(LABEL_COLUMNS)
        writer.writerow([pause.clip, f"{pause.start_s:.2f}", f"{pause.end_s:.2f}", pause.label])


def drop_labels(clip: str, path: Path = LABELS_CSV) -> int:
    """Removes a clip's labels, because a re-recorded clip has different pauses. Returns how many went."""
    kept = [pause for pause in read_labels(path) if pause.clip != clip]
    dropped = len(read_labels(path)) - len(kept)
    if dropped:
        path.unlink()
        for pause in kept:
            append_label(pause, path)
    return dropped


def decision(detector: str, setting: str, pause: Pause, ended: bool, catch_ms: float | None = None, detail: str = "") -> dict:
    """One detector's verdict on one pause. catch_ms is only kept for a done pause it ended."""
    return {
        "detector": detector,
        "setting": setting,
        "clip": pause.clip,
        "pause_start_s": pause.start_s,
        "pause_end_s": pause.end_s,
        "label": pause.label,
        "ended": ended,
        "catch_ms": round(catch_ms) if ended and pause.label == "done" and catch_ms is not None else None,
        "detail": detail,
    }


def silence_decisions(pauses: list[Pause], clip_seconds: dict[str, float], thresholds_s: list[float]) -> list[dict]:
    """Ping's current rule: the turn ends once the silence lasts as long as the threshold."""
    results = []
    for threshold in thresholds_s:
        for pause in pauses:
            ended = available_silence_s(pause, clip_seconds[pause.clip]) >= threshold
            results.append(decision("silence", f"{threshold:g}s", pause, ended, threshold * 1000))
    return results


def flux_decisions(pauses: list[Pause], end_of_turns_s: list[float], clip_seconds: float, setting: str) -> list[dict]:
    """Matches the times Flux ended a turn, in seconds from the start of the stream, to one clip's pauses."""
    results = []
    for pause in pauses:
        if pause.label == "done":
            window_end = pause.start_s + available_silence_s(pause, clip_seconds)
        else:
            window_end = pause.end_s + LATE_EVENT_GRACE_S
        inside = [time for time in end_of_turns_s if pause.start_s <= time <= window_end]
        first = min(inside) if inside else None
        catch_ms = (first - pause.start_s) * 1000 if first is not None else None
        results.append(decision("flux", setting, pause, first is not None, catch_ms))
    return results


def summarize(decisions: list[dict]) -> list[dict]:
    """Cut-off rate, catch rate and median time to catch, per detector and setting."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in decisions:
        groups.setdefault((row["detector"], row["setting"]), []).append(row)
    summary = []
    for (detector, setting), rows in groups.items():
        thinking = [row for row in rows if row["label"] == "thinking"]
        done = [row for row in rows if row["label"] == "done"]
        catches = [row["catch_ms"] for row in done if row["ended"] and row["catch_ms"] is not None]
        summary.append(
            {
                "detector": detector,
                "setting": setting,
                "thinking_pauses": len(thinking),
                "done_pauses": len(done),
                "cutoff_rate": round(sum(row["ended"] for row in thinking) / len(thinking), 3) if thinking else None,
                "catch_rate": round(sum(row["ended"] for row in done) / len(done), 3) if done else None,
                "median_catch_ms": round(statistics.median(catches)) if catches else None,
            }
        )
    return summary


def load_env(path: Path = ENV_FILE) -> dict[str, str]:
    """Reads KEY=value lines, so the bench needs no extra package for one setting."""
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_clip(path: Path) -> np.ndarray:
    """Loads a 16 kHz mono clip as float32 in -1 to 1."""
    import soundfile

    audio, sample_rate = soundfile.read(path, dtype="float32", always_2d=True)
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"{path.name} is {sample_rate} Hz. The bench expects {SAMPLE_RATE} Hz clips from record.py.")
    return audio.mean(axis=1)
