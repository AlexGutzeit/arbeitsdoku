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
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    location.reload();
  });
}
