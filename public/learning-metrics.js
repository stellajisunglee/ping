// Turns what the learner said on a call into a few numbers about their Japanese, to track progress across calls.
// It runs on the phone after the call, from the transcript the phone already has, and sends numbers only: no
// words leave the phone this way. It has no browser code, so the server and the tests can use it too.
//
// Japanese has no spaces, so words are found with the built-in Japanese word splitter (Intl.Segmenter), and
// turn length is counted in Japanese characters. Everything here is an estimate: the transcript is speech
// recognition, which can mishear a learner.

import { isAizuchi } from './aizuchi.js';

const MAX_COUNT = 100_000;

// Everything the phone sends after a call. Whole numbers, or null where there's nothing to measure.
export const LEARNING_FIELDS = [
  'learnerTurns', // the learner's lines in the transcript
  'japaneseChars', // Japanese characters the learner said in all
  'avgTurnChars', // Japanese characters per learner line
  'englishTurnPercent', // share of the learner's lines that were mostly English, 0-100
  'newWords', // words added to the stack during the call
  'stackWordsUsed', // different words already in the stack that the learner said
  'helpRequests', // lines where the learner asked for help: what a word means, a translation, to repeat or slow down
  'distinctWords', // different Japanese words the learner used
  // Of those, how many are on each JLPT list, and how many on none (names, rare words, mishearings, verb endings).
  'jlptN5Words',
  'jlptN4Words',
  'jlptN3Words',
  'jlptN2Words',
  'jlptN1Words',
  'offListWords',
  // Signs of confidence in how they talk, added after the rest (so phones from before don't send them):
  'questionsAsked', // lines where the learner asked Ping something in Japanese, not counting asking for help
  'japaneseFillers', // えーと, あのー, うーん and the like: holding the turn the Japanese way while thinking
  'englishFillers', // um, uh, hmm
  'helpFollowUps', // times the learner asked for help and then said something else
  'japaneseAfterHelp', // of those, times their next line was in Japanese: carrying on after help, not giving up
  'learnerAizuchi', // lines that were only Japanese aizuchi (うん, へえ, なるほど): listening like a Japanese speaker
];

// The fields phones have sent from the start. The rest are optional, so an older phone is still accepted, and what it
// didn't send is saved as null (not measured), never 0.
const CORE_FIELDS = LEARNING_FIELDS.slice(0, LEARNING_FIELDS.indexOf('offListWords') + 1);
const MAY_BE_EMPTY = new Set(['avgTurnChars', 'englishTurnPercent']);
const PERCENT_FIELDS = new Set(['englishTurnPercent']);

const JAPANESE_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々]/gu;
const LATIN_LETTER = /[A-Za-z]/g;
const HAS_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// Asking for help, in English or Japanese. Kept to clear phrases, so ordinary answers don't count.
const HELP_PATTERNS = [
  /\bwhat (does|do|did) .+ mean\b/i,
  /\bwhat('s| is) .+ mean(ing)?\b/i,
  /\bmeaning of\b/i,
  /\btranslate\b|\bin english\b/i,
  /\b(don'?t|didn'?t|do not|did not) (understand|get it|know what)\b/i,
  /\b(say|repeat) (that|it) again\b|\brepeat\b|\bone more time\b|\bpardon\b/i,
  /\bslow(er)? down\b|\bmore slowly\b|\bspeak slower\b/i,
  /\bhow (do|would|should) (i|you) (say|answer)\b/i,
  /わかりません|わからない|分かりません|分からない/,
  /もう一度|もういちど|もう一回|もういっかい/,
  /ゆっくり/,
  /どういう意味|って何|ってなに|ってなん|英語で/,
];

const count = (text, pattern) => text.match(pattern)?.length ?? 0;

// Thinking sounds. Speech-to-text often leaves these out, so the counts are a floor, not the true number.
const JAPANESE_FILLER = /えー+っ?と|えっと|ええと|あの[ーう]+|うー+ん|んー+|えー+(?![っと])/gu;
const ENGLISH_FILLER = /\b(?:u+m+|u+h+|h+m+|e+r+m+)\b/gi;
// A Japanese question: ends in ？ or ?, or in か, かな or かね once the closing punctuation is taken off.
const QUESTION_END = /(?:[?？]|か|かな|かね)$/u;
const isQuestion = (text) => HAS_JAPANESE.test(text) && QUESTION_END.test(text.trim().replace(/[。．.!！…\s]+$/u, ''));

// The word list (public/jlpt-words.json) as a Map from a written form to its JLPT level, easiest level first.
export function wordLevels(list) {
  const levels = new Map();
  for (const [level, words] of Object.entries(list?.levels ?? {})) {
    for (const word of words.split('|')) if (word && !levels.has(word)) levels.set(word, level);
  }
  return levels;
}

// A word's level: as written, or for a verb or adjective seen without its ending, by its stem.
// 食べ (from 食べました) finds 食べる, and 忙し (from 忙しかった) finds 忙しい.
function levelOf(word, levels) {
  return levels.get(word) ?? levels.get(`${word}る`) ?? levels.get(`${word}い`) ?? null;
}

// The word splitter also returns particles (は, を), verb endings (ました) and fillers (えーと) as words, which
// would make every learner look like they use many words. So a piece only counts as a word if it has a kanji,
// is katakana of two or more characters, or is hiragana of three or more that isn't a filler or an ending.
const HAS_KANJI = /\p{Script=Han}/u;
const KATAKANA_WORD = /^[\p{Script=Katakana}ー]{2,}$/u;
const HIRAGANA_WORD = /^[\p{Script=Hiragana}ー]{3,}$/u;
const NOT_WORDS = new Set(['えーと', 'えっと', 'えーっと', 'あのー', 'あの', 'うーん', 'ええと', 'ました', 'ません', 'でした', 'ましょう', 'ている', 'ています', 'ので', 'から', 'けど', 'けれど', 'でしょう', 'ですね', 'ですか', 'ですよ']);

function isWord(piece) {
  if (NOT_WORDS.has(piece)) return false;
  return HAS_KANJI.test(piece) || KATAKANA_WORD.test(piece) || HIRAGANA_WORD.test(piece);
}

function japaneseWords(text, segmenter) {
  if (!segmenter) return [];
  return [...segmenter.segment(text)].filter((part) => part.isWordLike && HAS_JAPANESE.test(part.segment) && isWord(part.segment)).map((part) => part.segment);
}

// lines: the transcript, [{ from: 'you' | 'contact', text }]. stackWords: the stack as the call started.
// newWords: how many words were added during the call. levels: from wordLevels. segmenter: an
// Intl.Segmenter for Japanese words, if this browser has one (without it, the word counts are 0).
export function summarizeLearning({ lines = [], stackWords = [], newWords = 0, levels = new Map(), segmenter = null }) {
  const learner = lines.filter((line) => line.from === 'you' && typeof line.text === 'string' && line.text.trim());
  let japaneseChars = 0;
  let englishTurns = 0;
  let helpRequests = 0;
  let questionsAsked = 0;
  let japaneseFillers = 0;
  let englishFillers = 0;
  let helpFollowUps = 0;
  let japaneseAfterHelp = 0;
  let learnerAizuchi = 0;
  let afterHelp = false; // the learner's last line asked for help
  const words = new Set();
  for (const { text } of learner) {
    const japanese = count(text, JAPANESE_CHAR);
    const mostlyEnglish = count(text, LATIN_LETTER) > japanese;
    const askedForHelp = HELP_PATTERNS.some((pattern) => pattern.test(text));
    japaneseChars += japanese;
    if (mostlyEnglish) englishTurns += 1;
    if (askedForHelp) helpRequests += 1;
    if (afterHelp && !askedForHelp) {
      helpFollowUps += 1;
      if (japanese > 0 && !mostlyEnglish) japaneseAfterHelp += 1;
    }
    afterHelp = askedForHelp;
    if (!askedForHelp && isQuestion(text)) questionsAsked += 1;
    japaneseFillers += count(text, JAPANESE_FILLER);
    englishFillers += count(text, ENGLISH_FILLER);
    if (HAS_JAPANESE.test(text) && isAizuchi(text)) learnerAizuchi += 1;
    for (const word of japaneseWords(text, segmenter)) words.add(word);
  }
  const said = learner.map((line) => line.text).join('\n');
  const stackWordsUsed = stackWords.filter((word) => [word.kanji, word.kana].some((form) => form && said.includes(form))).length;
  const byLevel = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0 };
  let offListWords = 0;
  for (const word of words) {
    const level = levelOf(word, levels);
    if (level) byLevel[level] += 1;
    else offListWords += 1;
  }
  const turns = learner.length;
  return {
    learnerTurns: turns,
    japaneseChars,
    avgTurnChars: turns ? Math.round(japaneseChars / turns) : null,
    englishTurnPercent: turns ? Math.round((englishTurns / turns) * 100) : null,
    newWords: Math.max(0, Math.round(newWords)),
    stackWordsUsed,
    helpRequests,
    distinctWords: words.size,
    jlptN5Words: byLevel.N5,
    jlptN4Words: byLevel.N4,
    jlptN3Words: byLevel.N3,
    jlptN2Words: byLevel.N2,
    jlptN1Words: byLevel.N1,
    offListWords,
    questionsAsked,
    japaneseFillers,
    englishFillers,
    helpFollowUps,
    japaneseAfterHelp,
    learnerAizuchi,
  };
}

// Which words already in the stack the contact said (came back) and the learner said (used) on a call, as word ids.
// A word matches by its kanji, or by its kana when that's at least two characters, so short kana like い can't match by
// accident. lookedUpIds are words they asked about again on the call.
export function wordEvents({ lines = [], stackWords = [], lookedUpIds = [] }) {
  const said = (from) => lines.filter((line) => line.from === from && typeof line.text === 'string').map((line) => line.text).join('\n');
  const contact = said('contact');
  const learner = said('you');
  const forms = (word) => [word.kanji, word.kana && word.kana.length >= 2 ? word.kana : null].filter(Boolean);
  const matches = (text) => stackWords.filter((word) => word.id && forms(word).some((form) => text.includes(form))).map((word) => word.id);
  const known = new Set(stackWords.map((word) => word.id));
  return { cameBack: matches(contact), used: matches(learner), lookedUp: [...new Set(lookedUpIds)].filter((id) => known.has(id)) };
}

const validValue = (field, value) =>
  value === null ? MAY_BE_EMPTY.has(field) : Number.isInteger(value) && value >= 0 && value <= (PERCENT_FIELDS.has(field) ? 100 : MAX_COUNT);

// Every field, if each is a whole number in range (or null where allowed) and nothing else came with them. Otherwise
// null. The fields added later may be missing, and are then null.
export function cleanLearning(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !LEARNING_FIELDS.includes(key))) return null;
  if (!CORE_FIELDS.every((field) => Object.hasOwn(body, field))) return null;
  if (!LEARNING_FIELDS.every((field) => !Object.hasOwn(body, field) || validValue(field, body[field]))) return null;
  return Object.fromEntries(LEARNING_FIELDS.map((field) => [field, Object.hasOwn(body, field) ? body[field] : null]));
}
