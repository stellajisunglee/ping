// Turns 16 kHz audio into the log-mel spectrogram Smart Turn expects. It matches what
// transformers' WhisperFeatureExtractor(chunk_length=8) produces, which is what the benchmark used:
// the last 8 seconds (zero-padded at the start), normalized, then 80 mel bands x 800 frames of 10 ms.
// Plain JavaScript with no dependencies, so it runs in the browser and in node --test alike.

export const SAMPLE_RATE = 16_000;
export const SECONDS = 8;
export const N_MELS = 80;
export const N_FRAMES = 800;
const N_SAMPLES = SECONDS * SAMPLE_RATE;
const N_FFT = 400; // 25 ms windows
const HOP = 160; // 10 ms apart
const N_BINS = N_FFT / 2 + 1;

// Slaney mel scale, as in librosa and transformers.
const MIN_LOG_HZ = 1000;
const HZ_PER_MEL = 200 / 3;
const MIN_LOG_MEL = MIN_LOG_HZ / HZ_PER_MEL;
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = (hz) => (hz < MIN_LOG_HZ ? hz / HZ_PER_MEL : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP);
const melToHz = (mel) => (mel < MIN_LOG_MEL ? mel * HZ_PER_MEL : MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)));

/** Triangular mel filters, N_MELS rows of N_BINS weights, Slaney-normalized. Mostly zeros. */
export function melFilters() {
  const low = hzToMel(0);
  const high = hzToMel(SAMPLE_RATE / 2);
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(low + ((high - low) * i) / (N_MELS + 1)));
  const filters = new Float64Array(N_MELS * N_BINS);
  for (let m = 0; m < N_MELS; m++) {
    const norm = 2 / (edges[m + 2] - edges[m]);
    for (let k = 0; k < N_BINS; k++) {
      const hz = (k * (SAMPLE_RATE / 2)) / (N_BINS - 1);
      const rising = (hz - edges[m]) / (edges[m + 1] - edges[m]);
      const falling = (edges[m + 2] - hz) / (edges[m + 2] - edges[m + 1]);
      filters[m * N_BINS + k] = Math.max(0, Math.min(rising, falling)) * norm;
    }
  }
  return filters;
}

// The FFT. A 400-point real FFT is done as a 200-point complex one (200 = 2^3 x 5^2, mixed radix),
// then untangled. A plain DFT would be about 50 times slower.
const HALF = N_FFT / 2;
function factorize(n) {
  const factors = [];
  for (const p of [2, 3, 5]) while (n % p === 0) (factors.push(p), (n /= p));
  if (n !== 1) throw new Error('FFT size must factor into 2, 3 and 5');
  return factors;
}
const FACTORS = factorize(HALF);
const TWIDDLE_RE = Float64Array.from({ length: HALF }, (_, i) => Math.cos((-2 * Math.PI * i) / HALF));
const TWIDDLE_IM = Float64Array.from({ length: HALF }, (_, i) => Math.sin((-2 * Math.PI * i) / HALF));
const UNTANGLE_RE = Float64Array.from({ length: HALF + 1 }, (_, k) => Math.cos((-2 * Math.PI * k) / N_FFT));
const UNTANGLE_IM = Float64Array.from({ length: HALF + 1 }, (_, k) => Math.sin((-2 * Math.PI * k) / N_FFT));
const SCRATCH_RE = new Float64Array(5);
const SCRATCH_IM = new Float64Array(5);

function complexFft(inRe, inIm, inOffset, stride, n, level, outRe, outIm, outOffset) {
  const p = FACTORS[level];
  const m = n / p;
  if (m === 1) {
    for (let q = 0; q < p; q++) {
      outRe[outOffset + q] = inRe[inOffset + q * stride];
      outIm[outOffset + q] = inIm[inOffset + q * stride];
    }
  } else {
    for (let r = 0; r < p; r++) complexFft(inRe, inIm, inOffset + r * stride, stride * p, m, level + 1, outRe, outIm, outOffset + r * m);
  }
  const step = HALF / n; // twiddles for size n are every step-th entry of the table
  if (p === 2) {
    for (let k = 0; k < m; k++) {
      const a = outOffset + k;
      const b = a + m;
      const t = k * step;
      const bRe = outRe[b] * TWIDDLE_RE[t] - outIm[b] * TWIDDLE_IM[t];
      const bIm = outRe[b] * TWIDDLE_IM[t] + outIm[b] * TWIDDLE_RE[t];
      outRe[b] = outRe[a] - bRe;
      outIm[b] = outIm[a] - bIm;
      outRe[a] += bRe;
      outIm[a] += bIm;
    }
    return;
  }
  // Sharing these is safe: the smaller FFTs above have all finished before this loop runs.
  const re = SCRATCH_RE;
  const im = SCRATCH_IM;
  for (let k = 0; k < m; k++) {
    for (let r = 0; r < p; r++) ((re[r] = outRe[outOffset + r * m + k]), (im[r] = outIm[outOffset + r * m + k]));
    for (let q = 0; q < p; q++) {
      const bin = k + q * m;
      let sumRe = 0;
      let sumIm = 0;
      for (let r = 0; r < p; r++) {
        const t = ((r * bin) % n) * step;
        sumRe += re[r] * TWIDDLE_RE[t] - im[r] * TWIDDLE_IM[t];
        sumIm += re[r] * TWIDDLE_IM[t] + im[r] * TWIDDLE_RE[t];
      }
      outRe[outOffset + bin] = sumRe;
      outIm[outOffset + bin] = sumIm;
    }
  }
}

const PACKED_RE = new Float64Array(HALF);
const PACKED_IM = new Float64Array(HALF);
const OUT_RE = new Float64Array(HALF);
const OUT_IM = new Float64Array(HALF);

/** Power spectrum |X[k]|^2 for k = 0..200 of a 400-sample real frame. */
function powerSpectrum(frame, power) {
  for (let n = 0; n < HALF; n++) ((PACKED_RE[n] = frame[2 * n]), (PACKED_IM[n] = frame[2 * n + 1]));
  complexFft(PACKED_RE, PACKED_IM, 0, 1, HALF, 0, OUT_RE, OUT_IM, 0);
  for (let k = 0; k <= HALF; k++) {
    const a = k % HALF;
    const b = (HALF - k) % HALF;
    // Even samples' spectrum: (Z[k] + conj Z[-k]) / 2. Odd samples': (Z[k] - conj Z[-k]) / 2i.
    const evenRe = (OUT_RE[a] + OUT_RE[b]) / 2;
    const evenIm = (OUT_IM[a] - OUT_IM[b]) / 2;
    const oddRe = (OUT_IM[a] + OUT_IM[b]) / 2;
    const oddIm = -(OUT_RE[a] - OUT_RE[b]) / 2;
    const re = evenRe + oddRe * UNTANGLE_RE[k] - oddIm * UNTANGLE_IM[k];
    const im = evenIm + oddRe * UNTANGLE_IM[k] + oddIm * UNTANGLE_RE[k];
    power[k] = re * re + im * im;
  }
}

const HANN = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
// Each filter only covers a few FFT bins, so keep just that range: about 50 times less work than the full matrix.
let sparseFilters;
function getSparseFilters() {
  if (sparseFilters) return sparseFilters;
  const dense = melFilters();
  sparseFilters = Array.from({ length: N_MELS }, (_, m) => {
    const row = dense.subarray(m * N_BINS, (m + 1) * N_BINS);
    let first = row.findIndex((w) => w > 0);
    if (first < 0) first = 0;
    let last = first;
    for (let k = first; k < N_BINS; k++) if (row[k] > 0) last = k;
    return { first, weights: row.slice(first, last + 1) };
  });
  return sparseFilters;
}

/** Log-mel features for Smart Turn: a Float32Array of N_MELS x N_FRAMES, mel band by mel band. */
export function logMelFeatures(audio) {
  // The last 8 seconds, zero-padded at the start, as Pipecat does.
  const clip = new Float64Array(N_SAMPLES);
  const kept = audio.subarray ? audio.subarray(Math.max(0, audio.length - N_SAMPLES)) : audio.slice(-N_SAMPLES);
  const padding = N_SAMPLES - kept.length;
  clip.set(kept, padding);

  // Zero mean and unit variance over all 8 seconds, padding included.
  let mean = 0;
  for (const x of clip) mean += x;
  mean /= N_SAMPLES;
  let variance = 0;
  for (const x of clip) variance += (x - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / N_SAMPLES + 1e-7);

  // Reflect-pad by half a window on each side, so frame t is centered on sample t x HOP.
  const half = N_FFT / 2;
  const padded = new Float64Array(N_SAMPLES + N_FFT);
  for (let i = 0; i < padded.length; i++) {
    let j = i - half;
    if (j < 0) j = -j;
    else if (j >= N_SAMPLES) j = 2 * (N_SAMPLES - 1) - j;
    padded[i] = (clip[j] - mean) * scale;
  }

  const filters = getSparseFilters();
  const features = new Float32Array(N_MELS * N_FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  // Frames that fall entirely inside the start padding are all identical, so compute one and copy it.
  const silentFrames = padding > half ? Math.max(0, Math.floor((padding - N_FFT) / HOP) + 1) : 0;
  let loudest = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    // Whisper computes 801 frames and drops the last, so frames 0 to 799 are all that's needed.
    if (t > 0 && t < silentFrames) {
      for (let m = 0; m < N_MELS; m++) features[m * N_FRAMES + t] = features[m * N_FRAMES];
      continue;
    }
    const start = t * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = padded[start + i] * HANN[i];
    powerSpectrum(frame, power);
    for (let m = 0; m < N_MELS; m++) {
      const { first, weights } = filters[m];
      let energy = 0;
      for (let k = 0; k < weights.length; k++) energy += weights[k] * power[first + k];
      const value = Math.log10(Math.max(energy, 1e-10));
      features[m * N_FRAMES + t] = value;
      if (value > loudest) loudest = value;
    }
  }
  // Keep 80 dB of range below the loudest point, then scale to roughly -1 to 1.
  for (let i = 0; i < features.length; i++) features[i] = (Math.max(features[i], loudest - 8) + 4) / 4;
  return features;
}
