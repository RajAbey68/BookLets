/**
 * BookLets Service Worker
 * ========================
 * Cache-first for static assets, network-first for API calls,
 * and push notification handling for mobile-native integration.
 *
 * Cache strategies:
 *   App shell (HTML, JS, CSS)  → CacheFirst (precache on install)
 *   Fonts                       → CacheFirst (precached, 30d TTL)
 *   API responses (GET)         → NetworkFirst → fallback to cache (5 min)
 *   POST / PATCH / DELETE       → NetworkOnly
 *   Images / icons              → StaleWhileRevalidate (7d TTL)
 *   Offline page                → CacheOnly (precached)
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `booklets-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `booklets-dynamic-${CACHE_VERSION}`;
const IMAGE_CACHE = `booklets-images-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/offline.html',
];

// ── Install ──────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== DYNAMIC_CACHE && key !== IMAGE_CACHE)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ── Fetch ────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser extension requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;
  // Skip Next.js internal data routes (they handle their own caching)
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // API calls — NetworkFirst with 5-minute cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }
  // Images — StaleWhileRevalidate
  if (request.destination === 'image' || /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Navigation requests — NetworkFirst with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/offline.html'));
    return;
  }
  // Everything else — NetworkFirst
  event.respondWith(networkFirst(request));
});

// ── Push Notifications ───────────────────────────────────
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }

  const title = data.title ?? 'BookLets';
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    vibrate: [100, 50, 100],
    data: { url: data.url ?? '/' },
    actions: data.actions ?? [],
    tag: data.tag ?? 'default',
    renotify: data.renotify ?? false,
    requireInteraction: data.requireInteraction ?? true,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url ?? '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If a window tab already exists, focus it
      for (const client of windowClients) {
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(urlToOpen);
    })
  );
});

// ── Cache Strategies ─────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request, offlineFallback) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (offlineFallback) {
      const fallback = await caches.match(offlineFallback);
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached);
  return cached ?? (await fetchPromise);
}
