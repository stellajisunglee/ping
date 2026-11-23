"""Checks the streaming detectors against a fake service on this computer, so no credit is spent:
    python -m unittest discover bench"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from websockets.exceptions import ConnectionClosed

import run
from core import SAMPLE_RATE, Pause, decision, read_decisions


class FakeCartesia:
    """Speaks Ink-2's turns WebSocket: ends a turn once 0.3 s of audio has arrived, closes on {"type": "close"}."""

    def __init__(self, fail=False):
        self.fail = fail
        self.query = None
        self.key = None
        self.audio_bytes = 0
        self.closed_by_client = False

    async def handler(self, connection):
        self.query = parse_qs(urlparse(connection.request.path).query)
        self.key = connection.request.headers.get("X-API-Key")
        await connection.send(json.dumps({"type": "connected", "request_id": "r"}))
        if self.fail:
            await connection.send(json.dumps({"type": "error", "status_code": 400, "error_code": "model_not_found", "request_id": "r"}))
        sent_end = False
        try:
            await self.listen(connection, sent_end)
        except ConnectionClosed:
            pass  # the client gave up after an error

    async def listen(self, connection, sent_end):
        async for message in connection:
            if isinstance(message, bytes):
                self.audio_bytes += len(message)
                if not sent_end and self.audio_bytes >= 0.3 * SAMPLE_RATE * 2:
                    sent_end = True
                    await connection.send(json.dumps({"type": "turn.eager_end", "transcript": "はい", "request_id": "r", "turn_id": "t"}))
                    await connection.send(json.dumps({"type": "turn.end", "transcript": "はい", "request_id": "r", "turn_id": "t"}))
            elif json.loads(message) == {"type": "close"}:
                self.closed_by_client = True
                await connection.close()


async def stream_to(fake, setting):
    from websockets.asyncio.server import serve

    async with serve(fake.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        audio = np.zeros(int(0.5 * SAMPLE_RATE), dtype=np.float32)
        return await run.ink_end_of_turns("test-key", audio, setting, url=f"ws://127.0.0.1:{port}/stt/turns/websocket")


class InkStreaming(unittest.TestCase):
    def setUp(self):
        self.pad = run.END_PAD_S
        run.END_PAD_S = 0  # no 9 s of trailing silence in a test

    def tearDown(self):
        run.END_PAD_S = self.pad

    def test_streams_pcm_with_the_key_and_version_and_counts_only_turn_end(self):
        fake = FakeCartesia()
        times = asyncio.run(stream_to(fake, run.INK_SETTINGS["patient"]))
        self.assertEqual(len(times), 1, "turn.eager_end is only a hint")
        self.assertAlmostEqual(times[0], 0.3, delta=0.15)
        self.assertEqual(fake.key, "test-key")
        self.assertEqual(fake.query["model"], ["ink-2"])
        self.assertEqual(fake.query["encoding"], ["pcm_s16le"])
        self.assertEqual(fake.query["sample_rate"], ["16000"])
        self.assertEqual(fake.query["cartesia_version"], [run.INK_VERSION])
        self.assertEqual(fake.query["turn_end_threshold"], ["0.1"])
        self.assertNotIn("language_hint", fake.query, "Ink-2 refuses language_hint")
        self.assertEqual(fake.audio_bytes, int(0.5 * SAMPLE_RATE) * 2)
        self.assertTrue(fake.closed_by_client)

    def test_a_cartesia_error_stops_the_run(self):
        with self.assertRaisesRegex(RuntimeError, "Cartesia error"):
            asyncio.run(stream_to(FakeCartesia(fail=True), {}))

    def test_patient_thresholds_keep_cartesias_required_order(self):
        patient = run.INK_SETTINGS["patient"]
        self.assertGreater(patient["turn_start_threshold"], patient["turn_eager_end_threshold"])
        self.assertGreater(patient["turn_eager_end_threshold"], patient["turn_end_threshold"])


class SavedDecisions(unittest.TestCase):
    def test_decisions_read_back_with_their_types(self):
        rows = [
            decision("smart_turn", "v3.2", Pause("a.wav", 1.0, 2.0, "done"), True, 231.4, "p=0.9"),
            decision("flux", "default", Pause("a.wav", 3.0, 4.0, "thinking"), False),
        ]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "decisions.csv"
            run.write_csv(path, rows)
            back = read_decisions(path)
        self.assertEqual(back[0]["ended"], True)
        self.assertEqual(back[0]["catch_ms"], 231)
        self.assertEqual(back[1]["ended"], False)
        self.assertIsNone(back[1]["catch_ms"])
        self.assertEqual(back[1]["pause_start_s"], 3.0)


if __name__ == "__main__":
    unittest.main()
