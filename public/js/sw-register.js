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
