const CACHE_VERSION = 318;
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

// Web-Push: Server schickt eine Benachrichtigung (auch bei geschlossener App). Der Payload ist
// JSON { title, body, url, icon }. Faellt das Parsen aus, wird eine generische Meldung gezeigt.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || 'Arbeitsdoku';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // Logo aus dem Payload (Branding-Icon des Kunden) — Fallback Standard-App-Icon.
      icon: data.icon || '/icons/icon-192x192.png',
      // Status-Leisten-Symbol: MUSS einfarbig + transparent sein, sonst weisses Quadrat.
      badge: '/icons/badge-96x96.png',
      // KEIN gemeinsames tag → jede Meldung bleibt einzeln stehen (sonst wuerde die naechste
      // Meldung derselben Route die vorige ersetzen).
      data: { url },
    })
  );
});

// Klick auf die Benachrichtigung: bestehendes App-Fenster fokussieren (und zur Route schicken)
// oder ein neues oeffnen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          if ('navigate' in w && url !== '/') { try { w.navigate(url); } catch (_) {} }
          return w.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// Fetch: Network-first für alles, Cache nur als Offline-Fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API-Aufrufe: kein respondWith — Browser holt direkt vom Netz (kein SW-Overhead, kein offener Fetch-Stream)
  if (url.pathname.startsWith('/api/')) return;
  // Manifest darf NIE gecached werden (Branding-Aenderung wird sonst nicht sichtbar)
  if (url.pathname === '/manifest.json') return;
  // Custom-Icons darf nie gecached werden (Icon-Wechsel waere sonst nicht sichtbar)
  if (url.pathname.startsWith('/uploads/icons/')) return;

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
