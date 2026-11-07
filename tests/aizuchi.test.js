import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn, isAizuchi } from '../public/aizuchi.js';

test('short listening sounds count as aizuchi, however they are written', () => {
  for (const text of ['うん。', 'うん', 'はい', 'ウン', 'うんうん', 'はいはい', 'そうなの。', 'そうなんだ！', 'なるほど…', 'へー', 'Yeah.', 'mhm', 'uh huh', ' はい、 ']) {
    assert.equal(isAizuchi(text), true, text);
  }
});

test('real answers are not aizuchi, even when they start with one', () => {
  for (const text of ['食べました。', 'うん、でもその人は私に興味ないかも。', '酒?', 'ネタって何?', 'すし。', 'はいはいはいはいはいはいはい', '', '。', null, undefined]) {
    assert.equal(isAizuchi(text), false, String(text));
  }
});

test('a turn that did not talk over the contact always gets a reply straight away', () => {
  assert.equal(classifyTurn({ talkedOverContact: false, transcript: null }), 'reply');
  assert.equal(classifyTurn({ talkedOverContact: false, transcript: 'うん' }), 'reply');
});

test('a turn that talked over the contact waits for its words, then resumes only for aizuchi', () => {
  assert.equal(classifyTurn({ talkedOverContact: true, transcript: null }), 'wait');
  assert.equal(classifyTurn({ talkedOverContact: true, transcript: 'うん。' }), 'resume');
  assert.equal(classifyTurn({ talkedOverContact: true, transcript: 'いや、それは早すぎ。' }), 'reply');
  assert.equal(classifyTurn({ talkedOverContact: true, transcript: '' }), 'reply');
});
