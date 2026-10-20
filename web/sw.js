// Cache the shell only. Financial data and authentication responses are never cached.
const CACHE = 'stock-tracker-shell-v1';
self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || !['/', '/app.js', '/app.css', '/icon.svg', '/icon.png', '/manifest.webmanifest'].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try { const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }
    catch { return await cache.match(event.request) || Response.error(); }
  })());
});
