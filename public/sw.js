/* MyTube service worker: makes the app installable and lets the shell open
   offline. Static files are network-first (so a redeploy shows up on the next
   open) with a cache fallback; /api is never cached. */
const CACHE = 'mytube-shell-v5';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/api.js', '/store.js', '/lounge.js', '/icons.js', '/debug.js', '/media.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    // cache: 'no-cache' makes the browser revalidate with the server instead of using its HTTP cache,
    // so every file of the app comes from the same deploy.
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw new Error(`Offline and ${url.pathname} is not cached`);
      })
  );
});
