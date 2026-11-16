// The checks code can score exactly, with no model involved: which tools Ping called, whether it
// switched language, how long its replies were, and whether it repeated itself word for word.
// A transcript is a list of { turn, from: 'ping' | 'learner', text, tools: [{ name, args }] }.
// Turn 0 is Ping's greeting; turn N is everything Ping said after the learner's Nth line.

const JAPANESE = /[぀-ヿ一-鿿]/;
const LATIN_WORD = /[A-Za-z][A-Za-z']+/g;

export const hasJapanese = (text) => JAPANESE.test(text);
// Three or more English words, so a name like "Ping" or a word in quotes doesn't count as English.
export const usesEnglish = (text) => (text.match(LATIN_WORD) ?? []).length >= 3;

// Sentences end at 。！？!? or a full stop followed by a space or the end.
export function sentenceCount(text) {
  return text
    .split(/[。！？!?]+|\.(?=\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1).length;
}

const pingLines = (transcript, turn) => transcript.filter((line) => line.from === 'ping' && (turn === undefined || line.turn === turn));
const toolsIn = (transcript, turn) => pingLines(transcript, turn).flatMap((line) => line.tools ?? []);
const said = (transcript, turn) => pingLines(transcript, turn).filter((line) => line.text.trim());
const normalize = (text) => text.replace(/[\s、。！？!?,.「」…~〜]/g, '');

const CHECKS = {
  calledTool: ({ name, turn }, transcript) => {
    const ok = toolsIn(transcript, turn).some((tool) => tool.name === name);
    return { ok, detail: ok ? `called ${name}` : `never called ${name}` };
  },
  didNotCallTool: ({ name, turn }, transcript) => {
    const ok = !toolsIn(transcript, turn).some((tool) => tool.name === name);
    return { ok, detail: ok ? `didn't call ${name}` : `called ${name}` };
  },
  maxSentences: ({ max, turn }, transcript) => {
    const longest = Math.max(0, ...said(transcript, turn).map((line) => sentenceCount(line.text)));
    return { ok: longest <= max, detail: `longest message: ${longest} sentence${longest === 1 ? '' : 's'} (max ${max})` };
  },
  usesEnglish: ({ turn }, transcript) => {
    const ok = said(transcript, turn).some((line) => usesEnglish(line.text));
    return { ok, detail: ok ? 'used English' : 'no English' };
  },
  noEnglish: ({ turn }, transcript) => {
    const ok = !said(transcript, turn).some((line) => usesEnglish(line.text));
    return { ok, detail: ok ? 'stayed in Japanese' : 'used English' };
  },
  // Ping often puts an English answer and the Japanese follow-up in one message, so only its last line counts.
  endsInJapanese: ({ turn }, transcript) => {
    const lastLine = said(transcript, turn).at(-1)?.text.trim().split('\n').filter((line) => line.trim()).at(-1) ?? '';
    const ok = hasJapanese(lastLine) && !usesEnglish(lastLine);
    return { ok, detail: ok ? 'ended in Japanese' : 'did not end in Japanese' };
  },
  // Word-for-word repeats only. Paraphrased loops are for the judge.
  noRepeat: (_, transcript) => {
    const seen = new Set();
    for (const line of said(transcript)) {
      const key = normalize(line.text);
      if (key.length >= 8 && seen.has(key)) return { ok: false, detail: `repeated: ${line.text.slice(0, 40)}` };
      seen.add(key);
    }
    return { ok: true, detail: 'no repeats' };
  },
};

export const CHECK_TYPES = Object.keys(CHECKS);

export function runChecks(checks = [], transcript) {
  return checks.map((check) => {
    const run = CHECKS[check.type];
    if (!run) return { ...check, ok: false, detail: `unknown check type ${check.type}` };
    return { ...check, ...run(check, transcript) };
  });
}
