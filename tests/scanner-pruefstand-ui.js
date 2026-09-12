// Der Prüfstand (public/scanner-probe.html) — ist überhaupt zu sehen, was man bedienen muss?
//
// Alex am 12.09.2026: „am Prüfstand ist gerade gar kein button zu sehen um das scannen zu
// aktivieren." Der Knopf hing an einem Häkchen, das AUS war, und seine Anfangsanzeige stand fest
// im HTML (`display:none`) statt am Häkchen — zwei Quellen für dieselbe Aussage, die auseinander
// liefen.
//
// Es ist das ZWEITE Mal, dass am Prüfstand ein Bedienelement unsichtbar war: vorher standen die
// beiden Schalter innerhalb von `#zoombox`, die ohne Kamera-Zoom ausgeblendet ist. Beides fiel
// keinem Test auf, weil KEINER die Seite je geladen hat. Genau das holt diese Datei nach.
//
// Geprüft wird ohne Kamera — headless gibt es keine. Das ist kein Mangel, sondern der Punkt:
// Die Bedienelemente müssen schon VOR dem Start sichtbar sein, sonst weiss niemand, was zu tun ist.
//
// STIRBT MIT DEM PRÜFSTAND. Wenn `public/scanner-probe.*` vor dem Produktivgang entfernt wird,
// gehört diese Datei mit weg.
//
//   node tests/scanner-pruefstand-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3312, DB = '/tmp/scanner-pruefstand-ui.db', LOG = '/tmp/scanner-pruefstand-ui.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => {
      let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s }));
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 420, height: 900 });   // Handy-Format, dafür ist er gebaut
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/scanner-probe.html', { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // checkVisibility() statt offsetParent — Chrome blendet mit content-visibility aus, ohne dass
    // offsetParent es merkt ([[reference_puppeteer_details_visibility]]).
    const sichtbar = (w) => seite.evaluate(x => {
      const el = document.querySelector(x);
      return !!el && el.checkVisibility();
    }, w);

    console.log('── Die Seite kommt überhaupt an ──');
    ok('der Prüfstand ist ohne Anmeldung erreichbar', (await req('GET', '/scanner-probe.html')).status === 200);
    ok('keine JavaScript-Fehler beim Laden', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));

    console.log('\n── Der Halte-Knopf ist DA, bevor irgendetwas gestartet wurde ──');
    ok('„Zum Scannen gedrückt halten" ist sichtbar', await sichtbar('#halten'));
    ok('… und das Häkchen dazu ist gesetzt (der Prüfstand verhält sich wie die App)',
      await seite.evaluate(() => document.getElementById('haltemodus').checked));
    const text = await seite.evaluate(() => document.getElementById('halten').innerText);
    ok('… der Knopf sagt, was zu tun ist', /gedrückt halten/i.test(text), JSON.stringify(text));

    // Alex, 09.09.2026: „kannst du den button unter das Kamera Bild setzen? Das ist auf dem
    // Smartphone intuitiver." Geprüft wird die Lage im Bild, nicht die Zeile im Quelltext.
    const lage = await seite.evaluate(() => {
      const b = document.getElementById('bildbox').getBoundingClientRect();
      const k = document.getElementById('halten').getBoundingClientRect();
      return { bildUnten: b.bottom, knopfOben: k.top };
    });
    ok('… und er sitzt UNTER dem Kamerabild (Daumen-Reichweite)',
      lage.knopfOben >= lage.bildUnten - 1, JSON.stringify(lage));

    console.log('\n── Das Häkchen ist die einzige Quelle für „sichtbar?" ──');
    await seite.evaluate(() => document.getElementById('haltemodus').click());
    await sleep(300);
    ok('ausgeschaltet verschwindet der Knopf', !(await sichtbar('#halten')));
    await seite.evaluate(() => document.getElementById('haltemodus').click());
    await sleep(300);
    ok('… und wieder eingeschaltet ist er zurück', await sichtbar('#halten'));

    console.log('\n── Die alte Falle: Schalter innerhalb von #zoombox ──');
    // #zoombox ist ohne Kamera-Zoom ausgeblendet. Lägen die Schalter darin, wären sie auf einem
    // Gerät ohne Zoom unsichtbar — genau der Fehler vom 09.09.2026.
    const drin = await seite.evaluate(() => ({
      zoomboxOffen: document.getElementById('zoombox').style.display !== 'none',
      halte: !!document.getElementById('haltemodus').closest('#zoombox'),
      rahmen: !!document.getElementById('nurrahmen').closest('#zoombox'),
      knopf: !!document.getElementById('halten').closest('#zoombox'),
    }));
    ok('ohne Kamera ist #zoombox zu (sonst misst der nächste Punkt nichts)', !drin.zoomboxOffen,
      JSON.stringify(drin));
    ok('… „gedrückt halten" liegt ausserhalb', !drin.halte);
    ok('… „nur im Rahmen lesen" auch', !drin.rahmen);
    ok('… und der Knopf selbst ebenfalls', !drin.knopf);
    ok('beide Schalter sind trotz zugeklappter #zoombox sichtbar',
      (await sichtbar('#haltemodus')) && (await sichtbar('#nurrahmen')));

    console.log('\n── Was man sonst noch braucht, ist ebenfalls da ──');
    for (const [w, name] of [['#start', 'Scanner starten'], ['#stop', 'Stoppen'],
      ['#kopieren', 'Ergebnis kopieren'], ['#nurrahmen', 'nur im Rahmen lesen']]) {
      ok(`„${name}" ist sichtbar`, await sichtbar(w));
    }

    console.log('\n── Der Browser bekommt auch wirklich die neue Fassung ──');
    // Der Prüfstand liegt NICHT im Service-Worker-Vorrat; sein `?v=` ist der einzige Hebel gegen
    // eine alte Fassung im Browser-Zwischenspeicher. Am 12.09.2026 stand dort noch 385, während
    // die Datei längst geändert war — auf dem Handy wäre die Änderung nie angekommen.
    const fassungen = await seite.evaluate(() => {
      const sk = [...document.querySelectorAll('script[src*="scanner-probe.js"]')][0];
      return { v: (sk && sk.getAttribute('src').match(/[?&]v=(\d+)/) || [])[1] || null };
    });
    const swText = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const cacheV = (swText.match(/CACHE_VERSION\s*=\s*(\d+)/) || [])[1];
    ok('das ?v= des Prüfstand-Skripts passt zur Cache-Nummer der App',
      fassungen.v === cacheV, JSON.stringify({ pruefstand: fassungen.v, sw: cacheV }));

    console.log('\n── Die Lesezeit zählt nur, solange wirklich gelesen wird ──');
    // Der Lauf vom 12.09.2026 meldete „318 Bilder geprüft (1.3/s)" — der Scanner sah lahm aus.
    // Er war es nicht: Geteilt wurde durch die ganze verstrichene Zeit, obwohl im Haltebetrieb
    // nur beim Drücken überhaupt ein Bild angesehen wird (308 Lesungen aus 318 Bildern = 97 %).
    const zeit = await seite.evaluate(async () => {
      const P = window.__pruefstand;
      const warte = (ms) => new Promise(r => setTimeout(r, ms));
      P.lesenStop();                       // Ausgangslage: Uhr steht
      const start = P.lesezeitMs();
      P.lesenStart(); await warte(300); P.lesenStop();
      const nachLesen = P.lesezeitMs();
      await warte(300);                    // Pause — hier darf NICHTS dazukommen
      const nachPause = P.lesezeitMs();
      P.lesenStart(); await warte(200); P.lesenStop();
      return { start, gelesen: nachLesen - start, waehrendPause: nachPause - nachLesen,
               gesamt: P.lesezeitMs() - start };
    });
    ok('eine Haltung von 300 ms zählt als etwa 300 ms',
      zeit.gelesen > 250 && zeit.gelesen < 450, JSON.stringify(zeit));
    ok('… eine Pause von 300 ms zählt GAR NICHT',
      zeit.waehrendPause < 20, JSON.stringify(zeit));
    ok('… zwei Haltungen summieren sich (300 + 200)',
      zeit.gesamt > 450 && zeit.gesamt < 750, JSON.stringify(zeit));

    console.log('\n── Der Bericht sagt, wie gemessen wurde ──');
    // Ohne die Stellung der beiden Schalter sind die Zahlen nicht deutbar — im Lauf vom
    // 12.09.2026 fehlte sie, und damit war offen, ob Haltebetrieb oder Dauerlesen gemessen wurde.
    // Die Zwischenablage ist headless nicht erreichbar — der Text entsteht aber davor, in einer
    // eigenen Funktion. Genau deshalb ist sie aus dem Klick-Handler herausgelöst.
    const bericht = () => seite.evaluate(() => window.__pruefstand.bericht());
    let txt = await bericht();
    ok('der Bericht nennt „gedrückt halten: an"', /gedrückt halten: an/.test(txt), txt.slice(0, 300));
    ok('… und „nur im Rahmen lesen: an"', /nur im Rahmen lesen: an/.test(txt), txt.slice(0, 300));
    await seite.evaluate(() => document.getElementById('nurrahmen').click());
    await sleep(200);
    txt = await bericht();
    ok('… und er folgt dem Schalter (abgeschaltet steht es auch da)',
      /nur im Rahmen lesen: AUS/.test(txt), txt.slice(0, 300));

    ok('am Ende immer noch keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }

  console.log(`\nPrüfstand (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
