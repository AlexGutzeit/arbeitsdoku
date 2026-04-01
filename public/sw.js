const CACHE_VERSION = 84;
const CACHE_NAME = 'arbeitsdoku-v' + CACHE_VERSION;

// Install: sofort aktivieren
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: alle alten Caches löschen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Network-first für alles, Cache nur als Offline-Fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API-Aufrufe immer vom Netzwerk, nie cachen
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Alles andere: Network-first, bei Fehler aus Cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
