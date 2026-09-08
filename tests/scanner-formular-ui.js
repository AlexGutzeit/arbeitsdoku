// Der Scanner im Bestellformular — mit GESTELLTEM Decoder.
//
// Eine echte Kamera lässt sich hier nicht nachstellen, ein Barcode auch nicht. Was sich prüfen
// lässt, ist alles, was DANACH passiert — und genau dort sitzen die Entscheidungen:
//   * bekannter Code  → Produkt eingesetzt, Einheit und Kategorie vorbelegt
//   * unbekannter Code → Maske, mit Live-Abgleich gegen bestehende Namen
//   * ein ähnlicher Name → Barcode ans BESTEHENDE Produkt anlernen statt ein Doppel anzulegen
//   * Code eines gelöschten Produkts → die App FRAGT, statt still zu entscheiden
//
// `scannerOeffnen` wird dafür ersetzt. Das ist ehrlich: Die Kamera selbst wurde auf echten
// Geräten geprüft (public/scanner-probe.html); hier geht es um die Logik dahinter.
//
//   node tests/scanner-formular-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3307, DB = '/tmp/scanner-formular-ui.db', LOG = '/tmp/scanner-formular-ui.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
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
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const tok = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;

    const kat = (await req('POST', '/api/products/kategorien', tok, { name: 'Befestigung' })).body.kategorie;
    const bekannt = (await req('POST', '/api/products', tok, {
      name: 'Kabelbinder 200 mm', barcode: '4050821808435', category_id: kat.id, default_unit: 'Beutel' })).body.produkt;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 900 });
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'max'); await seite.type('#login-pass', pw('max'));
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForSelector('a[href="#/statistics"]'); await sleep(900);

    // Den Scanner ersetzen: liefert den Code, den wir vorgeben.
    const scanVorgeben = (code) => seite.evaluate((c) => { window.scannerOeffnen = async () => c; }, code);

    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#order-add-btn'); await sleep(800);

    console.log('── Die Wahl unter mehreren gelesenen Codes ──');
    // Im Lager gemessen: Auf einem Karton lagen 043899923098 (UPC-A, 3x) und 4003899923098
    // (EAN-13, 12x) — 239 ms auseinander, beide mit gueltiger Pruefziffer. Wer den ERSTEN nimmt,
    // der die Schwelle erreicht, bekommt den schwaecheren.
    const wahl = await seite.evaluate(() => {
      const e = (code, n) => [code, { n, format: 'EAN_13' }];
      const q = (code, n) => [code, { n, format: 'QR_CODE' }];
      const f = (paare) => scannerBesterTreffer(new Map(paare));
      return {
        lagerfall: f([e('043899923098', 3), e('4003899923098', 12)]),
        knappDarunter: f([e('A', 2), e('B', 5)]),
        keinerReicht: f([e('A', 1), e('B', 2)]),
        einziger: f([e('A', 7)]),
        // Valentins Fall: echte Hersteller-QRs, einmal bzw. zweimal gelesen.
        qrEinmal: f([q('https://id.abb/2CKA006800A3087', 1)]),
        qrZweimal: f([q('https://qr.fischer.id/p/568010', 2)]),
        // Ein 2D-Code schlaegt einen 1D-Code auch mit weniger Lesungen.
        qrGegenEan: f([e('4011395319475', 10), q('https://id.abb/2CKA006800A3087', 1)]),
      };
    });
    ok('der öfter gelesene 1D-Code gewinnt', wahl.lagerfall === '4003899923098', JSON.stringify(wahl));
    ok('… wer die Schwelle verfehlt, zählt nicht', wahl.knappDarunter === 'B', JSON.stringify(wahl));
    ok('… reicht keiner, gibt es keinen Treffer', wahl.keinerReicht === null, JSON.stringify(wahl));
    ok('… ein einziger reicht auch', wahl.einziger === 'A', JSON.stringify(wahl));
    ok('ein QR gilt schon nach EINER Lesung (Fehlerkorrektur)',
      wahl.qrEinmal === 'https://id.abb/2CKA006800A3087', JSON.stringify(wahl.qrEinmal));
    ok('… auch der zweite echte Hersteller-QR', wahl.qrZweimal === 'https://qr.fischer.id/p/568010', JSON.stringify(wahl.qrZweimal));
    ok('… und ein QR schlägt eine EAN daneben im Bild',
      wahl.qrGegenEan === 'https://id.abb/2CKA006800A3087', JSON.stringify(wahl.qrGegenEan));

    console.log('\n── Plausibilität: was gar nicht erst gezählt wird ──');
    // Im Buecherregal las der Pruefstand ZWOELF achtstellige ITF-Codes, neun davon mit „00"
    // beginnend — auf Gegenstaenden, die garantiert kein ITF tragen. Neun davon wurden 9- bis
    // 16-mal gelesen: Gegen eine STABILE Fehllesung hilft Wiederholung nicht.
    const plaus = await seite.evaluate(() => ({
      itfAcht:      scannerPlausibel('00041285', 'itf'),
      itfVierzehn:  scannerPlausibel('00012345678905', 'itf'),
      ean13:        scannerPlausibel('4011395319475', 'EAN_13'),
      ean13Kurz:    scannerPlausibel('401139531947', 'EAN_13'),
      ean8:         scannerPlausibel('23198982', 'EAN_8'),
      upcA:         scannerPlausibel('043899923098', 'upc_a'),
      code39Kurz:   scannerPlausibel('S', 'CODE_39'),
      code128:      scannerPlausibel('A2026052700123', 'code_128'),
      qr:           scannerPlausibel('https://id.abb/2CKA006800A3087', 'QR_CODE'),
    }));
    ok('achtstelliges ITF wird gar nicht erst gezählt', plaus.itfAcht === false, JSON.stringify(plaus));
    ok('… ITF-14 dagegen schon (Karton-Standard)', plaus.itfVierzehn === true, JSON.stringify(plaus));
    ok('… ein einzelner Buchstabe als Code-39 auch nicht', plaus.code39Kurz === false, JSON.stringify(plaus));
    ok('… ein zu kurzes EAN-13 ebenfalls nicht', plaus.ean13Kurz === false, JSON.stringify(plaus));
    ok('echte Codes bleiben unangetastet',
      plaus.ean13 && plaus.ean8 && plaus.upcA && plaus.code128 && plaus.qr, JSON.stringify(plaus));

    console.log('\n── Bekannter Code wird eingesetzt ──');
    await seite.click('#order-add-btn'); await sleep(500);
    ok('der Scan-Knopf ist da', await seite.$('#of-scan') !== null);
    await scanVorgeben('4050821808435');
    await seite.click('#of-scan'); await sleep(1200);
    const eingesetzt = await seite.evaluate(() => ({
      produkt: document.getElementById('of-product').value,
      einheit: document.getElementById('of-unit').value,
      kat: document.getElementById('of-kategorie') ? document.getElementById('of-kategorie').value : null,
      id: document.getElementById('of-product').dataset.produktId || null,
    }));
    ok('das Produkt steht im Feld', eingesetzt.produkt === 'Kabelbinder 200 mm', JSON.stringify(eingesetzt));
    ok('… die Einheit ist vorbelegt', eingesetzt.einheit === 'Beutel', JSON.stringify(eingesetzt));
    ok('… die Kategorie auch', eingesetzt.kat === String(kat.id), JSON.stringify(eingesetzt));
    ok('… und die Verknüpfung ist gemerkt', eingesetzt.id === String(bekannt.id), JSON.stringify(eingesetzt));

    console.log('\n── Unbekannter Code öffnet die Maske ──');
    await scanVorgeben('4046281411223');
    await seite.click('#of-scan'); await sleep(1200);
    ok('die Anlege-Maske erscheint', await seite.$('#np-name') !== null);
    const maske = await seite.evaluate(() => (document.querySelector('.modal') || document.body).innerText);
    ok('… sie nennt den Barcode', /4046281411223/.test(maske), maske.slice(0, 150));
    ok('… und bittet um Sorgfalt', /schon gibt|sucht mit/i.test(maske), maske.slice(0, 260));

    console.log('\n── Live-Abgleich bietet das bestehende Produkt an ──');
    await seite.type('#np-name', 'kabelbinder', { delay: 20 });
    await sleep(400);
    const aehnlich = await seite.evaluate(() => {
      const k = document.getElementById('np-aehnlich');
      return { sichtbar: k.style.display !== 'none',
               knoepfe: [...k.querySelectorAll('[data-anlernen]')].map(b => b.textContent.trim()) };
    });
    ok('das bestehende Produkt wird vorgeschlagen',
      aehnlich.sichtbar && aehnlich.knoepfe.includes('Kabelbinder 200 mm'), JSON.stringify(aehnlich));

    console.log('\n── Anlernen statt Doppel anlegen ──');
    await seite.evaluate(() => document.querySelector('[data-anlernen]').click());
    await sleep(1500);
    const nachher = await req('GET', '/api/products/barcode/4046281411223', tok);
    ok('der neue Code hängt am BESTEHENDEN Produkt',
      nachher.body.gefunden && nachher.body.produkt.id === bekannt.id, JSON.stringify(nachher.body.produkt && nachher.body.produkt.id));
    ok('… das Produkt hat jetzt zwei Codes',
      nachher.body.produkt.barcodes.length === 2, JSON.stringify(nachher.body.produkt.barcodes));
    const katalog = await req('GET', '/api/products/katalog', tok);
    ok('… und es gibt KEIN zweites Produkt', katalog.body.produkte.length === 1,
      JSON.stringify(katalog.body.produkte.map(p => p.name)));

    console.log('\n── Wirklich neues Produkt anlegen ──');
    await scanVorgeben('4104640010552');
    await seite.click('#of-scan'); await sleep(1200);
    await seite.type('#np-name', 'Schrauben-Sortiment', { delay: 15 });
    await seite.evaluate(() => { document.getElementById('np-einheit').value = 'Koffer'; });
    await seite.evaluate(() => document.querySelector('[data-act="ok"]').click());
    await sleep(1800);
    const neu = await req('GET', '/api/products/barcode/4104640010552', tok);
    ok('das neue Produkt ist angelegt',
      neu.body.gefunden && neu.body.produkt.name === 'Schrauben-Sortiment', JSON.stringify(neu.body.produkt && neu.body.produkt.name));
    const imFeld = await seite.evaluate(() => document.getElementById('of-product').value);
    ok('… und steht gleich im Formular', imFeld === 'Schrauben-Sortiment', imFeld);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close(); srv.kill(); }

  console.log(`\nScanner im Formular: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
