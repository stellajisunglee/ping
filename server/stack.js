// The user's word and sentence banks, and what they keep when their plan changes.

const MAX_SAVED = 5000; // a safety cap for plans with no limit, so one account can't grow without end
const MAX_FIELD_LENGTH = 200;
const JAPANESE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const JAPANESE_TEXT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

const text = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_FIELD_LENGTH) : '');

export function cleanWord(input = {}) {
  const word = { kanji: text(input.kanji), kana: text(input.kana), romaji: text(input.romaji), english: text(input.english) };
  if (!JAPANESE_KANA.test(word.kana) || !word.romaji || !word.english) return null;
  if (word.kanji && !JAPANESE_TEXT.test(word.kanji)) word.kanji = '';
  return word;
}

const HAS_KANJI = /\p{Script=Han}/u;
const MAX_SENTENCE_WORDS = 20;

// The words with kanji in a sentence, as studied on the sentence page. Each is a word that can be
// saved to the stack, plus how it's written in the sentence. Anything without kanji is left out.
export function cleanSentenceWords(list) {
  if (!Array.isArray(list)) return [];
  const words = [];
  for (const input of list) {
    const word = cleanWord(input);
    if (!word || !HAS_KANJI.test(word.kanji)) continue;
    if (words.some((other) => other.kanji === word.kanji && other.kana === word.kana)) continue;
    const asWritten = text(input.asWritten);
    words.push({ ...word, asWritten: HAS_KANJI.test(asWritten) ? asWritten : word.kanji });
    if (words.length === MAX_SENTENCE_WORDS) break;
  }
  return words;
}

// Lists are newest first, so keeping the first `limit` drops the oldest. A null limit means no limit.
const newest = (list, limit) => list.slice(0, limit ?? MAX_SAVED);

// Once the list is full, a new word pushes out the oldest one.
export function addWord(user, word, { id, now, limit }) {
  const sameWord = (other) => other.kana === word.kana && other.kanji === word.kanji;
  if (user.words.some(sameWord)) return null;
  const saved = { id, ...word, at: now };
  user.words = newest([saved, ...user.words], limit);
  return saved;
}

// A few words and sentences an account can start with, so a new visitor sees what a stack looks like.
export const STARTER_STACK = {
  words: [
    { kanji: '忙しい', kana: 'いそがしい', romaji: 'isogashii', english: 'busy' },
    { kanji: '散歩', kana: 'さんぽ', romaji: 'sanpo', english: 'a walk' },
    { kanji: '美味しい', kana: 'おいしい', romaji: 'oishii', english: 'delicious' },
    { kanji: '週末', kana: 'しゅうまつ', romaji: 'shuumatsu', english: 'weekend' },
  ],
  sentences: [
    { japanese: '今週はちょっと忙しいです。', romaji: 'konshuu wa chotto isogashii desu.', english: "I'm a little busy this week.", word: '忙しい' },
    { japanese: '週末は友達と散歩しました。', romaji: 'shuumatsu wa tomodachi to sanpo shimashita.', english: 'I went for a walk with a friend on the weekend.', word: '散歩' },
    { japanese: 'このラーメンはとても美味しいです。', romaji: 'kono raamen wa totemo oishii desu.', english: 'This ramen is really delicious.', word: '美味しい' },
  ],
};

// Listed first to last, so each gets a slightly earlier time and they keep that order.
export function addStarterStack(user, { now, newId, limit }) {
  STARTER_STACK.words.forEach((word, index) => addWord(user, word, { id: newId(), now: now - index * 1000, limit }));
  STARTER_STACK.sentences.forEach((sentence, index) => addSentence(user, sentence, { id: newId(), now: now - index * 1000, limit }));
  user.words.sort((a, b) => b.at - a.at);
  user.sentences.sort((a, b) => b.at - a.at);
}

export function cleanSentence(input = {}) {
  const sentence = { japanese: text(input.japanese), romaji: text(input.romaji), english: text(input.english), word: text(input.word) };
  return JAPANESE_TEXT.test(sentence.japanese) && sentence.romaji && sentence.english ? sentence : null;
}

// Like words, once the list is full a new sentence pushes out the oldest one.
export function addSentence(user, sentence, { id, now, limit }) {
  const existing = user.sentences.find((other) => other.japanese === sentence.japanese);
  if (existing) return existing;
  const saved = { id, ...sentence, at: now };
  user.sentences = newest([saved, ...user.sentences], limit);
  return saved;
}

// When a downgrade's grace period ends: the stack shrinks to the new plan's limit, keeping the newest,
// and saved conversations go if the new plan doesn't keep them.
export function applyDowngrade(user, { limit, keepConversations }) {
  user.words = newest(user.words, limit);
  user.sentences = newest(user.sentences, limit);
  if (!keepConversations) user.conversations = [];
  user.clearAt = null;
}
