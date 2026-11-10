// The Contacts tab: who calls the user, and who they can call.

import { $, api, el, goBack, initialOf, onShow, setError, state } from './lib.js';

const VOICE_LABELS = { marin: 'Marin', cedar: 'Cedar', coral: 'Coral', sage: 'Sage', verse: 'Verse', ash: 'Ash' };

let callContact = () => {};

// Contacts on the way, shown greyed out so users know more are coming. Mero is hidden on the server
// until it has a topic (see server/contacts.js).
const COMING_SOON = [{ id: 'mero', name: 'Mero' }];

function comingSoonRow(contact) {
  return el(
    'li',
    { className: 'card contact coming-soon' },
    el('div', { className: 'avatar small', ariaHidden: 'true', textContent: initialOf(contact.name) }),
    el('div', { className: 'contact-text' }, el('p', { className: 'contact-name', textContent: contact.name }), el('p', { className: 'muted', textContent: 'Coming soon' })),
    el('button', { type: 'button', className: 'primary small', textContent: 'Call', disabled: true, ariaLabel: `Call ${contact.name}, coming soon` }),
  );
}

async function update(request) {
  setError('contacts-error', null);
  try {
    state.me = await request();
    renderContacts();
  } catch (error) {
    setError('contacts-error', error.message);
  }
}

function contactRow(contact, canChoose) {
  const detail = contact.id === 'ping' ? 'Daily life' : contact.topic;
  const call = el('button', { type: 'button', className: 'primary small', textContent: 'Call' });
  call.addEventListener('click', () => callContact(contact.id));
  const row = el(
    'li',
    { className: 'card contact' },
    el('div', { className: 'avatar small', ariaHidden: 'true', textContent: initialOf(contact.name) }),
    el('div', { className: 'contact-text' }, el('p', { className: 'contact-name', textContent: contact.name }), el('p', { className: 'muted', textContent: detail })),
    call,
  );

  // With only one contact there's nothing to choose between.
  if (canChoose) {
    const actions = el('div', { className: 'contact-actions' });
    if (contact.selected) {
      actions.append(el('span', { className: 'badge', textContent: 'Calls you' }));
    } else {
      const select = el('button', { type: 'button', className: 'secondary small', textContent: 'Choose' });
      select.addEventListener('click', () => update(() => api('/api/contact', { method: 'PUT', body: { contactId: contact.id } })));
      actions.append(select);
    }
    if (contact.custom) {
      const remove = el('button', { type: 'button', className: 'text-danger small', textContent: 'Delete' });
      remove.addEventListener('click', () => {
        if (confirm(`Delete ${contact.name}?`)) update(() => api(`/api/contacts/${contact.id}`, { method: 'DELETE' }));
      });
      actions.append(remove);
    }
    row.append(actions);
  }
  return row;
}

function renderContacts() {
  const { me } = state;
  const canCreate = me.plan === 'platinum';
  // Contacts made on a higher plan stay saved in case the user resubscribes, but out of sight until then.
  const contacts = me.contacts.filter((contact) => contact.available);
  const comingSoon = COMING_SOON.filter((soon) => !me.contacts.some((contact) => contact.id === soon.id));
  $('contacts-list').replaceChildren(...contacts.map((contact) => contactRow(contact, contacts.length > 1)), ...comingSoon.map(comingSoonRow));
  $('contact-new-button').hidden = !canCreate;
  $('contacts-upgrade').hidden = canCreate;
}

async function createContact(event) {
  event.preventDefault();
  setError('contact-new-error', null);
  try {
    state.me = await api('/api/contacts', { method: 'POST', body: { name: $('contact-name').value, topic: $('contact-topic').value, voice: $('contact-voice').value } });
    event.target.reset();
    goBack();
  } catch (error) {
    setError('contact-new-error', error.message);
  }
}

export function initContacts({ onCall }) {
  callContact = onCall;
  onShow('contacts', renderContacts);
  $('contact-voice').append(...Object.entries(VOICE_LABELS).map(([value, textContent]) => el('option', { value, textContent })));
  $('contact-new-form').addEventListener('submit', createContact);
}
