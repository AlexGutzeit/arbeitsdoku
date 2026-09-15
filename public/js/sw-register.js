// Service-Worker-Registrierung + Update-Banner.
// Ausgelagert aus index.html, damit die Content-Security-Policy ohne eingebettete <script> auskommt
// (script-src 'self'). Verhalten unveraendert.
if ('serviceWorker' in navigator) {
  // Beim ALLERERSTEN Besuch gibt es noch keinen Controller: Der Service Worker uebernimmt die
  // offene Seite per clients.claim(), was ebenfalls 'controllerchange' ausloest. Ein Reload waere
  // dort unnoetig und wuerde eine gerade getippte Anmeldung verwerfen.
  //
  // FRUEHER stand daraus die Bedingung `if (!hadController) return;` — und die war zu grob:
  // Sie verwarf JEDEN spaeteren Controller-Wechsel derselben Seitensitzung, also auch den, den
  // der Benutzer selbst ausgeloest hat. Wer die App zum ersten Mal oeffnete und dann waehrend
  // derselben Sitzung „Jetzt aktualisieren" drueckte, bekam: neuer Worker uebernimmt, aber kein
  // Reload — und das Banner blieb fuer immer stehen (Alex, 15.09.2026: „der Button funktioniert
  // nicht mehr", die App war da laengst aktuell). Nachgestellt in tests/sw-aktualisieren-ui.js.
  //
  // Deshalb zwei getrennte Gruende zum Neuladen: ein echter Controller-WECHSEL — oder ein Klick
  // auf den Knopf, egal was vorher war.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false, vomKnopf = false;
  const neuLaden = () => { if (refreshing) return; refreshing = true; location.reload(); };

  function showUpdateBanner(reg) {
    if (document.getElementById('sw-update-banner')) return;
    const b = document.createElement('div');
    b.id = 'sw-update-banner';
    b.innerHTML = 'Neue Version verfügbar <button id="sw-update-btn">Jetzt aktualisieren</button>';
    document.body.appendChild(b);
    const knopf = document.getElementById('sw-update-btn');
    knopf.addEventListener('click', () => {
      knopf.disabled = true;
      knopf.textContent = 'Wird geladen …';
      vomKnopf = true;
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // NOTNAGEL. Ein Knopf, der nichts sichtbar tut, ist schlimmer als einer, der zu viel tut:
      // Wartet gar kein Worker (weil er zwischenzeitlich selbst aktiv wurde), oder bleibt der
      // Controller-Wechsel aus, laedt die Seite nach zwei Sekunden eben von sich aus neu. Die
      // Seite kommt dann per Network-first ohnehin in der neuen Fassung.
      setTimeout(neuLaden, 2000);
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
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController && !vomKnopf) return;   // erster Besuch, blosses clients.claim()
    neuLaden();
  });
}
