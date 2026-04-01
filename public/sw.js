const CACHE_VERSION = 87;
const CACHE_NAME = 'arbeitsdoku-v' + CACHE_VERSION;

// Install: NICHT sofort aktivieren — warten bis User bestätigt oder App neu startet
self.addEventListener('install', (event) => {
  // kein skipWaiting() hier — wird per Nachricht oder beim nächsten App-Start aktiviert
});

// Activate: alle alten Caches löschen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Auf SKIP_WAITING-Nachricht vom Client reagieren (Button "Jetzt aktualisieren")
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
