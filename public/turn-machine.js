// The rules for when the user starts talking and when their turn is over, in Smart Turn mode.
// Pure functions with no browser code: blocks of speech probability and Smart Turn verdicts go in,
// actions come out, so every rule can be tested without a microphone or a model.

export const TURN = {
  blockMs: 32, // Silero judges audio in 512-sample blocks at 16 kHz
  speechOn: 0.5, // Silero's usual threshold for speech
  speechOff: 0.35, // and its usual lower one for deciding speech has stopped
  startBlocks: 3, // about 0.1 s of speech in a row before it counts, so a click or cough doesn't stop Ping
  askAfterQuietMs: 200, // quiet this long, then ask Smart Turn, as the benchmark did
  backupMs: 2500, // if Smart Turn keeps saying "still thinking", end the turn after this much quiet
  doneAt: 0.5, // Smart Turn's probability at or above which the turn is over
};

// A decision slower than this makes Ping feel slow. Two of them, or one very slow one, and the
// call goes back to silence mode.
export const SLOW_DECISION_MS = 600;
export const VERY_SLOW_DECISION_MS = 1500;

export function initialTurnState() {
  return { inTurn: false, speechBlocks: 0, quietMs: 0, quietSince: null, pause: 0, asked: false };
}

/** One block of microphone audio. `speech` is Silero's probability, `at` is when the block ended. */
export function onBlock(state, { speech, at }, rules = TURN) {
  const next = { ...state };
  const actions = [];

  if (!state.inTurn) {
    next.speechBlocks = speech >= rules.speechOn ? state.speechBlocks + 1 : 0;
    if (next.speechBlocks >= rules.startBlocks) {
      Object.assign(next, { inTurn: true, speechBlocks: 0, quietMs: 0, quietSince: null, asked: false });
      actions.push({ type: 'speech-start', at: at - rules.startBlocks * rules.blockMs });
    }
    return { state: next, actions };
  }

  if (speech >= rules.speechOn) {
    // Talking again: whatever Smart Turn said about the last pause no longer counts.
    Object.assign(next, { quietMs: 0, quietSince: null, asked: false });
    return { state: next, actions };
  }
  if (speech < rules.speechOff) {
    next.quietMs = state.quietMs + rules.blockMs;
    next.quietSince = state.quietSince ?? at - rules.blockMs;
  }
  if (next.quietMs >= rules.backupMs) {
    actions.push({ type: 'end-turn', reason: 'backup', at, quietSince: next.quietSince });
    return { state: afterTurn(next), actions };
  }
  if (next.quietMs >= rules.askAfterQuietMs && !state.asked) {
    next.asked = true;
    next.pause = state.pause + 1;
    actions.push({ type: 'ask', pause: next.pause });
  }
  return { state: next, actions };
}

/** Smart Turn's answer about a pause. Ignored if the user has started talking since it was asked. */
export function onVerdict(state, { pause, probability, at }, rules = TURN) {
  const stillThatPause = state.inTurn && state.asked && state.pause === pause;
  if (!stillThatPause || probability < rules.doneAt) return { state, actions: [] };
  return { state: afterTurn(state), actions: [{ type: 'end-turn', reason: 'smartTurn', at, quietSince: state.quietSince }] };
}

// Pauses keep counting across turns, so a late verdict about an old pause can never match a new one.
const afterTurn = (state) => ({ ...initialTurnState(), pause: state.pause });

/** Whether this call should give up on Smart Turn and go back to silence mode. */
export function shouldFallBack({ loadFailed = false, decisionMs = [] }) {
  if (loadFailed) return true;
  if (decisionMs.some((ms) => ms > VERY_SLOW_DECISION_MS)) return true;
  return decisionMs.filter((ms) => ms > SLOW_DECISION_MS).length >= 2;
}
