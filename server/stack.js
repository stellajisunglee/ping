// The user's word and sentence banks, and what they keep when their plan changes.

export const FREE_WORD_LIMIT = 25;
const MAX_SENTENCES = 500;
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

// Words saved on a free plan roll over at the limit. Words from a subscription don't count toward it.
export function addWord(user, word, { id, now, paid }) {
  const sameWord = (other) => other.kana === word.kana && other.kanji === word.kanji;
  if (user.words.some(sameWord)) return null;
  const saved = { id, ...word, at: now, fromSubscription: paid };
  user.words = [saved, ...user.words];
  if (!paid) {
    const freeWords = user.words.filter((other) => !other.fromSubscription);
    const dropped = new Set(freeWords.slice(FREE_WORD_LIMIT).map((other) => other.id));
    user.words = user.words.filter((other) => !dropped.has(other.id));
  }
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
export function addStarterStack(user, { now, newId, paid }) {
  STARTER_STACK.words.forEach((word, index) => addWord(user, word, { id: newId(), now: now - index * 1000, paid }));
  STARTER_STACK.sentences.forEach((sentence, index) => addSentence(user, sentence, { id: newId(), now: now - index * 1000 }));
  user.words.sort((a, b) => b.at - a.at);
  user.sentences.sort((a, b) => b.at - a.at);
}

export function cleanSentence(input = {}) {
  const sentence = { japanese: text(input.japanese), romaji: text(input.romaji), english: text(input.english), word: text(input.word) };
  return JAPANESE_TEXT.test(sentence.japanese) && sentence.romaji && sentence.english ? sentence : null;
}

export function addSentence(user, sentence, { id, now }) {
  const existing = user.sentences.find((other) => other.japanese === sentence.japanese);
  if (existing) return existing;
  const saved = { id, ...sentence, at: now };
  user.sentences = [saved, ...user.sentences].slice(0, MAX_SENTENCES);
  return saved;
}

export function clearSubscriptionData(user) {
  user.words = user.words.filter((word) => !word.fromSubscription);
  user.sentences = [];
  user.conversations = [];
  user.clearAt = null;
}
