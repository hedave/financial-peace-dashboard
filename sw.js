const CACHE = 'finpeace-v17';

// Minimal precache — HTML/JS/CSS always network-first so deploys win
const PRECACHE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_ACTIVATED', cache: CACHE }));
      }),
  );
});

function isAppShell(url) {
  const p = url.pathname;
  return p.endsWith('.js')
    || p.endsWith('.css')
    || p.endsWith('.html')
    || p === '/'
    || p.endsWith('/')
    || p.endsWith('sw.js');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the service worker script itself
  if (url.pathname.endsWith('/sw.js') || url.pathname === '/sw.js') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  // Network-first for app shell — fall back to cache only when offline
  if (e.request.mode === 'navigate' || isAppShell(url)) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok && e.request.method === 'GET') {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(cached =>
          cached || caches.match('/index.html')
        )),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
