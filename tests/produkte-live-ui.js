// Wächst das Verzeichnis live mit? (Alex, 09.09.2026)
//
// „Wenn MA a am PC sitzt und Produkt Datenbank bearbeiten offen hat und in diesem Moment MA b
// einen Artikel einlernt, kann dann MA a live die Datenbank wachsen sehen?"
//
// Die Antwort war zunächst NEIN: Der Server sendet bei jeder Änderung ein Signal (16 Stellen),
// im Frontend hörte niemand darauf. Dieser Test schreibt beide Hälften der Lösung fest — und die
// sind bewusst VERSCHIEDEN:
//
//  1. BESTELLUNGEN: Die Gerätekopie des Katalogs wird still nachgezogen. Kein Neuaufbau — die
//     Vorschlagsliste liest bei jedem Tastendruck neu, das Produkt ist also sofort da, ohne dass
//     jemandem das Formular unter den Fingern weggerissen wird.
//
//  2. VERZEICHNIS-PFLEGE: NICHT neu aufbauen, sondern ein Hinweisband zeigen. Die Seite besteht
//     fast nur aus Eingabefeldern; ein Neuaufbau vernichtete angefangene Arbeit — und zwar genau
//     dann, wenn zwei Leute gleichzeitig aufräumen, also im Ernstfall.
//
//   node tests/produkte-live-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3320, DB = '/tmp/produkte-live.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/produkte-live-srv.log';
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
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;

    // MA b arbeitet über die Schnittstelle — er steht ja im Lager am Handy.
    const PW = 'Lager!12345';
    const b = (await req('POST', '/api/users', admin, { username: 'lagerb', password: PW, name: 'Bea Lager', role: 'mitarbeiter', target_hours_per_week: 40, can_products: true })).body.user;
    const tokenB = (await req('POST', '/api/auth/login', null, { username: 'lagerb', password: PW })).body.token;
    await req('POST', '/api/products', admin, { name: 'Kabelbinder 200 mm', barcode: '4001111111111' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1200, height: 1000 });
    seite.setDefaultTimeout(30000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));

    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pwAdmin);
    await seite.click('#login-form button[type="submit"]');
    await sleep(2500);

    console.log('── MA a bestellt, MA b lernt gleichzeitig ein ──');
    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#order-add-btn'); await sleep(800);
    await seite.click('#order-add-btn');
    await seite.waitForSelector('#of-product');
    await seite.type('#of-product', 'Aderend');
    await sleep(600);
    const vorher = await seite.evaluate(() => {
      const ul = document.getElementById('of-vorschlaege');
      return { sichtbar: !!ul && ul.style.display !== 'none', text: ul ? ul.innerText : '' };
    });
    ok('vorher findet die Suche nichts', !vorher.sichtbar || !/Aderendhülse/.test(vorher.text), JSON.stringify(vorher));

    // MA b legt an — währenddessen bleibt MA a im Formular stehen.
    const neu = await req('POST', '/api/products', tokenB, { name: 'Aderendhülse 2,5', barcode: '4002222222222' });
    ok('MA b hat angelegt', neu.status === 201, neu.status + ' ' + neu.text.slice(0, 80));
    await sleep(2500);   // SSE + Nachladen

    ok('… MA a hat das Formular unverändert vor sich (nichts wurde neu aufgebaut)',
      await seite.evaluate(() => document.getElementById('of-product').value === 'Aderend'),
      await seite.evaluate(() => document.getElementById('of-product')?.value));
    // Ein weiterer Tastendruck: Die Liste liest S.produktKatalog neu.
    await seite.type('#of-product', 'h');
    await sleep(600);
    const nachher = await seite.evaluate(() => {
      const ul = document.getElementById('of-vorschlaege');
      return { sichtbar: !!ul && ul.style.display !== 'none', text: ul ? ul.innerText : '' };
    });
    ok('… und findet das neue Produkt OHNE Neuladen', nachher.sichtbar && /Aderendhülse/.test(nachher.text),
      JSON.stringify(nachher));

    console.log('\n── MA a pflegt das Verzeichnis, MA b ändert etwas ──');
    await seite.goto(BASIS + '/#/produkte', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('.pv-produkt'); await sleep(800);
    // MA a fängt an zu arbeiten: Produkt aufklappen und den Namen ändern — NICHT gespeichert.
    await seite.evaluate(() => { document.querySelector('.pv-produkt').open = true; });
    await seite.waitForSelector('.pv-f-name'); await sleep(600);
    await seite.evaluate(() => { const f = document.querySelector('.pv-f-name'); f.value = 'HALB GETIPPT'; f.dispatchEvent(new Event('input', { bubbles: true })); });
    await seite.evaluate(() => document.body.click());   // Fokus weg — der Text bleibt aber stehen

    const dritte = await req('POST', '/api/products', tokenB, { name: 'Isolierband schwarz', barcode: '4003333333333' });
    ok('MA b legt ein weiteres Produkt an', dritte.status === 201, String(dritte.status));
    await sleep(2500);

    ok('MA a bekommt einen Hinweis', await seite.evaluate(() => !!document.getElementById('pv-frisch')));
    ok('… der sagt, was los ist',
      /Kollege .*geändert/.test(await seite.evaluate(() => document.getElementById('pv-frisch')?.innerText || '')),
      await seite.evaluate(() => document.getElementById('pv-frisch')?.innerText));
    // DAS ist der Kern: Die angefangene Arbeit steht noch da.
    ok('… und seine angefangene Eingabe steht UNVERSEHRT da',
      await seite.evaluate(() => document.querySelector('.pv-f-name')?.value === 'HALB GETIPPT'),
      await seite.evaluate(() => document.querySelector('.pv-f-name')?.value));
    ok('… das neue Produkt ist noch NICHT in der Liste (bewusst)',
      !(await seite.evaluate(() => document.getElementById('pv-liste').innerText.includes('Isolierband'))));

    await seite.click('#pv-frisch-btn');
    await sleep(2000);
    ok('nach „Neu laden" ist es da',
      await seite.evaluate(() => document.getElementById('pv-liste').innerText.includes('Isolierband')));
    ok('… und der Hinweis ist weg', !(await seite.evaluate(() => !!document.getElementById('pv-frisch'))));

    console.log('\n── MA b scannt sofort, was MA a eben eingelernt hat ──');
    // Alex' Frage: „kann ma b sofort danach, ohne zu aktualisieren, sofort den code nutzen?"
    // Der Scan fragt den SERVER (GET /api/products/barcode/:code), nicht die Gerätekopie. Um das
    // zu BEWEISEN und nicht nur zu behaupten, wird die Kopie vorher absichtlich geleert: Findet
    // der Scan das Produkt trotzdem, kann es nur vom Server gekommen sein.
    await seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#order-add-btn'); await sleep(1000);
    const frisch = await req('POST', '/api/products', tokenB, { name: 'Wago-Klemme 221', barcode: '4004444444444' });
    ok('MA b legt an', frisch.status === 201, String(frisch.status));
    await seite.click('#order-add-btn'); await seite.waitForSelector('#of-product');
    await seite.evaluate(() => {
      S.produktKatalog = { kategorien: [], produkte: [] };     // Gerätekopie absichtlich leeren
      window.scannerOeffnen = async () => '4004444444444';
    });
    await seite.click('#of-scan'); await sleep(1500);
    ok('der eben angelegte Code wird sofort gefunden — auch mit leerer Gerätekopie',
      await seite.evaluate(() => document.getElementById('of-product').value === 'Wago-Klemme 221'),
      await seite.evaluate(() => document.getElementById('of-product')?.value));

    console.log('\n── MA a benennt um — MA b sieht es ohne Neuladen ──');
    // Alex' dritte Frage: „wenn der ma im bearbeiten etwas ändert, wird dass dann sofort zu ma a
    // und ma b im Lager synchronisiert?"
    const zuAendern = (await req('GET', '/api/products?q=wago', admin)).body.produkte[0];
    const umbenannt = await req('PUT', `/api/products/${zuAendern.id}`, admin,
      { name: 'Wago-Klemme 221 (5-polig)', trotzdem: true });
    ok('MA a benennt um', umbenannt.status === 200, umbenannt.status + ' ' + umbenannt.text.slice(0, 80));
    await sleep(2500);   // SSE
    await seite.evaluate(() => { const f = document.getElementById('of-product'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
    await seite.type('#of-product', 'wago');
    await sleep(700);
    const nachUmbenennen = await seite.evaluate(() => {
      const ul = document.getElementById('of-vorschlaege');
      return ul ? ul.innerText : '';
    });
    ok('MA b findet den NEUEN Namen, ohne neu zu laden',
      /5-polig/.test(nachUmbenennen), JSON.stringify(nachUmbenennen).slice(0, 120));

    console.log('\n── Nach einem Funkloch ──');
    // Verpasste Signale sind verloren. Beim Wiederverbinden muss der Katalog nachgezogen werden —
    // sonst haette, wer aus dem Funkloch kommt, eine Produktliste von vorhin.
    await seite.evaluate(() => { S.produktKatalog = { kategorien: [], produkte: [] }; });
    await seite.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(2000);
    ok('beim Zurückwechseln in die App wird der Katalog nachgezogen',
      await seite.evaluate(() => (S.produktKatalog.produkte || []).length > 0),
      await seite.evaluate(() => (S.produktKatalog.produkte || []).length));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nVerzeichnis live: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
