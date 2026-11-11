// Who can call the user, and which plan unlocks what.

export const PLANS = ['free', 'premium', 'platinum'];
export const VOICES = ['marin', 'cedar', 'coral', 'sage', 'verse', 'ash'];
export const MAX_CUSTOM_CONTACTS = 5;
const MAX_NAME_LENGTH = 30;
const MAX_TOPIC_LENGTH = 200;

// What each plan allows. callsPerDay counts Ping's scheduled call and the user's own calls together:
// on a day Ping calls, one is kept for Ping, so the user can make one fewer themselves.
// Calling back after missing Ping's call doesn't count. perCall is the longest one call can last, in minutes.
// savedItems is how many words, and separately how many sentences, the stack keeps (null for no limit).
export const PLAN_LIMITS = {
  free: { callsPerDay: 1, perCall: 3, savedItems: 25 },
  premium: { callsPerDay: 3, perCall: 5, savedItems: 100 },
  platinum: { callsPerDay: 5, perCall: 10, savedItems: null },
};

export const planLimits = (plan) => PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

export const isPaid = (plan) => plan === 'premium' || plan === 'platinum';

export const PING = { id: 'ping', name: 'Ping', spokenName: 'ピン', topic: 'daily life, such as what they did today, food and plans', plan: 'free' };
// Hidden until it has a topic. Remove `hidden` and fill in `topic` to bring it back.
const MERO = { id: 'mero', name: 'Mero', spokenName: 'メロ', topic: '', plan: 'premium', hidden: true };
const BUILT_IN = [PING, MERO].filter((contact) => !contact.hidden);

const planRank = (plan) => PLANS.indexOf(plan);

export const canCall = (user, contact) => planRank(user.plan) >= planRank(contact.plan);

export function findContact(user, id) {
  return [...BUILT_IN, ...user.customContacts].find((contact) => contact.id === id) ?? null;
}

// A contact the user can no longer reach, after a downgrade or a delete, falls back to Ping.
export function selectedContact(user) {
  const contact = findContact(user, user.contactId);
  return contact && canCall(user, contact) ? contact : PING;
}

export function contactList(user) {
  const selected = selectedContact(user);
  return [...BUILT_IN, ...user.customContacts].map((contact) => ({
    id: contact.id,
    name: contact.name,
    topic: contact.topic,
    voice: contact.voice ?? null,
    custom: contact.plan === 'platinum',
    available: canCall(user, contact),
    selected: contact.id === selected.id,
  }));
}

export function cleanContact({ name, topic, voice } = {}) {
  if (typeof name !== 'string' || typeof topic !== 'string') return null;
  const cleanName = name.trim().slice(0, MAX_NAME_LENGTH);
  const cleanTopic = topic.trim().slice(0, MAX_TOPIC_LENGTH);
  if (!cleanName || !cleanTopic || !VOICES.includes(voice)) return null;
  return { name: cleanName, spokenName: cleanName, topic: cleanTopic, voice, plan: 'platinum' };
}
