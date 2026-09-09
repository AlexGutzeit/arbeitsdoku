// Der Katalog-Spiegel auf dem Gerät (Alex, 09.09.2026).
//
// Im Lager ist die Verbindung nicht „da oder weg", sondern zäh: Das Handy hängt im WLAN, aber
// nichts kommt durch. Dieser Test baut genau das nach — einmal mit abgewiesenen Anfragen (Netz
// weg) und einmal mit HÄNGENDEN Anfragen (verbunden, aber ohne Route). Der zweite Fall ist der
// unangenehmere: Ohne Zeitgrenze stünde die Bestellseite minutenlang leer da, und niemand
// bemerkt es beim Entwickeln, weil im Büro alles sofort antwortet.
//
// Drei Zusagen:
//  1. Ohne Verbindung finden Suche und Barcode-Nachschlag trotzdem, was zuletzt bekannt war.
//  2. Die Seite SAGT, dass sie aus dem Gerätespeicher arbeitet — und dass Absenden und Anlegen
//     nicht gehen. Ein stiller Spiegel wäre schlimmer als keiner: Man hielte eine alte Liste für
//     die aktuelle.
//  3. Eine ANTWORT des Servers wird nie vom Spiegel überschrieben. Der Server weiß von gelöschten
//     Produkten, die Kopie nicht.
//
//   node tests/katalog-spiegel-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3310, DB = '/tmp/katalog-spiegel-ui.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/katalog-spiegel-ui-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Die Verbindung nachstellen.
//
// ERST versucht mit `setRequestInterception` — das greift mit einem aktiven Service Worker NICHT
// zuverlaessig: Anfragen laufen dann ueber dessen Ziel und nicht ueber das der Seite. Der Test war
// dadurch gruen, ohne je etwas abgeschnitten zu haben. `setOfflineMode` schaltet die Verbindung im
// Browser selbst ab und gilt fuer alles.
async function offline(seite, an) { await seite.setOfflineMode(an); }

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
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;

    await req('POST', '/api/products/kategorien', admin, { name: 'Elektro' });
    const kabel = (await req('POST', '/api/products', admin, { name: 'Kabelbinder 200 mm', barcode: '4001111111111' })).body.produkt;
    await req('POST', '/api/products', admin, { name: 'Aderendhülse 2,5', barcode: '4002222222222' });
    const weg = (await req('POST', '/api/products', admin, { name: 'Altlast', barcode: '4009999999999' })).body.produkt;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 950 });
    seite.setDefaultTimeout(30000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));

    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pwAdmin);
    await seite.click('#login-form button[type="submit"]');
    await sleep(2500);

    console.log('── Mit Verbindung: die Kopie entsteht ──');
    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const kopie = await seite.evaluate(() => { try { return JSON.parse(localStorage.getItem('arbeitsdoku.katalog.v1')); } catch (_) { return null; } });
    ok('der Katalog liegt im Gerätespeicher', !!kopie && kopie.produkte.length === 3, JSON.stringify(kopie && kopie.produkte.length));
    ok('… mit den Barcodes', !!kopie && kopie.produkte.some(p => (p.barcodes || []).includes('4001111111111')),
      JSON.stringify(kopie && kopie.produkte[0]));
    ok('… und dem Stand VOM SERVER (Handyuhren gehen falsch)', !!kopie && /^\d{4}-\d{2}-\d{2} /.test(String(kopie.stand)), String(kopie && kopie.stand));
    ok('kein Hinweis, solange frisch geladen wurde',
      !(await seite.evaluate(() => document.body.innerText.includes('Gerätespeicher'))));

    console.log('\n── Netz weg, App neu geoeffnet: der Spiegel traegt ──');
    // Neu geladen, nicht nur neu gerendert: Genau so kommt das Handy morgens aus der Tasche.
    // Die Programmdateien liefert der Service Worker aus seinem Cache, die Daten niemand.
    await offline(seite, true);
    // reload(), NICHT goto(): Ein goto auf dieselbe Adresse mit gleichem Hash laedt gar nichts neu
    // — die Seite bliebe die online gerenderte, und der Test waere gruen, ohne etwas zu pruefen.
    // (Dieselbe Falle wie schon bei den Auszahlungs-Tests.)
    await seite.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3500);
    ok('die Bestellseite steht trotzdem', await seite.evaluate(() => !!document.getElementById('order-add-btn')));
    ok('… und sagt, dass die Liste fehlt', await seite.evaluate(() => /konnten nicht geladen werden/.test(document.body.innerText)));
    ok('die Seite sagt, dass sie aus dem Gerätespeicher arbeitet',
      await seite.evaluate(() => document.body.innerText.includes('Gerätespeicher')),
      (await seite.evaluate(() => document.body.innerText)).slice(0, 160));
    ok('… und dass Absenden und Anlegen nicht gehen',
      await seite.evaluate(() => /Absenden und Anlegen nicht/.test(document.body.innerText)));

    await seite.click('#order-add-btn');
    await seite.waitForSelector('#of-product');
    await seite.type('#of-product', 'kabel');
    await sleep(700);
    const vorschlaege = await seite.evaluate(() => {
      const ul = document.getElementById('of-vorschlaege');
      return { sichtbar: ul && ul.style.display !== 'none', text: ul ? ul.innerText : '' };
    });
    ok('die Live-Suche findet aus der Kopie', vorschlaege.sichtbar && /Kabelbinder/.test(vorschlaege.text),
      JSON.stringify(vorschlaege));
    ok('die Kategorie steht auch zur Wahl',
      await seite.evaluate(() => !!document.getElementById('of-kategorie') && /Elektro/.test(document.getElementById('of-kategorie').innerText)));

    const treffer = await seite.evaluate(() => barcodeNachschlagen('4001111111111'));
    ok('der Barcode wird in der Kopie gefunden', treffer.gefunden === true && treffer.produkt.name === 'Kabelbinder 200 mm', JSON.stringify(treffer));
    ok('… und es ist gekennzeichnet, dass er aus der Kopie kommt', treffer.ausSpiegel === true, JSON.stringify(treffer.ausSpiegel));
    const unbekannt = await seite.evaluate(() => barcodeNachschlagen('9999999999999'));
    ok('ein unbekannter Code meldet sich als unbekannt UND als ungeprüft',
      unbekannt.gefunden === false && unbekannt.ausSpiegel === true, JSON.stringify(unbekannt));

    console.log('\n── Der Server hat immer das letzte Wort ──');
    await offline(seite, false);
    await req('DELETE', `/api/products/${weg.id}`, admin);
    await seite.reload({ waitUntil: 'domcontentloaded' });   // wieder: reload, nicht goto
    await sleep(2500);
    ok('mit Verbindung verschwindet der Hinweis wieder',
      !(await seite.evaluate(() => document.body.innerText.includes('Gerätespeicher'))));
    const gel = await seite.evaluate(() => barcodeNachschlagen('4009999999999'));
    ok('ein gelöschtes Produkt meldet der Server — der Spiegel weiß davon nichts',
      gel.gefunden === false && !!gel.geloeschtes_produkt && gel.ausSpiegel === false, JSON.stringify(gel));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nKatalog-Spiegel: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
