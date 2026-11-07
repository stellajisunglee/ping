"""Checks the benchmark's pause finding and scoring without a microphone or network:
    python -m unittest discover bench"""

import unittest

import numpy as np

from core import END_PAD_S, SAMPLE_RATE, Pause, find_pauses, flux_decisions, silence_decisions, summarize


def tone(seconds: float) -> np.ndarray:
    times = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (0.3 * np.sin(2 * np.pi * 220 * times)).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)


class FindPauses(unittest.TestCase):
    def test_finds_pauses_between_speech_and_at_the_end_but_not_before_speech(self):
        audio = np.concatenate([quiet(0.5), tone(1.0), quiet(0.6), tone(1.0), quiet(0.2), tone(0.5), quiet(1.0)])
        pauses = find_pauses(audio)
        self.assertEqual(len(pauses), 2, pauses)
        self.assertAlmostEqual(pauses[0][0], 1.5, delta=0.03)
        self.assertAlmostEqual(pauses[0][1], 2.1, delta=0.03)
        self.assertAlmostEqual(pauses[1][1], len(audio) / SAMPLE_RATE, delta=0.03)

    def test_quiet_room_noise_still_counts_as_silence(self):
        noise = np.random.default_rng(0).normal(0, 0.001, int(0.8 * SAMPLE_RATE)).astype(np.float32)
        audio = np.concatenate([tone(1.0), noise, tone(1.0)])
        self.assertEqual(len(find_pauses(audio)), 1)

    def test_silent_clip_has_no_pauses(self):
        self.assertEqual(find_pauses(quiet(2.0)), [])


CLIP_SECONDS = {"a.wav": 10.0}
THINKING = Pause("a.wav", 2.0, 3.0, "thinking")  # a one-second thinking pause
DONE = Pause("a.wav", 9.0, 10.0, "done")  # the final pause, which runs on into the padding


class SilenceBaseline(unittest.TestCase):
    def test_short_threshold_cuts_off_a_one_second_pause_and_longer_ones_do_not(self):
        rows = silence_decisions([THINKING, DONE], CLIP_SECONDS, [0.8, 1.3])
        by_setting = {(row["setting"], row["label"]): row for row in rows}
        self.assertTrue(by_setting[("0.8s", "thinking")]["ended"])
        self.assertFalse(by_setting[("1.3s", "thinking")]["ended"])
        self.assertTrue(by_setting[("1.3s", "done")]["ended"])
        self.assertEqual(by_setting[("1.3s", "done")]["catch_ms"], 1300)


class FluxMatching(unittest.TestCase):
    def test_an_end_of_turn_inside_a_thinking_pause_is_a_cut_off(self):
        rows = flux_decisions([THINKING, DONE], [2.5, 9.8], 10.0, "default")
        self.assertTrue(rows[0]["ended"])
        self.assertTrue(rows[1]["ended"])
        self.assertEqual(rows[1]["catch_ms"], 800)

    def test_an_end_of_turn_arriving_just_after_speech_resumes_still_counts(self):
        rows = flux_decisions([THINKING], [3.2], 10.0, "default")
        self.assertTrue(rows[0]["ended"])

    def test_a_final_pause_can_be_caught_in_the_padding_but_not_after_it(self):
        caught = flux_decisions([DONE], [9.0 + 1.0 + END_PAD_S - 0.5], 10.0, "patient")
        missed = flux_decisions([DONE], [9.0 + 1.0 + END_PAD_S + 0.5], 10.0, "patient")
        self.assertTrue(caught[0]["ended"])
        self.assertFalse(missed[0]["ended"])

    def test_no_end_of_turn_means_no_cut_off_and_no_catch(self):
        rows = flux_decisions([THINKING, DONE], [], 10.0, "default")
        self.assertEqual([row["ended"] for row in rows], [False, False])


class Summary(unittest.TestCase):
    def test_rates_and_median_per_detector_and_setting(self):
        thinking = [Pause("a.wav", start, start + 1.0, "thinking") for start in (1.0, 3.0, 5.0, 7.0)]
        rows = flux_decisions(thinking + [DONE], [1.5, 9.4], 10.0, "default")
        [summary] = summarize(rows)
        self.assertEqual(summary["thinking_pauses"], 4)
        self.assertEqual(summary["cutoff_rate"], 0.25)
        self.assertEqual(summary["catch_rate"], 1.0)
        self.assertEqual(summary["median_catch_ms"], 400)


if __name__ == "__main__":
    unittest.main()
