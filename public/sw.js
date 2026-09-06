const CACHE_VERSION = 356;
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
// Klick auf eine Meldung soll in dem Menue landen, aus dem sie kam.
//
// Warum das nicht mit `client.navigate()` allein geht: Die App ist eine HASH-Anwendung. Der Sprung
// von /#/dashboard nach /#/orders ist keine neue Seite, sondern eine Routen-Aenderung im laufenden
// Programm. `navigate()` gibt dafuer ein Versprechen zurueck, das still abgelehnt werden kann
// (nicht kontrollierter Client, reiner Fragmentwechsel) — und ein `try/catch` faengt das NICHT,
// weil die Ablehnung asynchron kommt. Ausserdem lief `focus()` vorher sofort los, ohne die
// Navigation abzuwarten. Ergebnis: Die App kam nach vorn und blieb stehen, wo sie war
// (Alex, 27.08.2026).
//
// Deshalb zwei Wege, in dieser Reihenfolge:
//   1. Der offenen App direkt sagen, wohin — sie routet selbst, ohne Neuladen.
//   2. `navigate()` als Rueckfall fuer eine alte, noch gecachte Programmfassung ohne den
//      Empfaenger aus Schritt 1. Steht die App danach schon richtig, ist es ein Leerlauf.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ziel = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      // '/' ist das Ziel der Zusammenfassung und der Testmeldung — die haben kein eigenes Menue.
      // Wer gerade mitten in einem Formular steckt, soll davon nicht weggerissen werden.
      if (ziel !== '/') {
        try { w.postMessage({ typ: 'meldung-geklickt', url: ziel }); } catch (_) {}
        if ('navigate' in w) { try { await w.navigate(ziel); } catch (_) {} }
      }
      if ('focus' in w) { try { return await w.focus(); } catch (_) {} }
      return;
    }
    if (self.clients.openWindow) return self.clients.openWindow(ziel);
  })());
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
