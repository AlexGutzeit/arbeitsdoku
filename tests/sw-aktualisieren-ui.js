// „Jetzt aktualisieren" — der Weg auf eine neue Fassung, einmal wirklich durchgespielt.
//
// Alex am 15.09.2026: „Der 'jetzt aktualisieren' Button funktioniert nicht mehr." Das ist die
// unangenehmste Sorte Fehler: Wer nicht aktualisieren kann, bleibt auf einem alten Stand — und
// merkt von jeder Reparatur nichts mehr. Getestet hat diesen Weg bis dahin NIEMAND.
//
// Warum ein eigener Mini-Server statt des echten:
// Für einen Update-Vorgang muss sich `sw.js` zwischen zwei Abrufen ÄNDERN. Die Datei im Repo dafür
// zu verbiegen wäre ein Test, der den Prüfling anfasst. Dieser Server liefert deshalb die ECHTEN
// Dateien (`public/js/sw-register.js`, `public/sw.js`) aus und tauscht nur die Versionsnummer im
// Service Worker aus — genau das, was ein Deploy auch tut.
//
// Geprüft wird die ganze Kette: registrieren → neue Fassung finden → Banner → Knopf → der neue
// Worker übernimmt → Seite lädt neu.
//
//   node tests/sw-aktualisieren-ui.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3321;
const BASIS = `http://localhost:${PORT}`;
const WURZEL = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// Die Versionsnummer, die der Server GERADE ausliefert. Wird im Test hochgezählt.
let ausgelieferteVersion = 900;

const swQuelle = fs.readFileSync(path.join(WURZEL, 'public', 'sw.js'), 'utf8');
const registerQuelle = fs.readFileSync(path.join(WURZEL, 'public', 'js', 'sw-register.js'), 'utf8');

// Eine minimale Seite — es geht um den Service Worker, nicht um die App.
const seiteHtml = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>SW-Probe</title></head>
<body><h1>SW-Probe</h1><script src="/js/sw-register.js"></script></body></html>`;

const server = http.createServer((req, res) => {
  const pfad = req.url.split('?')[0];
  const sende = (typ, inhalt) => {
    // KEIN Zwischenspeichern: Sonst sähe der Browser die neue sw.js gar nicht erst.
    res.writeHead(200, { 'Content-Type': typ, 'Cache-Control': 'no-store' });
    res.end(inhalt);
  };
  if (pfad === '/sw.js') {
    return sende('application/javascript',
      swQuelle.replace(/const CACHE_VERSION = \d+;/, `const CACHE_VERSION = ${ausgelieferteVersion};`));
  }
  if (pfad === '/js/sw-register.js') return sende('application/javascript', registerQuelle);
  if (pfad === '/' || pfad === '/index.html') return sende('text/html; charset=utf-8', seiteHtml);
  res.writeHead(404); res.end('nichts');
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    seite.setDefaultTimeout(30000);
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));
    // Navigationen zaehlen: Damit laesst sich beweisen, dass beim ERSTEN Besuch NICHT neu geladen
    // wird — der Grund, aus dem es die Bedingung ueberhaupt gibt.
    let navigationen = 0;
    seite.on('framenavigated', f => { if (f === seite.mainFrame()) navigationen++; });

    console.log('── Erster Besuch: der Service Worker übernimmt ──');
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    // Warten, bis ein Worker die Seite steuert (clients.claim beim ersten Start).
    await seite.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 })
      .catch(() => {});
    const erste = await seite.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { hatController: !!navigator.serviceWorker.controller, aktiv: !!(reg && reg.active) };
    });
    ok('ein Service Worker ist aktiv', erste.aktiv, JSON.stringify(erste));
    ok('… und steuert die Seite', erste.hatController, JSON.stringify(erste));
    ok('… und es gibt noch KEIN Banner', await seite.evaluate(() => !document.getElementById('sw-update-banner')));
    // DER GRUND FUER DIE BEDINGUNG: clients.claim() loest beim ersten Besuch ebenfalls einen
    // 'controllerchange' aus. Wuerde da neu geladen, verloere man eine gerade getippte Anmeldung.
    await sleep(1500);
    ok('… und der erste Besuch laedt NICHT neu (sonst waere die Anmeldung weg)',
      navigationen === 1, `${navigationen} Navigationen`);

    console.log('\n── Eine neue Fassung erscheint ──');
    ausgelieferteVersion = 901;                 // das tut ein Deploy
    await seite.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await seite.waitForSelector('#sw-update-banner', { timeout: 20000 }).catch(() => {});
    ok('das Banner „Neue Version verfügbar" erscheint',
      await seite.evaluate(() => !!document.getElementById('sw-update-banner')));
    const wartet = await seite.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return { waiting: !!r.waiting, installing: !!r.installing, active: !!r.active };
    });
    ok('… und ein Worker WARTET wirklich (sonst tut der Knopf nichts)', wartet.waiting, JSON.stringify(wartet));

    console.log('\n── Der Knopf ──');
    // Die Seite lädt beim Wechsel neu — deshalb auf die Navigation warten, nicht auf einen Zustand
    // in der alten Seite. Ohne dieses Warten misst man das alte Dokument.
    const neuGeladen = seite.waitForNavigation({ timeout: 25000 }).then(() => true).catch(() => false);
    const vorKlick = Date.now();
    await seite.click('#sw-update-btn');
    const geladen = await neuGeladen;
    const dauer = Date.now() - vorKlick;
    ok('ein Klick lädt die Seite neu', geladen, String(geladen));
    ok('… und zwar genau einmal', navigationen === 2, `${navigationen} Navigationen`);
    // DIE SCHAERFE DES TESTS haengt an dieser Zusicherung. Ohne sie bliebe er auch mit der ALTEN,
    // zu groben Bedingung gruen — dann spraenge nur der 2-Sekunden-Notnagel ein, und der Fehler
    // waere bloss verdeckt statt behoben. Gemessen wird deshalb, dass die Seite ueber den
    // Controller-Wechsel neu laedt, also SOFORT.
    ok(`… sofort über den Controller-Wechsel, nicht erst über den Notnagel (${dauer} ms)`,
      dauer < 1500, `${dauer} ms — das riecht nach dem Notnagel bei 2000 ms`);

    await sleep(1200);
    const danach = await seite.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      const skript = r && r.active ? r.active.scriptURL : '';
      const antwort = await fetch('/sw.js', { cache: 'no-store' }).then(x => x.text());
      const geliefert = (antwort.match(/CACHE_VERSION = (\d+)/) || [])[1];
      return { banner: !!document.getElementById('sw-update-banner'), skript, geliefert,
               waiting: !!(r && r.waiting) };
    });
    ok('der neue Worker hat übernommen (keiner wartet mehr)', danach.waiting === false, JSON.stringify(danach));
    ok('… und das Banner ist weg', danach.banner === false, JSON.stringify(danach));
    ok('… der Server liefert die neue Fassung', danach.geliefert === '901', JSON.stringify(danach));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  console.log(`\nAktualisieren-Knopf: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
