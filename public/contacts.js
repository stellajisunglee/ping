// The Contacts tab: who calls the user, and who they can call.

import { $, api, el, initialOf, isPaid, onShow, setError, state } from './lib.js';

const VOICE_LABELS = { marin: 'Marin', cedar: 'Cedar', coral: 'Coral', sage: 'Sage', verse: 'Verse', ash: 'Ash' };

let callContact = () => {};

async function update(request) {
  setError('contacts-error', null);
  try {
    state.me = await request();
    renderContacts();
  } catch (error) {
    setError('contacts-error', error.message);
  }
}

function contactRow(contact) {
  const name = el('p', { className: 'contact-name', textContent: contact.name });
  const detail = contact.comingSoon ? 'Coming soon' : contact.custom ? contact.topic : contact.id === 'ping' ? 'Daily life' : contact.topic;
  const actions = el('div', { className: 'contact-actions' });

  if (contact.available) {
    const call = el('button', { type: 'button', className: 'primary small', textContent: 'Call' });
    call.addEventListener('click', () => callContact(contact.id));
    actions.append(call);
    if (contact.selected) {
      actions.append(el('span', { className: 'badge', textContent: 'Calls you' }));
    } else if (isPaid()) {
      const select = el('button', { type: 'button', className: 'secondary small', textContent: 'Choose' });
      select.addEventListener('click', () => update(() => api('/api/contact', { method: 'PUT', body: { contactId: contact.id } })));
      actions.append(select);
    }
  } else {
    actions.append(el('span', { className: 'badge muted-badge', textContent: contact.comingSoon ? 'Soon' : 'Locked' }));
  }
  if (contact.custom) {
    const remove = el('button', { type: 'button', className: 'text-danger small', textContent: 'Delete' });
    remove.addEventListener('click', () => {
      if (confirm(`Delete ${contact.name}?`)) update(() => api(`/api/contacts/${contact.id}`, { method: 'DELETE' }));
    });
    actions.append(remove);
  }

  return el(
    'li',
    { className: 'card contact' },
    el('div', { className: 'avatar small', ariaHidden: 'true', textContent: initialOf(contact.name) }),
    el('div', { className: 'contact-text' }, name, el('p', { className: 'muted', textContent: detail })),
    actions,
  );
}

function renderContacts() {
  const { me } = state;
  $('contacts-list').replaceChildren(...me.contacts.map(contactRow));
  $('contacts-upgrade').hidden = isPaid();
  $('contact-create').hidden = me.plan !== 'pro';
  $('contact-create-upgrade').hidden = me.plan !== 'plus';
}

async function createContact(event) {
  event.preventDefault();
  const body = { name: $('contact-name').value, topic: $('contact-topic').value, voice: $('contact-voice').value };
  await update(() => api('/api/contacts', { method: 'POST', body }));
  if ($('contacts-error').hidden) event.target.reset();
}

export function initContacts({ onCall }) {
  callContact = onCall;
  onShow('contacts', renderContacts);
  $('contact-voice').append(...Object.entries(VOICE_LABELS).map(([value, textContent]) => el('option', { value, textContent })));
  $('contact-create').addEventListener('submit', createContact);
}
