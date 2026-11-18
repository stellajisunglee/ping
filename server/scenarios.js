// Controlled test scenarios, for admins comparing engines and turn detection under the same conditions.
// A scenario fixes only which of Ping's opening questions a call starts with (lines.js). Everything else here
// is guidance for the admin on the call: it's never sent to a voice engine, so Ping can't play to the test.
// prompt.js and deepgram.js never import this file, and tests/scenarios.test.js checks that.
// Ids are stable: the call log and the checklist results refer to them, so rename the text, never the id.

export const TOPIC_MODES = ['randomized', 'controlled'];

export const SCENARIOS = [
  {
    id: 'weekend-plans',
    name: 'Weekend Plans',
    questionId: 'weekend',
    focus: 'Thinking pauses, turn completion and follow-up questions that use what you said.',
    example: '週末は……えーっと……友達と……鎌倉に行ったんだ。',
    actions: [
      'Mention a trip to Kamakura.',
      'Pause for about three seconds mid-sentence, then finish the sentence.',
      'Carry on naturally for two or three exchanges.',
    ],
    note: 'Ping asks about this coming weekend. Talking about a past outing still works, as above, or say 行くんだ for a plan.',
    checkpoints: [
      { id: 'no-interrupt', text: "Ping didn't interrupt the unfinished sentence." },
      { id: 'uses-answer', text: 'Ping responded to what you actually said.' },
      { id: 'builds-on', text: 'Follow-ups built on the conversation instead of repeating the opening question.' },
    ],
  },
  {
    id: 'daily-life',
    name: 'Daily Life',
    questionId: 'did',
    focus: 'Backchannels, interruptions and recovery.',
    example: 'ちょっと待って、それどういう意味？',
    actions: [
      'Tell Ping what you did today.',
      'Say 「うんうん」 or 「へえ」 briefly while Ping is speaking.',
      'Later, interrupt with 「ちょっと待って、それどういう意味？」',
    ],
    note: null,
    checkpoints: [
      { id: 'aizuchi-kept', text: "A brief acknowledgment didn't derail what Ping was saying." },
      { id: 'interrupt-handled', text: 'The real interruption was handled promptly.' },
      { id: 'coherent-after', text: 'Ping carried on coherently afterward.' },
    ],
  },
  {
    id: 'vocabulary-help',
    name: 'Vocabulary Help',
    questionId: 'day',
    focus: 'Code-switching, language repair and getting back to the conversation.',
    example: '昨日……what\'s the word for appointment?……予約をした。',
    actions: [
      'Pause while searching for a Japanese word.',
      'Briefly ask for the word in English.',
      'Carry on in Japanese once Ping helps, and ask for clarification if you need it.',
    ],
    note: null,
    checkpoints: [
      { id: 'help-noticed', text: 'Ping noticed you were asking for help.' },
      { id: 'help-brief', text: 'The help was brief and accurate.' },
      { id: 'no-double-explain', text: "Ping didn't explain the same word twice without reason." },
      { id: 'back-to-topic', text: 'Ping went back to the topic naturally.' },
    ],
  },
  {
    id: 'recent-activities',
    name: 'Recent Activities',
    questionId: 'lately',
    focus: 'Repeated questions, remembering what you said, and conversational flow.',
    example: '昨日は家で映画を見ました。',
    actions: [
      'Give a concrete answer, such as watching a movie at home.',
      'Carry on for three to five exchanges.',
    ],
    note: 'Ping asks how things have been lately, so start from something you did yesterday.',
    checkpoints: [
      { id: 'builds-on', text: 'Ping built on your earlier answers.' },
      { id: 'no-repeat', text: "Ping didn't ask again what you'd already answered." },
    ],
  },
];

export const CHECK_RESULTS = ['pass', 'fail', 'unclear'];

export const scenarioById = (id) => SCENARIOS.find((scenario) => scenario.id === id) ?? null;
