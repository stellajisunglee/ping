// The words a contact says word for word: Ping's opening questions, greetings, goodbyes and voicemail.
// The voice model is told to say some of them exactly (prompt.js), and the phone or Deepgram says others itself.

import { PING } from './contacts.js';

export const QUESTIONS = [
  { id: 'day', japanese: '今日はどんな一日ですか？', casual: '今日はどんな一日？', english: 'What kind of day are you having?' },
  { id: 'doing', japanese: '今、何をしていますか？', casual: '今、何してる？', english: 'What are you doing right now?' },
  { id: 'did', japanese: '今日は何をしましたか？', casual: '今日は何をした？', english: 'What did you do today?' },
  { id: 'eat', japanese: '今日は何を食べましたか？', casual: '今日は何を食べた？', english: 'What did you eat today?' },
  { id: 'weekend', japanese: '週末は何をしますか？', casual: '週末は何をするの？', english: 'What are you doing this weekend?' },
  { id: 'lately', japanese: '最近、どうですか？', casual: '最近、どう？', english: 'How have things been lately?' },
];

// What a contact says when the user steers off its topic.
export const NOT_SURE = 'ちょっとわかりません。';

export function voiceMessageFor(contact = PING) {
  return {
    japanese: `もしもし、${contact.spokenName}です。お電話に出られなかったようですね。お時間がある時に、折り返しお電話ください。お待ちしています！`,
    english: `Hi, it's ${contact.name}. Looks like you couldn't pick up. Please call me back when you have time. Talk soon!`,
  };
}

export function pickQuestion(lastQuestionId, random = Math.random) {
  const choices = QUESTIONS.filter((question) => question.id !== lastQuestionId);
  return choices[Math.floor(random() * choices.length)];
}

export const questionById = (id) => QUESTIONS.find((question) => question.id === id) ?? QUESTIONS[0];

export function greetingFor({ localHour, calledBack, contact, formality }) {
  const formal = formality === 'formal';
  const intro = formal ? `もしもし、${contact.spokenName}です！` : `もしもし、${contact.spokenName}だよ！`;
  const thanks = formal ? 'ありがとうございます！' : 'ありがとう！';
  if (calledBack) return `${intro}折り返してくれて、${thanks}`;
  const morning = formal ? 'おはようございます' : 'おはよう';
  const hello = localHour < 11 ? morning : localHour < 18 ? 'こんにちは' : 'こんばんは';
  const goodTime = formal ? '今、お時間大丈夫ですか？' : '今、話せる？';
  return `${intro}${hello}！${goodTime}`;
}

// The words a contact says first, for engines that speak a fixed greeting themselves (Deepgram's Voice Agent).
// When the user called, Ping's question follows straight away, as it does on OpenAI.
export function openingWords({ question, contact = PING, formality = 'formal', calledBack, localHour }) {
  const greeting = greetingFor({ localHour, calledBack, contact, formality });
  if (!calledBack || contact.id !== PING.id) return greeting;
  return `${greeting}${formality === 'formal' ? question.japanese : question.casual}`;
}

// What the contact says when the call reaches its time limit, on engines where the phone has to say it
// (Deepgram's Voice Agent can't take a mid-call instruction the way OpenAI can).
export const TIME_UP_LINES = { formal: '時間になりました。今日はありがとうございました。また話しましょう！', casual: '時間になっちゃった。今日はありがとう。また話そうね！' };

// What the contact says when it isn't a good time. The phone hangs up after hearing it, even if the
// voice engine forgets to call end_call, which it sometimes does after speaking.
export const NOT_NOW_GOODBYES = { formal: 'わかりました。また電話しますね！', casual: 'わかった。また電話するね！' };
