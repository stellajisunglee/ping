// Ping's reply arrives as text within a second, but takes several seconds to say. Over WebRTC, OpenAI
// sends no timing for individual words, so this estimates how much of a reply has been said, to show
// words as they're spoken. Plain functions with no browser code, so they can be tested.

// Spoken Japanese at speed 1.0, in the units below, until the call has measured Ping's real pace.
export const DEFAULT_UNITS_PER_SECOND = 8;
// Bounds on a measured pace, so one odd reply can't make the text race ahead or crawl.
const MIN_UNITS_PER_SECOND = 3;
const MAX_UNITS_PER_SECOND = 20;
const MIN_MEASURED_MS = 3000; // trust the measurement once this much speech has been timed

const KANJI = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿｦ-ﾟ]/;
const LATIN = /[A-Za-z0-9]/;
const PAUSE = /[。、！？!?.,…]/;

/** Roughly how long a character takes to say: a kanji often has two sounds, an English letter is quick. */
export function unitsOf(char) {
  if (KANJI.test(char)) return 1.6;
  if (KANA.test(char)) return 1;
  if (LATIN.test(char)) return 0.35;
  if (PAUSE.test(char)) return 0.8; // a short pause in the voice
  return 0.3; // spaces and other marks
}

export const speechUnits = (text) => [...text].reduce((total, char) => total + unitsOf(char), 0);

/**
 * Ping's speaking pace for this call. It starts from the speed setting, then learns from every reply
 * that played to the end. Measured at speed 1, so a speed change mid-call still scales it.
 */
export function createPace() {
  let units = 0;
  let ms = 0; // at speed 1
  return {
    unitsPerMs(speed = 1) {
      const perSecond = ms >= MIN_MEASURED_MS ? (units / ms) * 1000 : DEFAULT_UNITS_PER_SECOND;
      return (Math.min(MAX_UNITS_PER_SECOND, Math.max(MIN_UNITS_PER_SECOND, perSecond)) * speed) / 1000;
    },
    /** A reply of `text` took `playedMs` to say at `speed`. */
    learn(text, playedMs, speed = 1) {
      if (!(playedMs > 0) || !text.trim()) return;
      units += speechUnits(text);
      ms += playedMs * speed;
    },
  };
}

/** How many characters of `text` have been said after `elapsedMs` of speech. */
export function charsSaid(text, elapsedMs, unitsPerMs) {
  let budget = Math.max(0, elapsedMs) * unitsPerMs;
  const chars = [...text];
  let count = 0;
  for (const char of chars) {
    budget -= unitsOf(char);
    if (budget < 0) break;
    count += char.length; // characters outside the basic plane take two code units
  }
  return count;
}
