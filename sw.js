// sw.js — Pantry Tracker Service Worker
// Cache-first for app shell, network-first for API calls

const CACHE = 'pantry-v12';
const APP_SHELL = [
  '/PanTry/',
  '/PanTry/index.html',
  '/PanTry/app.js',
  '/PanTry/config.js',
  '/PanTry/manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network-first for Google auth (never cache auth scripts)
  if (url.hostname.includes('accounts.google.com') || url.hostname.includes('googleapis.com')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Always network-first for pantry server API calls
  if (url.hostname.includes('faenlaud.uk')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Always network-first for product lookups (Open Food Facts API)
  if (url.hostname.includes('openfoodfacts')) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ status: 0 }), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // Network-first for Google Fonts (so updates come through)
  if (url.hostname.includes('fonts.googleapis') || url.hostname.includes('fonts.gstatic')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const c = r.clone(); caches.open(CACHE).then(cache => cache.put(e.request, c)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (app shell)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r.ok) {
          const c = r.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, c));
        }
        return r;
      });
    })
  );
});

// ═══════════════════════════════════════════════
//  Encryption key storage
//  The app sends the CryptoKey to the SW via
//  postMessage after sign-in. We keep it in memory
//  so we can decrypt push payloads.
// ═══════════════════════════════════════════════
let _encKey = null;

self.addEventListener('message', e => {
  if (e.data?.type === 'SET_ENC_KEY') {
    _encKey = e.data.key;
    console.log('[SW] Encryption key received');
  }
});

async function decryptPayload(b64) {
  if (!_encKey || !b64) return null;
  try {
    const combined   = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv         = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext  = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      _encKey,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch(e) {
    console.error('[SW] Decryption failed:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════
//  Push notification handler
// ═══════════════════════════════════════════════
self.addEventListener('push', e => {
  e.waitUntil(handlePush(e));
});

async function handlePush(e) {
  let title = 'Pantry';
  let body  = 'You have items that need attention.';
  let icon  = '/icon-192.png';
  let badge = '/icon-192.png';

  try {
    const raw = e.data?.json();

    if (raw?.encrypted) {
      // Decrypt the payload
      const decrypted = await decryptPayload(raw.encrypted);
      if (decrypted) {
        title = decrypted.title || title;
        body  = decrypted.body  || body;
      } else {
        // Key not available yet (SW was restarted) — show a generic nudge
        body = 'Open Pantry to check your items.';
      }
    } else if (raw?.title) {
      // Unencrypted fallback (shouldn't normally happen)
      title = raw.title;
      body  = raw.body || body;
    }
  } catch(err) {
    console.error('[SW] Push handling error:', err);
  }

  return self.registration.showNotification(title, {
    body,
    icon,
    badge,
    tag:     'pantry-daily',   // replaces previous notification rather than stacking
    renotify: false,
    data:    { url: self.registration.scope },
  });
}

// ═══════════════════════════════════════════════
//  Notification click handler
//  Opens or focuses the app when tapped
// ═══════════════════════════════════════════════
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If the app is already open, focus it
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(self.registration.scope);
    })
  );
});
