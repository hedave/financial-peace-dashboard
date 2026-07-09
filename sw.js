const CACHE = 'finpeace-v2';

// App shell only — JS/CSS use network-first so deploys show up without fighting the SW
const PRECACHE = [
  '/',
  '/index.html',
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
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function isAppAsset(url) {
  return url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.html')
    || url.pathname === '/'
    || url.pathname.endsWith('/');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for navigations and app code so updates deploy cleanly
  if (e.request.mode === 'navigate' || isAppAsset(url)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(cached =>
          cached || caches.match('/index.html')
        )),
    );
    return;
  }

  // Cache-first for icons and other static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
        }
        return res;
      });
    }),
  );
});
