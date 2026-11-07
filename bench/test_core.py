"""Checks the benchmark's pause finding and scoring without a microphone or network:
    python -m unittest discover bench"""

import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

from core import END_PAD_S, SAMPLE_RATE, Pause, append_label, drop_labels, find_pauses, flux_decisions, in_turns, labeling_order, next_free_clip_number, read_labels, release_within, silence_decisions, summarize


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

    def test_a_quiet_recording_still_has_its_pauses_found(self):
        # Like real clips: speech around -38 dB, a room around -65 dB, only about 27 dB apart.
        rng = np.random.default_rng(1)
        room = lambda seconds: rng.normal(0, 0.0006, int(seconds * SAMPLE_RATE)).astype(np.float32)
        speech = lambda seconds: tone(seconds) * 0.04 + room(seconds)
        audio = np.concatenate([room(0.5), speech(1.5), room(0.7), speech(1.5), room(0.5), speech(1.0), room(1.0)])
        self.assertEqual(len(find_pauses(audio)), 3)

    def test_a_click_before_speaking_does_not_make_a_pause(self):
        click = tone(0.04)
        audio = np.concatenate([quiet(0.3), click, quiet(1.2), tone(1.5), quiet(0.6), tone(1.0), quiet(1.0)])
        pauses = find_pauses(audio)
        self.assertEqual(len(pauses), 2, pauses)
        self.assertAlmostEqual(pauses[0][0], 3.04, delta=0.03)

    def test_a_breath_before_speaking_does_not_make_a_pause(self):
        breath = tone(0.4) * 0.15  # about 16 dB quieter than the speech
        audio = np.concatenate([quiet(0.3), breath, quiet(1.0), tone(1.5), quiet(0.6), tone(1.0), quiet(1.0)])
        pauses = find_pauses(audio)
        self.assertEqual(len(pauses), 2, pauses)
        self.assertGreater(pauses[0][0], 3.0)

    def test_a_click_inside_a_pause_does_not_split_it(self):
        audio = np.concatenate([tone(1.0), quiet(0.5), tone(0.04), quiet(0.5), tone(1.0), quiet(1.0)])
        pauses = find_pauses(audio)
        self.assertEqual(len(pauses), 2, pauses)
        self.assertAlmostEqual(pauses[0][1] - pauses[0][0], 1.04, delta=0.05)

    def test_a_word_broken_by_tiny_gaps_is_still_one_sound(self):
        choppy = np.concatenate([tone(0.06), quiet(0.04), tone(0.06), quiet(0.04), tone(0.06)])
        audio = np.concatenate([quiet(0.5), choppy, quiet(0.8), tone(1.0), quiet(1.0)])
        pauses = find_pauses(audio)
        self.assertEqual(len(pauses), 2, pauses)

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


class ClipFiles(unittest.TestCase):
    def test_new_clips_take_the_lowest_free_number(self):
        self.assertEqual(next_free_clip_number([]), 1)
        self.assertEqual(next_free_clip_number([".DS_Store", "clip_001.wav", "clip_002.wav"]), 3)
        self.assertEqual(next_free_clip_number(["clip_001.wav", "clip_003.wav"]), 2)
        self.assertEqual(next_free_clip_number(["clip_002.wav", "notes.txt"]), 1)

    def test_re_recording_a_clip_drops_only_its_labels(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "labels.csv"
            for pause in [Pause("clip_001.wav", 1.0, 2.0, "thinking"), Pause("clip_002.wav", 1.0, 2.0, "done"), Pause("clip_001.wav", 3.0, 4.0, "done")]:
                append_label(pause, path)
            self.assertEqual(drop_labels("clip_001.wav", path), 2)
            self.assertEqual([pause.clip for pause in read_labels(path)], ["clip_002.wav"])
            self.assertEqual(drop_labels("clip_009.wav", path), 0)


class LabelingOrder(unittest.TestCase):
    def test_pauses_come_from_each_clip_in_turn(self):
        self.assertEqual(in_turns([["a1", "a2", "a3"], ["b1"], [], ["c1", "c2"]]), ["a1", "b1", "c1", "a2", "c2", "a3"])
        self.assertEqual(in_turns([]), [])

    def test_final_pauses_come_first_then_the_rest_in_turn(self):
        clips = [["a1", "a2", "a-end"], ["b1", "b-end"], ["c1", "c2"]]
        order = labeling_order(clips, lambda pause: pause.endswith("end"))
        self.assertEqual(order, ["a-end", "b-end", "a1", "b1", "c1", "a2", "c2"])


class ReleasingTheMicrophone(unittest.TestCase):
    def test_a_quick_release_reports_success(self):
        released = []
        self.assertTrue(release_within(lambda: released.append(True)))
        self.assertEqual(released, [True])

    def test_a_stuck_release_gives_up_instead_of_hanging(self):
        stuck = threading.Event()
        self.assertFalse(release_within(stuck.wait, seconds=0.1))
        stuck.set()


if __name__ == "__main__":
    unittest.main()
