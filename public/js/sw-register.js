// Service-Worker-Registrierung + Update-Banner.
// Ausgelagert aus index.html, damit die Content-Security-Policy ohne eingebettete <script> auskommt
// (script-src 'self'). Verhalten unveraendert.
if ('serviceWorker' in navigator) {
  function showUpdateBanner(reg) {
    if (document.getElementById('sw-update-banner')) return;
    const b = document.createElement('div');
    b.id = 'sw-update-banner';
    b.innerHTML = 'Neue Version verfügbar <button id="sw-update-btn">Jetzt aktualisieren</button>';
    document.body.appendChild(b);
    document.getElementById('sw-update-btn').addEventListener('click', () => {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
  }

  // Gegenstueck zu `notificationclick` im Service Worker: Wer auf eine Meldung tippt, soll in dem
  // Menue landen, aus dem sie kam. Die App routet das selbst ueber den Hash — ohne Neuladen, und
  // ohne dass `client.navigate()` bei einem reinen Fragmentwechsel still scheitern kann.
  //
  // Bewusst NUR fuer '/#/...'-Ziele: Die Zusammenfassung und die Testmeldung zeigen auf '/' und
  // sollen niemanden aus einem offenen Formular reissen.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || d.typ !== 'meldung-geklickt') return;
    const ziel = String(d.url || '');
    const raute = ziel.indexOf('#');
    if (raute < 0) return;
    const hash = ziel.slice(raute + 1);
    if (!hash.startsWith('/')) return;
    if (window.location.hash.slice(1) === hash) return;   // steht schon richtig
    window.location.hash = hash;
  });

  navigator.serviceWorker.register('/sw.js').then(reg => {
    setInterval(() => reg.update(), 60000);
    // SW wartet bereits (z.B. Tab war beim letzten Update offen)
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
      });
    });
  });
  // Beim ALLERERSTEN Besuch gibt es noch keinen Controller: Der Service Worker uebernimmt die offene Seite
  // per clients.claim(), was ebenfalls 'controllerchange' ausloest. Ein Reload waere dort unnoetig (die Seite
  // ist bereits aktuell) und wuerde eine gerade getippte Anmeldung verwerfen. Nur bei einem echten
  // Controller-WECHSEL (= Update) neu laden, und das hoechstens einmal.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });
}
