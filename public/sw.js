// Makes the phone "ring" while the app is closed, and keeps the app shell available offline.

const CACHE = 'ping-v2';
const SHELL = ['/', '/index.html', '/app.js', '/lib.js', '/stack.js', '/contacts.js', '/settings.js', '/turn-metrics.js', '/voice.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png'];
const NOTIFICATION_TAG = 'ping-call';
const RING_AGAIN_EVERY_MS = 2_500;
const RING_AGAIN_TIMES = 3; // keeps it inside the 10 seconds, after which the server sends the missed call

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.mp3')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

function showRing(callId, contactName) {
  return self.registration.showNotification(`${contactName} is calling`, {
    body: 'Tap to answer',
    tag: NOTIFICATION_TAG,
    renotify: true,
    requireInteraction: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [400, 200, 400, 200, 400, 200, 400],
    data: { type: 'ring', callId, contactName },
    actions: [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' },
    ],
  });
}

function showMissed(callId, contactName) {
  return self.registration.showNotification(`Missed call from ${contactName}`, {
    body: 'You have a voice message. Tap to listen and call back.',
    tag: NOTIFICATION_TAG,
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { type: 'missed', callId },
  });
}

async function tellOpenApps(message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

// Rings the phone again until the call is answered, declined or missed, so one buzz isn't easy to miss.
async function keepRinging(callId, contactName) {
  for (let count = 0; count < RING_AGAIN_TIMES; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, RING_AGAIN_EVERY_MS));
    const open = await self.registration.getNotifications({ tag: NOTIFICATION_TAG });
    if (!open.some(({ data }) => data?.type === 'ring' && data.callId === callId)) return;
    await showRing(callId, contactName);
  }
}

async function handleRing(callId, contactName) {
  await showRing(callId, contactName);
  await tellOpenApps({ type: 'ring', callId, contactName });
  // A push that sat undelivered can arrive after the call was already missed.
  const response = await fetch(`/api/calls/${callId}/delivered`, { method: 'POST' });
  const { state } = await response.json();
  if (state === 'missed') await handleMissed(callId, contactName);
  else if (state === 'ringing') await keepRinging(callId, contactName);
}

async function handleMissed(callId, contactName) {
  await showMissed(callId, contactName);
  await tellOpenApps({ type: 'missed', callId });
}

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  const contactName = data.contactName ?? 'Ping';
  if (data.type === 'ring') event.waitUntil(handleRing(data.callId, contactName).catch(() => {}));
  else if (data.type === 'missed') event.waitUntil(handleMissed(data.callId, contactName));
});

async function openApp(path, message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length) {
    const [client] = windows;
    await client.focus();
    client.postMessage(message);
    return;
  }
  await self.clients.openWindow(path);
}

self.addEventListener('notificationclick', (event) => {
  const { type, callId } = event.notification.data ?? {};
  event.notification.close();
  if (type === 'ring' && event.action === 'decline') {
    event.waitUntil(fetch(`/api/calls/${callId}/decline`, { method: 'POST' }));
    return;
  }
  if (type === 'ring') {
    // Recording the answer right away is what stops the 10 seconds, even if the app is slow to open.
    event.waitUntil(
      Promise.all([
        fetch(`/api/calls/${callId}/answer`, { method: 'POST' }).catch(() => {}),
        openApp(`/?call=${callId}`, { type: 'answer', callId }),
      ]),
    );
    return;
  }
  event.waitUntil(openApp('/?messages=1', { type: 'show-messages' }));
});
