import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logMelFeatures, melFilters, N_FRAMES, N_MELS, SAMPLE_RATE } from '../public/features.js';

// Made by bench/'s Python, with the same feature extractor the benchmark used, on synthetic audio.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/smart-turn-features.json', import.meta.url), 'utf8'));

// The same synthetic audio as the fixture: a few tones, one wobbling, so every mel band has something in it.
function synth(seconds) {
  return Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, n) => {
    const t = n / SAMPLE_RATE;
    return (
      0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) +
      0.1 * Math.sin(2 * Math.PI * 1375 * t) +
      0.05 * Math.sin(2 * Math.PI * 3100 * t * (1 + 0.1 * Math.sin(2 * Math.PI * 0.5 * t)))
    );
  });
}

test('the features match Python for short audio, padded at the start, and long audio, cut to the last 8 seconds', () => {
  for (const { seconds, frames, values } of fixture.cases) {
    const features = logMelFeatures(synth(seconds));
    assert.equal(features.length, N_MELS * N_FRAMES);
    let worst = 0;
    frames.forEach((frame, row) => {
      for (let mel = 0; mel < N_MELS; mel++) worst = Math.max(worst, Math.abs(features[mel * N_FRAMES + frame] - values[row][mel]));
    });
    assert.ok(worst < 1e-4, `${seconds} s audio differs from Python by ${worst}`);
  }
});

test('every mel filter covers some frequencies, and none are negative', () => {
  const filters = melFilters();
  const bins = filters.length / N_MELS;
  for (let mel = 0; mel < N_MELS; mel++) {
    const row = filters.subarray(mel * bins, (mel + 1) * bins);
    assert.ok(row.some((weight) => weight > 0), `filter ${mel}`);
    assert.ok(row.every((weight) => weight >= 0), `filter ${mel}`);
  }
});

test('silence gives finite features rather than failing', () => {
  const features = logMelFeatures(new Float32Array(SAMPLE_RATE));
  assert.ok(features.every(Number.isFinite));
});
