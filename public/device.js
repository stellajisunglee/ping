// What kind of device the app is on, and whether it's running as the installed app. On a phone, Ping only runs from
// the Home Screen, like an app: that's where calls can ring (iPhones only allow notifications there). A computer's
// browser is allowed as is, for admins and testing. No browser globals are read at import time, so tests can pass
// stand-ins.

// 'ios', 'android' or 'desktop'. iPads that report themselves as a Mac are caught by their touch points.
export function deviceKind({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

// Whether this page is the installed app rather than a browser tab.
export const isInstalled = ({ standalone = false, displayStandalone = false } = {}) => Boolean(standalone || displayStandalone);

// A phone in a browser tab has to add Ping to its Home Screen first.
export const needsInstall = (kind, installed) => kind !== 'desktop' && !installed;

// Whether a tap or key press landed in something the user types into, where the app mustn't start audio (app.js).
export const isTextField = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

// The invite code to join with: what's in the box, or, if the box is empty (an iPhone Home Screen app can refuse to
// put the cursor in it), what the user types into the phone's own pop-up, which ask() opens.
export const codeToJoin = (typed, ask) => (typed ?? '').trim() || (ask() ?? '').trim();
