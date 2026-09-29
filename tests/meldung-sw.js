// Der Service Worker beim Antippen einer Meldung (29.09.2026).
//
// Eine echte Systemmeldung lässt sich im Test nicht antippen. Deshalb läuft public/sw.js hier in einer
// nachgebauten Umgebung (node:vm) mit erfundenen Fenstern, und das Antippen wird als Ereignis ausgelöst.
// Geprüft wird, was vorher schiefgehen konnte (Alex: Meldung „Gast hat bearbeitet" → Willkommensseite):
//   * Die GÄSTESEITE (/gast) ist nie das Ziel — auch nicht, wenn sie vorne liegt. Sie bekommt weder die
//     Nachricht noch eine Umleitung (die hätte die Sitzung des Gasts beendet).
//   * Von mehreren App-Fenstern gewinnt das mit Fokus, sonst ein sichtbares.
//   * Ist keine App offen, reist das genaue Ziel in der Adresse mit (/?meldung=…#/…).
//   * Zusammenfassung/Testmeldung („/") reißt niemanden aus der offenen App.
//   * Die angezeigte Meldung trägt Adresse UND genaues Ziel.
//
//   node tests/meldung-sw.js
const fs = require('fs'); const path = require('path'); const vm = require('vm');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function swLaden() {
  const handler = {};
  const welt = { fenster: [], geoeffnet: [], gezeigt: [] };
  const self = {
    addEventListener: (typ, fn) => { handler[typ] = fn; },
    clients: { matchAll: async () => welt.fenster, openWindow: async (u) => { welt.geoeffnet.push(u); }, claim: async () => {} },
    registration: { showNotification: async (titel, opt) => { welt.gezeigt.push({ titel, opt }); } },
    skipWaiting: () => {},
  };
  const kontext = { self, URL, console, caches: { open: async () => ({}), keys: async () => [], delete: async () => true }, fetch: async () => ({}) };
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), kontext);
  return { handler, welt };
}
function fenster(name, url, { focused = false, sichtbar = true } = {}) {
  return { name, url, focused, visibilityState: sichtbar ? 'visible' : 'hidden', nachrichten: [], umgeleitet: [], fokussiert: 0,
    postMessage(m) { this.nachrichten.push(m); }, async navigate(u) { this.umgeleitet.push(u); }, async focus() { this.fokussiert++; } };
}
async function antippen(sw, data) {
  let warten = null;
  sw.handler.notificationclick({ notification: { data, close() {} }, waitUntil(p) { warten = p; } });
  await warten;
}

(async () => {
  const ZIEL = { art: 'notiz', id: 7 };
  console.log('Angezeigte Meldung');
  {
    const sw = swLaden();
    let warten = null;
    sw.handler.push({ data: { json: () => ({ title: 'Notiz bearbeitet', body: 'x', url: '/#/notes', ziel: ZIEL }) }, waitUntil(p) { warten = p; } });
    await warten;
    const d = sw.welt.gezeigt[0] && sw.welt.gezeigt[0].opt.data;
    ok('trägt Adresse und genaues Ziel', d && d.url === '/#/notes' && JSON.stringify(d.ziel) === JSON.stringify(ZIEL), JSON.stringify(d));
  }

  console.log('Gästeseite vorne, App dahinter');
  {
    const sw = swLaden();
    const gast = fenster('gast', 'https://x.de/gast#t=abc', { focused: true });
    const app = fenster('app', 'https://x.de/#/welcome');
    sw.welt.fenster = [gast, app];
    await antippen(sw, { url: '/#/notes', ziel: ZIEL });
    ok('die App bekommt die Nachricht — mit genauem Ziel', app.nachrichten.length === 1 && app.nachrichten[0].typ === 'meldung-geklickt'
      && app.nachrichten[0].url === '/#/notes' && JSON.stringify(app.nachrichten[0].ziel) === JSON.stringify(ZIEL), JSON.stringify(app.nachrichten));
    ok('… und kommt nach vorn', app.fokussiert === 1);
    ok('die Gästeseite bleibt unberührt (keine Nachricht, keine Umleitung, kein Fokus)', gast.nachrichten.length === 0 && gast.umgeleitet.length === 0 && gast.fokussiert === 0,
      JSON.stringify({ n: gast.nachrichten, u: gast.umgeleitet }));
    ok('kein neues Fenster', sw.welt.geoeffnet.length === 0);
  }

  console.log('Mehrere App-Fenster');
  {
    const sw = swLaden();
    const hinten = fenster('hinten', 'https://x.de/#/planning', { sichtbar: false });
    const vorn = fenster('vorn', 'https://x.de/#/welcome', { focused: true });
    sw.welt.fenster = [hinten, vorn];
    await antippen(sw, { url: '/#/orders', ziel: { art: 'bestellung', id: 3 } });
    ok('das Fenster mit Fokus gewinnt', vorn.nachrichten.length === 1 && hinten.nachrichten.length === 0);
    const sw2 = swLaden();
    const unsichtbar = fenster('unsichtbar', 'https://x.de/#/a', { sichtbar: false });
    const sichtbar = fenster('sichtbar', 'https://x.de/#/b');
    sw2.welt.fenster = [unsichtbar, sichtbar];
    await antippen(sw2, { url: '/#/orders', ziel: null });
    ok('ohne Fokus: das sichtbare', sichtbar.nachrichten.length === 1 && unsichtbar.nachrichten.length === 0);
  }

  console.log('Keine App offen');
  {
    const sw = swLaden();
    const gast = fenster('gast', 'https://x.de/gast#t=abc', { focused: true });
    sw.welt.fenster = [gast];
    await antippen(sw, { url: '/#/notes', ziel: ZIEL });
    const erwartet = '/?meldung=' + encodeURIComponent(JSON.stringify(ZIEL)) + '#/notes';
    ok('neues Fenster mit dem Ziel in der Adresse (/?meldung=…#/notes)', sw.welt.geoeffnet[0] === erwartet, JSON.stringify(sw.welt.geoeffnet));
    ok('… die offene Gästeseite bleibt unberührt', gast.nachrichten.length === 0 && gast.umgeleitet.length === 0);
    const sw2 = swLaden();
    await antippen(sw2, { url: '/#/notes', ziel: null });
    ok('ohne genaues Ziel: nur die Adresse', sw2.welt.geoeffnet[0] === '/#/notes', JSON.stringify(sw2.welt.geoeffnet));
  }

  console.log('Zusammenfassung / Testmeldung');
  {
    const sw = swLaden();
    const app = fenster('app', 'https://x.de/#/entry/new', { focused: true });
    sw.welt.fenster = [app];
    await antippen(sw, { url: '/', ziel: null });
    ok('„/": keine Nachricht, keine Umleitung — nur nach vorn (niemand wird aus einem Formular gerissen)',
      app.nachrichten.length === 0 && app.umgeleitet.length === 0 && app.fokussiert === 1);
  }

  console.log(`\nService Worker beim Antippen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
