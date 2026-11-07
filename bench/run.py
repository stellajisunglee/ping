"""Runs every end-of-turn detector on the labeled pauses and compares them.

    python bench/run.py               # all detectors (asks before spending Deepgram credit)
    python bench/run.py --skip-flux   # only the free, local ones

Writes decisions.csv (every verdict), results.csv (the summary) and, the first time, a draft RESULTS.md."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import time
from urllib.parse import urlencode

import numpy as np

from core import (
    AUDIO_DIR,
    DECISIONS_CSV,
    END_PAD_S,
    RESULTS_CSV,
    RESULTS_MD,
    SAMPLE_RATE,
    decision,
    flux_decisions,
    load_env,
    read_clip,
    read_labels,
    silence_decisions,
    summarize,
)

# Ping's current silence settings for short, normal and long time to answer.
SILENCE_THRESHOLDS_S = [0.8, 1.3, 2.5]

SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"
SMART_TURN_SECONDS = 8  # the model only looks at the last 8 seconds
# In a real pipeline a voice detector hears this much silence before asking Smart Turn.
SMART_TURN_AFTER_SILENCE_S = 0.2
SMART_TURN_DONE_AT = 0.5

FLUX_URL = "wss://api.deepgram.com/v2/listen"
FLUX_CHUNK_S = 0.08  # Deepgram strongly recommends 80 ms chunks
# Deepgram's default, and its own "high reliability" example for users who pause a lot.
FLUX_SETTINGS = {"default": {}, "patient": {"eot_threshold": 0.85, "eot_timeout_ms": 8000}}
FLUX_PRICE_PER_MINUTE = 0.0078  # Flux Multilingual, pay as you go
FLUX_PARALLEL_STREAMS = 4


class SmartTurn:
    """Pipecat's open Smart Turn v3 model, run the way its inference.py runs it."""

    def __init__(self) -> None:
        import onnxruntime
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor

        options = onnxruntime.SessionOptions()
        options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
        options.inter_op_num_threads = 1
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = onnxruntime.InferenceSession(hf_hub_download(SMART_TURN_REPO, SMART_TURN_FILE), sess_options=options)
        self.features = WhisperFeatureExtractor(chunk_length=SMART_TURN_SECONDS)

    def probability_done(self, audio: np.ndarray) -> float:
        samples = SMART_TURN_SECONDS * SAMPLE_RATE
        audio = audio[-samples:]
        audio = np.pad(audio, (samples - len(audio), 0))  # shorter clips are padded at the start, as Pipecat does
        inputs = self.features(audio, sampling_rate=SAMPLE_RATE, return_tensors="np", padding="max_length", max_length=samples, truncation=True, do_normalize=True)
        features = inputs.input_features.squeeze(0).astype(np.float32)[np.newaxis]
        return float(self.session.run(None, {"input_features": features})[0].reshape(-1)[0])


def smart_turn_decisions(pauses, clips) -> list[dict]:
    model = SmartTurn()
    results = []
    for pause in pauses:
        audio = clips[pause.clip]
        heard = audio[: int((pause.start_s + SMART_TURN_AFTER_SILENCE_S) * SAMPLE_RATE)]
        started = time.perf_counter()
        probability = model.probability_done(heard)
        inference_ms = (time.perf_counter() - started) * 1000
        ended = probability >= SMART_TURN_DONE_AT
        catch_ms = SMART_TURN_AFTER_SILENCE_S * 1000 + inference_ms
        results.append(decision("smart_turn", "v3.2", pause, ended, catch_ms, f"p={probability:.3f}"))
    return results


async def flux_end_of_turns(api_key: str, audio: np.ndarray, setting: dict) -> list[float]:
    """Streams one clip at real-time speed and returns when each end of turn arrived, in seconds from the start."""
    import websockets

    query = [("model", "flux-general-multi"), ("encoding", "linear16"), ("sample_rate", SAMPLE_RATE), ("language_hint", "ja"), ("language_hint", "en")]
    query += list(setting.items())
    padded = np.concatenate([audio, np.zeros(int(END_PAD_S * SAMPLE_RATE), dtype=np.float32)])
    pcm = (np.clip(padded, -1, 1) * 32767).astype("<i2").tobytes()
    chunk_bytes = int(FLUX_CHUNK_S * SAMPLE_RATE) * 2
    end_of_turns = []

    async with websockets.connect(f"{FLUX_URL}?{urlencode(query)}", additional_headers={"Authorization": f"Token {api_key}"}) as socket:
        loop = asyncio.get_running_loop()
        started = loop.time()

        async def send_audio():
            for index, offset in enumerate(range(0, len(pcm), chunk_bytes)):
                await socket.send(pcm[offset : offset + chunk_bytes])
                # Sleep to a schedule rather than a fixed time, so the stream never drifts slower than real time.
                await asyncio.sleep(max(0, started + (index + 1) * FLUX_CHUNK_S - loop.time()))
            await asyncio.sleep(1.0)
            await socket.send(json.dumps({"type": "CloseStream"}))

        async def receive_events():
            try:
                async for message in socket:
                    if isinstance(message, bytes):
                        continue
                    event = json.loads(message)
                    if event.get("type") == "Error":
                        raise RuntimeError(f"Deepgram error: {event}")
                    if event.get("type") == "TurnInfo" and event.get("event") == "EndOfTurn" and event.get("trigger") != "manual":
                        end_of_turns.append(loop.time() - started)
            except websockets.ConnectionClosed:
                pass  # Deepgram closes without a status code after CloseStream

        await asyncio.gather(send_audio(), receive_events())
    return end_of_turns


async def all_flux_decisions(api_key, pauses, clips) -> list[dict]:
    limit = asyncio.Semaphore(FLUX_PARALLEL_STREAMS)
    by_clip = {}
    for pause in pauses:
        by_clip.setdefault(pause.clip, []).append(pause)

    async def one(name, setting_name, setting):
        async with limit:
            times = await flux_end_of_turns(api_key, clips[name], setting)
            print(f"  flux {setting_name}: {name} done")
            return flux_decisions(by_clip[name], times, len(clips[name]) / SAMPLE_RATE, setting_name)

    jobs = [one(name, setting_name, setting) for name in by_clip for setting_name, setting in FLUX_SETTINGS.items()]
    return [row for rows in await asyncio.gather(*jobs) for row in rows]


def flux_minutes(clips) -> float:
    return sum(len(audio) / SAMPLE_RATE + END_PAD_S for audio in clips.values()) * len(FLUX_SETTINGS) / 60


def write_csv(path, rows) -> None:
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def percent(value) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def table(summary) -> str:
    lines = ["| Detector | Setting | Cut-off rate (lower is better) | Catch rate (higher is better) | Median time to catch |", "| --- | --- | --- | --- | --- |"]
    for row in summary:
        catch = "n/a" if row["median_catch_ms"] is None else f"{row['median_catch_ms']} ms"
        lines.append(f"| {row['detector']} | {row['setting']} | {percent(row['cutoff_rate'])} | {percent(row['catch_rate'])} | {catch} |")
    return "\n".join(lines)


def draft_write_up(summary, pauses) -> str:
    thinking = sum(pause.label == "thinking" for pause in pauses)
    done = len(pauses) - thinking
    return f"""# End-of-turn detection on Japanese learner speech

_Draft generated by bench/run.py. Rewrite the prose before publishing._

## Question

Ping is a language-practice app that phones learners for short conversations in Japanese. Learners pause mid-sentence to find words, so a voice agent that ends their turn on silence alone keeps cutting them off. Which end-of-turn detector tells "still thinking" from "done" best on this kind of speech?

## Method

- One speaker answered each of Ping's six daily questions three times: at a normal level, at a harder level that forced word searching, and mixing in English when stuck.
- Every pause over 300 ms was found with an energy threshold, and labeled by hand as still thinking ({thinking}) or done ({done}).
- Each detector judged every pause:
  - **Silence:** ends the turn when the pause reaches 0.8, 1.3 or 2.5 seconds, which are Ping's current settings.
  - **Smart Turn v3.2:** Pipecat's open model, run locally on the audio up to 200 ms into each pause. A probability of 0.5 or more means done.
  - **Deepgram Flux Multilingual:** each clip streamed at real-time speed with Japanese and English hints, at Deepgram's default settings and a more patient setting (eot_threshold 0.85, eot_timeout_ms 8000).
- A turn ended inside a "thinking" pause is a cut-off. For "done" pauses, the time to catch runs from the start of the pause.

## Results

{table(summary)}

## Limitations

- One speaker, and a small sample of {len(pauses)} pauses.
- The difficulty was staged: hard answers were chosen on purpose, which may not match how learners pause in real calls.
- Labels are one person's judgment of their own pauses.
- Smart Turn's time to catch counts its 200 ms trigger plus measured inference time, but not the voice detector it needs in a real pipeline. Missing a done pause there would normally fall back to a timeout.
- Flux times include network delay, because events are timed when they arrive.
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-flux", action="store_true", help="skip Deepgram Flux, which costs money")
    parser.add_argument("--skip-smart-turn", action="store_true", help="skip Smart Turn")
    parser.add_argument("--yes", action="store_true", help="don't ask before streaming to Deepgram")
    args = parser.parse_args()

    pauses = read_labels()
    if not pauses:
        print("No labels yet. Run record.py, then label.py.")
        return
    clips = {name: read_clip(AUDIO_DIR / name) for name in sorted({pause.clip for pause in pauses})}
    print(f"{len(pauses)} labeled pauses in {len(clips)} clips.")

    decisions = silence_decisions(pauses, {name: len(audio) / SAMPLE_RATE for name, audio in clips.items()}, SILENCE_THRESHOLDS_S)
    if not args.skip_smart_turn:
        print("Running Smart Turn locally...")
        decisions += smart_turn_decisions(pauses, clips)
    if not args.skip_flux:
        api_key = load_env().get("DEEPGRAM_API_KEY")
        if not api_key:
            print("No DEEPGRAM_API_KEY in bench/.env, so Flux was skipped.")
        else:
            minutes = flux_minutes(clips)
            question = f"Stream {minutes:.1f} minutes of audio to Deepgram, about ${minutes * FLUX_PRICE_PER_MINUTE:.2f}? [y/N] "
            if args.yes or input(question).strip().lower() == "y":
                print("Streaming to Deepgram Flux at real-time speed...")
                decisions += asyncio.run(all_flux_decisions(api_key, pauses, clips))

    summary = summarize(decisions)
    write_csv(DECISIONS_CSV, decisions)
    write_csv(RESULTS_CSV, summary)
    print()
    print(table(summary))
    if RESULTS_MD.exists():
        print("\nRESULTS.md already exists, so it was left alone. The new numbers are in results.csv.")
    else:
        RESULTS_MD.write_text(draft_write_up(summary, pauses), encoding="utf-8")
        print("\nWrote a draft RESULTS.md.")


if __name__ == "__main__":
    main()
