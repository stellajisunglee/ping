import test from 'node:test';
import assert from 'node:assert/strict';
import { codeToJoin, deviceKind, isInstalled, isTextField, needsInstall } from '../public/device.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test('phones are told apart from computers, including iPads that say they are Macs', () => {
  assert.equal(deviceKind({ userAgent: IPHONE }), 'ios');
  assert.equal(deviceKind({ userAgent: ANDROID }), 'android');
  assert.equal(deviceKind({ userAgent: ANDROID, platform: 'MacIntel', maxTouchPoints: 5 }), 'android', 'Android, even where the platform looks like a Mac');
  assert.equal(deviceKind({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }), 'desktop');
  assert.equal(deviceKind({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }), 'ios', 'an iPad asking for the desktop site');
});

test('a phone in a browser tab must add Ping to its Home Screen; the installed app and computers go straight in', () => {
  assert.equal(needsInstall('ios', isInstalled({ standalone: false })), true);
  assert.equal(needsInstall('android', isInstalled({ displayStandalone: false })), true);
  assert.equal(needsInstall('ios', isInstalled({ standalone: true })), false);
  assert.equal(needsInstall('android', isInstalled({ displayStandalone: true })), false);
  assert.equal(needsInstall('desktop', isInstalled({})), false);
});

test('taps in a text field are told apart, so they never start audio', () => {
  const inside = (selector) => ({ closest: (query) => (query.split(', ').includes(selector) ? {} : null) });
  assert.equal(isTextField(inside('input')), true);
  assert.equal(isTextField(inside('textarea')), true);
  assert.equal(isTextField({ closest: () => null }), false, 'a button');
  assert.equal(isTextField(null), false);
});

test('joining uses the typed code, or asks with a pop-up when the box is empty', () => {
  let asked = 0;
  const ask = (answer) => () => {
    asked += 1;
    return answer;
  };
  assert.equal(codeToJoin('  beta ', ask('other')), 'beta');
  assert.equal(asked, 0, 'no pop-up when the box has a code');
  assert.equal(codeToJoin('', ask(' beta ')), 'beta');
  assert.equal(codeToJoin('   ', ask(null)), '', 'cancelled pop-up');
  assert.equal(asked, 2);
});
