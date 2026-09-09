// Der Scanner liest nur noch, was im Rahmen liegt (Alex, 09.09.2026).
//
// Anlass: `4311`, ein QR, der in zwei Läufen 16- bzw. 18-mal gelesen wurde und den niemand
// zuordnen kann. Als 2D-Code hätte er jeden Strichcode geschlagen — hängt so ein Aufkleber im
// Fahrzeug oder am Regal, scannt man am Ziel vorbei. Alex: „Das Scanner Feld einzuschränken wäre
// auf jeden Fall eine gute Idee. Dann aber bitte auch optisch sichtbar."
//
// Der grüne Rahmen gab es vorher schon — als reine Dekoration. Ein Rahmen, der etwas anderes
// verspricht als das Programm tut, ist schlimmer als kein Rahmen. Dieser Test schreibt deshalb
// die Gleichheit fest: WAS MAN SIEHT, IST WAS GELESEN WIRD.
//
// Was hier NICHT geprüft werden kann: dass ein echter Barcode aus dem Ausschnitt gelesen wird.
// Der mitgelieferte Decoder enthält keine Encoder, es lässt sich also kein Testcode erzeugen, und
// die Kamera-Attrappe von Chrome liefert nur ein Rollmuster. Belegt ist stattdessen, dass die
// benutzte Kette (Canvas → HTMLCanvasElementLuminanceSource → BinaryBitmap → decodeBitmap)
// GENAU die ist, die ZXing intern selbst verwendet — nachgelesen im Bundle. Der Beweis am Regal
// bleibt der Prüfstand.
//
//   node tests/scanner-ausschnitt-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3315, DB = '/tmp/scanner-ausschnitt.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/scanner-ausschnitt-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const ktx = browser.defaultBrowserContext();
    await ktx.overridePermissions(BASIS, ['camera']);
    const seite = await browser.newPage();
    await seite.setViewport({ width: 420, height: 900, isMobile: true });
    seite.setDefaultTimeout(30000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));

    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pwAdmin);
    await seite.click('#login-form button[type="submit"]');
    await sleep(2500);
    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#order-add-btn'); await sleep(800);

    console.log('── Die Umrechnung des Rahmens ins Videobild ──');
    // object-fit: cover vergroessert das Video, bis die Box gefuellt ist — links/rechts oder
    // oben/unten faellt etwas weg. Wer die Prozentwerte einfach auf videoWidth anwendet, liest
    // den falschen Bereich, und zwar unbemerkt: Es werden ja trotzdem Codes gefunden.
    const geo = await seite.evaluate(() => ({
      hochkant: scannerAusschnittRechteck(1080, 1920, 380, 500, { left: 30, top: 185, width: 319, height: 130 }),
      quer:     scannerAusschnittRechteck(1920, 1080, 380, 500, { left: 30, top: 185, width: 319, height: 130 }),
      ueberRand: scannerAusschnittRechteck(1080, 1920, 380, 500, { left: -50, top: -50, width: 900, height: 900 }),
      ohneVideo: scannerAusschnittRechteck(0, 0, 380, 500, { left: 0, top: 0, width: 10, height: 10 }),
    }));
    // Massstab = max(380/1080, 500/1920) = 0,3519; Versatz oben = (1920*0,3519-500)/2 = 87,8
    // → oben (185+87,8)/0,3519 = 775 ; Hoehe 130/0,3519 = 369 ; Breite 319/0,3519 = 907
    ok('hochkant richtig umgerechnet',
      geo.hochkant.sx === 85 && geo.hochkant.sy === 775 && geo.hochkant.sw === 907 && geo.hochkant.sh === 369,
      JSON.stringify(geo.hochkant));
    ok('quer ebenso (dort wird links/rechts beschnitten)',
      geo.quer.sy === 400 && geo.quer.sx > 0 && geo.quer.sw < 1920, JSON.stringify(geo.quer));
    ok('ein Rahmen über den Bildrand hinaus wird begrenzt, nicht negativ',
      geo.ueberRand.sx >= 0 && geo.ueberRand.sy >= 0
      && geo.ueberRand.sx + geo.ueberRand.sw <= 1080 && geo.ueberRand.sy + geo.ueberRand.sh <= 1920,
      JSON.stringify(geo.ueberRand));
    ok('ohne Videomasse gibt es keinen Ausschnitt', geo.ohneVideo === null, JSON.stringify(geo.ohneVideo));

    console.log('\n── Der Ausschnitt schneidet wirklich ab ──');
    // Nicht die Rechnung, sondern die WIRKUNG: Was ausserhalb liegt, darf im Ausschnitt nicht
    // mehr auftauchen. Mit Farben statt Barcodes, damit die Aussage eindeutig ist.
    const farben = await seite.evaluate(() => {
      const gross = document.createElement('canvas'); gross.width = 400; gross.height = 300;
      const g = gross.getContext('2d');
      g.fillStyle = '#ff0000'; g.fillRect(0, 0, 400, 300);        // alles rot …
      g.fillStyle = '#00ff00'; g.fillRect(100, 100, 200, 100);    // … nur der Zielbereich grün
      const aus = document.createElement('canvas'); aus.width = 200; aus.height = 100;
      aus.getContext('2d').drawImage(gross, 100, 100, 200, 100, 0, 0, 200, 100);
      const d = aus.getContext('2d').getImageData(0, 0, 200, 100).data;
      let rot = 0, gruen = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] > 200) rot++; if (d[i + 1] > 200) gruen++; }
      return { rot, gruen, punkte: d.length / 4 };
    });
    ok('im Ausschnitt steht nur der Zielbereich', farben.gruen === farben.punkte && farben.rot === 0,
      JSON.stringify(farben));

    console.log('\n── Die Lesekette des mitgelieferten Decoders ──');
    // Nicht: „findet einen Barcode" (dafuer fehlt ein Testcode), sondern: „ist richtig verdrahtet".
    // Ein leeres Bild muss NotFoundException geben — ein TypeError hiesse, die API stimmt nicht.
    const kette = await seite.evaluate(async () => {
      await new Promise(r => { const s = document.createElement('script'); s.src = '/vendor/zxing.min.js'; s.onload = r; s.onerror = r; document.head.appendChild(s); });
      const c = document.createElement('canvas'); c.width = 120; c.height = 60;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 60);
      try { scannerAusCanvasLesen(c, null); return { art: 'kein Fehler' }; }
      catch (e) { return { art: e && e.constructor && e.constructor.name, istNotFound: (typeof ZXing !== 'undefined') && (e instanceof ZXing.NotFoundException), text: String(e && e.message || e).slice(0, 60) }; }
    });
    ok('ein leeres Bild meldet „nichts gefunden", keinen Programmierfehler',
      kette.istNotFound === true, JSON.stringify(kette));

    console.log('\n── Am laufenden Scanner: gelesen wird der Rahmen ──');
    // Der native Decoder wird durch eine Attrappe ersetzt, die mitschreibt, WAS sie bekommt.
    // Genau das ist die Zusage: nicht das Video, sondern der Ausschnitt.
    await seite.click('#order-add-btn'); await sleep(400);
    await seite.evaluate(() => {
      window.__mitschrift = [];
      window.BarcodeDetector = class {
        constructor(o) { window.__mitschrift.push({ art: 'neu', formate: (o && o.formats) || [] }); }
        async detect(quelle) {
          window.__mitschrift.push({ art: 'detect', tag: quelle && quelle.tagName,
            breite: quelle && quelle.width, hoehe: quelle && quelle.height });
          return [];
        }
      };
    });
    await seite.click('#of-scan');
    await seite.waitForSelector('#sc-video', { timeout: 20000 });
    await sleep(3000);

    const befund = await seite.evaluate(() => {
      const v = document.getElementById('sc-video'), r = document.getElementById('sc-rahmen');
      const vr = v.getBoundingClientRect(), rr = r.getBoundingClientRect();
      const erwartet = scannerAusschnittRechteck(v.videoWidth, v.videoHeight, vr.width, vr.height,
        { left: rr.left - vr.left, top: rr.top - vr.top, width: rr.width, height: rr.height });
      const detects = (window.__mitschrift || []).filter(m => m.art === 'detect');
      return {
        video: { b: v.videoWidth, h: v.videoHeight },
        rahmenSichtbar: r.checkVisibility(),
        rahmenImVideo: rr.left >= vr.left - 1 && rr.right <= vr.right + 1 && rr.top >= vr.top - 1 && rr.bottom <= vr.bottom + 1,
        erwartet, letzte: detects[detects.length - 1], anzahl: detects.length,
      };
    });
    ok('die Kamera läuft', befund.video.b > 0 && befund.video.h > 0, JSON.stringify(befund.video));
    ok('der Zielrahmen ist sichtbar', befund.rahmenSichtbar === true);

    // Die Sucher-Optik laesst sich auf dem gruenen Attrappenbild nicht mit dem Auge beurteilen —
    // also gemessen: vier Eckwinkel und ein abgedunkeltes Aussen.
    const optik = await seite.evaluate(() => {
      const r = document.getElementById('sc-rahmen');
      const g = (el, pseudo) => getComputedStyle(el, pseudo || null);
      // Je Element die STAERKSTE Kante nehmen. („0px" ist eine wahre Zeichenkette — ein `||`
      // haette bei der unteren Ecke die falsche Kante genommen und drei statt vier gezaehlt.)
      const staerkste = (st) => Math.max(...['borderTopWidth', 'borderRightWidth',
        'borderBottomWidth', 'borderLeftWidth'].map(k => parseFloat(st[k]) || 0));
      const winkel = [
        staerkste(g(r, '::before')), staerkste(g(r, '::after')),
        ...[...r.querySelectorAll('i')].map(i => staerkste(g(i))),
      ];
      return {
        ecken: winkel.filter(w => w >= 3).length,
        abdunklung: g(r).boxShadow,
        hinweis: (document.querySelector('.scanner-hinweis') || {}).textContent,
      };
    });
    ok('vier Eckwinkel markieren das Ziel', optik.ecken === 4, JSON.stringify(optik.ecken));
    ok('… das Aussen ist abgedunkelt', /rgba\(0, ?0, ?0, ?0\.[5-9]/.test(optik.abdunklung || ''), optik.abdunklung);
    ok('… und ein Satz sagt, was der Rahmen bedeutet',
      /Nur was im Rahmen liegt/.test(optik.hinweis || ''), JSON.stringify(optik.hinweis));
    ok('… und liegt vollständig im Kamerabild', befund.rahmenImVideo === true);
    ok('der Decoder wurde überhaupt gefüttert', befund.anzahl > 0, JSON.stringify(befund.anzahl));
    ok('… und zwar mit einem CANVAS, nicht mit dem Video',
      befund.letzte && befund.letzte.tag === 'CANVAS', JSON.stringify(befund.letzte));
    // Der Kern: die Masse des Gelesenen sind die des Rahmens — nicht die des Videos.
    ok('… dessen Maße genau der Rahmen sind (was man sieht, ist was gelesen wird)',
      befund.letzte && befund.erwartet
      && befund.letzte.breite === befund.erwartet.sw && befund.letzte.hoehe === befund.erwartet.sh,
      JSON.stringify({ gelesen: befund.letzte, rahmen: befund.erwartet }));
    ok('… und das ist deutlich kleiner als das ganze Bild',
      befund.letzte && befund.letzte.breite * befund.letzte.hoehe < befund.video.b * befund.video.h * 0.6,
      JSON.stringify({ ausschnitt: befund.letzte.breite * befund.letzte.hoehe, ganz: befund.video.b * befund.video.h }));

    await seite.evaluate(() => { const b = document.querySelector('[data-act="zu"]'); if (b) b.click(); });
    await sleep(600);
    ok('nach dem Abbrechen ist der Scanner weg', await seite.evaluate(() => !document.getElementById('sc-video')));
    const nachher = await seite.evaluate(() => (window.__mitschrift || []).filter(m => m.art === 'detect').length);
    await sleep(1200);
    const spaeter = await seite.evaluate(() => (window.__mitschrift || []).filter(m => m.art === 'detect').length);
    // Ueberlebende Schleifen waren hier schon einmal die Fehlerquelle.
    ok('… und die Leseschleife steht wirklich still', spaeter === nachher, `${nachher} → ${spaeter}`);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nScanner-Ausschnitt: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
