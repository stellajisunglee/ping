// Who can call the user, and which plan unlocks what.

export const PLANS = ['free', 'plus', 'pro'];
export const VOICES = ['marin', 'cedar', 'coral', 'sage', 'verse', 'ash'];
export const MAX_CUSTOM_CONTACTS = 5;
const MAX_NAME_LENGTH = 30;
const MAX_TOPIC_LENGTH = 200;

export const isPaid = (plan) => plan === 'plus' || plan === 'pro';

export const PING = { id: 'ping', name: 'Ping', spokenName: 'ピン', topic: 'daily life, such as what they did today, food and plans', plan: 'free' };
const MERO = { id: 'mero', name: 'Mero', spokenName: 'メロ', topic: '', plan: 'plus', comingSoon: true };
const BUILT_IN = [PING, MERO];

const planRank = (plan) => PLANS.indexOf(plan);

export const canCall = (user, contact) => !contact.comingSoon && planRank(user.plan) >= planRank(contact.plan);

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
    custom: contact.plan === 'pro',
    comingSoon: Boolean(contact.comingSoon),
    available: canCall(user, contact),
    selected: contact.id === selected.id,
  }));
}

export function cleanContact({ name, topic, voice } = {}) {
  if (typeof name !== 'string' || typeof topic !== 'string') return null;
  const cleanName = name.trim().slice(0, MAX_NAME_LENGTH);
  const cleanTopic = topic.trim().slice(0, MAX_TOPIC_LENGTH);
  if (!cleanName || !cleanTopic || !VOICES.includes(voice)) return null;
  return { name: cleanName, spokenName: cleanName, topic: cleanTopic, voice, plan: 'pro' };
}
