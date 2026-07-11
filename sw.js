/* Terrain — service worker (offline support for the PWA)
   Strategy:
   - App shell (this page + icons + manifest): precached on install.
   - Navigations: network-first, fall back to the cached app shell when offline.
   - Other GETs (fonts, favicons, etc.): cache-first, then network, and cache
     the response for next time so the app looks right offline after first run.
   Bump CACHE when you change terrain.html so clients pick up the new version. */
const CACHE = 'terrain-v1';
const APP_SHELL = 'terrain.html';
const ASSETS = [
  APP_SHELL,
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // add() each asset individually so one missing file can't fail the whole install
    await Promise.allSettled(ASSETS.map(a => cache.add(a)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations (opening/refreshing the app): try network, fall back to cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(APP_SHELL, fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match(APP_SHELL));
      }
    })());
    return;
  }

  // Everything else: cache-first, then network (and cache what comes back).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Cache successful same-origin and opaque cross-origin (fonts) responses.
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
