// Verzeichnis-Pflege und Großhändler, geklickt statt aufgerufen (Alex, 09.09.2026).
//
// Über die Schnittstelle stimmt alles (tests/produktpflege.js). Hier geht es um das, was bei
// diesem Projekt wiederholt danebenging: dass in der Oberfläche ein Knopf fehlt, obwohl der
// Server längst erlaubt — oder einer dasteht, der nichts tut.
//
// Drei Dinge werden hier wirklich geklickt und nicht nur behauptet:
//
//  1. Der Menüpunkt „Produktverzeichnis“ erscheint NUR mit dem Recht.
//  2. Der Großhändler-Ausklapper in den Bestellungen zeigt Bestellnummer und Link — und der Link
//     trägt `rel="noopener"`. Ohne das kann die Zielseite die App-Seite im Hintergrund auf eine
//     nachgebaute Anmeldemaske umleiten; man merkt es nicht, weil der Knopf ja funktioniert.
//  3. „Großhändler-Infos bearbeiten“ landet beim RICHTIGEN Produkt und klappt es auf.
//
//   node tests/produktpflege-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3308, DB = '/tmp/produktpflege-ui.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/produktpflege-ui-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  await seite.setViewport({ width: 1200, height: 1000 });
  seite.setDefaultTimeout(30000);
  await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await sleep(2500);
  return { ktx, seite };
}
const sichtbar = (seite, wahl) => seite.evaluate(w => {
  const el = document.querySelector(w);
  return !!el && el.checkVisibility();
}, wahl);

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

    const PW = 'Lagerist3!';
    const lg1 = (await req('POST', '/api/users', admin, { username: 'lagerist', password: PW, name: 'Lena Lagerist', role: 'mitarbeiter', target_hours_per_week: 40, can_order: true })).body.user;
    const lagerTok = (await req('POST', '/api/auth/login', null, { username: 'lagerist', password: PW })).body.token;

    // Ausgangslage: ein Katalogprodukt, eine Bestellung darauf, ein Händler mit Angaben.
    const prod = (await req('POST', '/api/products', lagerTok, { name: 'Kabelbinder 200 mm', barcode: '4001111111111' })).body.produkt;
    await req('POST', '/api/orders', lagerTok, { product: 'Kabelbinder 200 mm', quantity: 5, product_id: prod.id });
    await req('POST', '/api/orders', lagerTok, { product: '2 Rollen Klebeband', quantity: 2 });
    const haendler = (await req('POST', '/api/suppliers', admin, {
      name: 'Sonepar', homepage: 'shop.sonepar.de', kundennummer: '4711', ansprechpartner: 'Frau Meier' })).body.haendler;
    await req('PUT', `/api/products/${prod.id}/haendler/${haendler.id}`, admin, {
      bestellnummer: '88123', link: 'https://shop.sonepar.de/artikel/88123', kommentar: 'VPE 100' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];

    console.log('── Der Menüpunkt folgt dem Recht ──');
    let l = await anmelden(browser, 'lagerist', PW);
    l.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await l.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('ohne Pflegerecht kein Menüpunkt', !(await sichtbar(l.seite, 'a[href="#/produkte"]')));

    console.log('\n── Der Ausklapper in den Bestellungen ──');
    // Lena darf bestellen — also SIEHT sie die Angaben, obwohl sie nicht pflegen darf.
    ok('bei der Katalog-Bestellung steht ein Großhändler-Knopf', await sichtbar(l.seite, '.order-hnd-btn'));
    const anzahlKnoepfe = await l.seite.evaluate(() => document.querySelectorAll('.order-hnd-btn').length);
    ok('… und NUR dort (die frei getippte Bestellung hat keinen)', anzahlKnoepfe === 1, String(anzahlKnoepfe));
    await l.seite.click('.order-hnd-btn');
    await l.seite.waitForSelector('.order-hnd-eintrag');
    const inhalt = await l.seite.evaluate(() => document.querySelector('.order-hnd').innerText);
    ok('… die Bestellnummer steht da', /88123/.test(inhalt), inhalt.slice(0, 120));
    ok('… der Händler auch', /Sonepar/.test(inhalt), inhalt.slice(0, 120));
    ok('… und der Kommentar', /VPE 100/.test(inhalt), inhalt.slice(0, 120));
    ok('… samt Kundennummer', /4711/.test(inhalt), inhalt.slice(0, 160));
    const link = await l.seite.evaluate(() => {
      const a = document.querySelector('.order-hnd a[href^="http"]');
      return a ? { href: a.href, rel: a.rel, target: a.target, text: a.parentElement.innerText } : null;
    });
    ok('… der Link zeigt auf den Artikel', link && link.href === 'https://shop.sonepar.de/artikel/88123', JSON.stringify(link));
    ok('… mit rel="noopener" (sonst kann die Zielseite die App-Seite umleiten)',
      link && /noopener/.test(link.rel), JSON.stringify(link && link.rel));
    ok('… und die Domain steht sichtbar daneben', link && /shop\.sonepar\.de/.test(link.text), JSON.stringify(link && link.text));
    ok('ohne Pflegerecht KEIN Bearbeiten-Knopf',
      !(await l.seite.evaluate(() => !!document.querySelector('.order-hnd a[href^="#/produkte/"]'))));

    console.log('\n── Mit dem Recht: Menüpunkt, Sprung, Pflege ──');
    await req('PUT', `/api/users/${lg1.id}`, admin, { can_products: true });
    await l.seite.close(); await l.ktx.close();
    l = await anmelden(browser, 'lagerist', PW);
    l.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await l.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('jetzt ist der Menüpunkt da', await sichtbar(l.seite, 'a[href="#/produkte"]'));
    await l.seite.click('.order-hnd-btn');
    await l.seite.waitForSelector('.order-hnd a[href^="#/produkte/"]');
    ok('… und der Bearbeiten-Knopf zeigt auf DIESES Produkt',
      await l.seite.evaluate(id => document.querySelector('.order-hnd a[href^="#/produkte/"]').getAttribute('href') === '#/produkte/' + id, prod.id));
    await l.seite.click('.order-hnd a[href^="#/produkte/"]');
    await sleep(2500);
    ok('der Sprung landet im Verzeichnis', /#\/produkte\//.test(await l.seite.evaluate(() => location.hash)),
      await l.seite.evaluate(() => location.hash));
    ok('… und das Produkt ist aufgeklappt',
      await l.seite.evaluate(id => { const d = document.querySelector(`.pv-produkt[data-id="${id}"]`); return !!d && d.open; }, prod.id));
    await l.seite.waitForSelector('.pv-h-eintrag');
    ok('… seine Großhändler-Angaben stehen bereit',
      await l.seite.evaluate(() => document.querySelector('.pv-h-nr').value === '88123'),
      await l.seite.evaluate(() => document.querySelector('.pv-h-nr')?.value));

    console.log('\n── Pflegen ──');
    await l.seite.evaluate(() => { const f = document.querySelector('.pv-f-name'); f.value = 'Kabelbinder 200mm schwarz'; });
    await l.seite.click('.pv-speichern');
    await sleep(2000);
    const nachName = (await req('GET', '/api/products/verzeichnis', admin)).body.produkte.find(p => p.id === prod.id);
    ok('der neue Name ist gespeichert', nachName.name === 'Kabelbinder 200mm schwarz', nachName.name);

    await l.seite.evaluate(id => { document.querySelector(`.pv-produkt[data-id="${id}"]`).open = true; }, prod.id);
    await l.seite.waitForSelector('.pv-code-neu');
    await l.seite.type('.pv-code-neu', '4002222222222');
    await l.seite.click('.pv-code-add');
    await sleep(2000);
    const codes = (await req('GET', '/api/products/verzeichnis', admin)).body.produkte.find(p => p.id === prod.id).barcodes;
    ok('ein zweiter Barcode ist angelernt', codes.length === 2 && codes.includes('4002222222222'), JSON.stringify(codes));

    console.log('\n── Der Reiter „Großhändler" ──');
    await l.seite.evaluate(() => document.querySelectorAll('#pv-tabs .pv-tab-btn')[1].click());
    await sleep(600);
    ok('der Reiter zeigt den Händler', await sichtbar(l.seite, '.pv-haendler'));
    ok('… mit der Zahl der Produkte',
      /1 Produkt/.test(await l.seite.evaluate(() => document.querySelector('.pv-haendler summary').innerText)),
      await l.seite.evaluate(() => document.querySelector('.pv-haendler summary').innerText));

    ok('keine JavaScript-Fehler auf allen besuchten Seiten', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nVerzeichnis-Pflege (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
