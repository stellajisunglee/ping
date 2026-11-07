// Aizuchi: the short sounds Japanese listeners make while someone else is talking, like うん, はい
// or そうなんだ, to show they're following. They aren't a turn, so Ping should carry on, not answer them.
// No browser code, so the tests can use it directly.

// Common backchannels, in hiragana. Katakana spellings and repeats like うんうん match too.
// Learners also fall back on English ones.
const AIZUCHI = [
  'うん', 'はい', 'ええ', 'ああ', 'あー', 'へえ', 'へー', 'ほう', 'ふうん', 'ふーん', 'なるほど',
  'そう', 'そっか', 'そうか', 'そうなんだ', 'そうなんですね', 'そうなの', 'そうですね', 'そうですか',
  'yeah', 'yes', 'yep', 'mhm', 'mm', 'uhhuh', 'okay', 'ok', 'right',
];

// Anything longer is a real sentence, even if it starts with うん.
const MAX_AIZUCHI_CHARS = 12;

// Longest first, so そうなんだ is matched as one word rather than そう plus leftovers.
const AIZUCHI_ONLY = new RegExp(`^(?:${[...AIZUCHI].sort((a, b) => b.length - a.length).join('|')})+$`);

const MAX_PLANNED_CHARS = 400; // enough for one or two sentences, which is all a reply should be

// The note that tells the contact to carry on after an aizuchi. It's added to the conversation
// for one reply, so the contact's own instructions and style stay in place. OpenAI removes the
// unheard part of the cut reply from the conversation, so the note gives it back: without it the
// contact has to rebuild the rest of its sentence and says something slightly different.
export function resumeNote(plannedReply = '') {
  const note =
    "The user only made a short listening sound (aizuchi), like うん, to show they're following. It isn't an answer. " +
    "Carry on from the exact point where you were cut off: don't restart your sentence, don't repeat what they already heard, and don't respond to the sound.";
  const planned = plannedReply.trim().slice(0, MAX_PLANNED_CHARS);
  return planned ? `${note} The whole reply you had planned, of which they heard only the beginning, was: 「${planned}」 Say the part they didn't hear.` : note;
}

const toHiragana = (text) => text.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));

export function isAizuchi(transcript) {
  if (typeof transcript !== 'string') return false;
  const words = toHiragana(transcript.normalize('NFKC').toLowerCase()).replace(/[\s\p{P}\p{S}]/gu, '');
  return words.length > 0 && words.length <= MAX_AIZUCHI_CHARS && AIZUCHI_ONLY.test(words);
}

// What to do when the user's turn ends:
// - "reply": a normal reply, straight away.
// - "wait": they talked over the contact, so wait for their words to see whether it was aizuchi.
// - "resume": it was aizuchi, so the contact carries on from where it was cut off.
// `transcript` is null while the words haven't arrived yet, and '' when they never will.
export function classifyTurn({ talkedOverContact, transcript }) {
  if (!talkedOverContact) return 'reply';
  if (transcript === null) return 'wait';
  return isAizuchi(transcript) ? 'resume' : 'reply';
}
