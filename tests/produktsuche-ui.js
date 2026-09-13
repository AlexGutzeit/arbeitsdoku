// Die Live-Suche im Produktfeld — geklickt und getippt, nicht behauptet.
//
// Warum das mehr als Komfort ist: Weil jeder Mitarbeiter Produkte anlegen darf, entstehen Doppel
// („Kabelbinder", „kabelbinder", „kabel-binder"). Dagegen hilft kein Recht, sondern eine Suche,
// die beim Tippen so gut trifft, dass Anlegen die Ausnahme bleibt. Diese Suche IST die
// Qualitätssicherung des Verzeichnisses — deshalb wird sie hier Zeichen für Zeichen geprüft.
//
// Und die wichtigste Prüfung steht am Anfang: FREIER TEXT MUSS WEITER GEHEN. Der Katalog ist ein
// Angebot, keine Schranke.
//
//   node tests/produktsuche-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3306, DB = '/tmp/produktsuche-ui.db', LOG = '/tmp/produktsuche-ui-srv.log';
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

async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  seite.setDefaultTimeout(45000);
  await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await seite.waitForSelector('a[href="#/statistics"]'); await sleep(900);
  return { ktx, seite };
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
    const maxTok = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;
    const adminTok = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    // Seit 13.09.2026 braucht das Anlegen ein Recht (barcoderecht.js) — max ist hier der Lagerist.
    const maxId = (await req('GET', '/api/users', adminTok)).body.users.find(u => u.username === 'max').id;
    await req('PUT', `/api/users/${maxId}`, adminTok, { can_barcode: true });

    // Katalog vorbereiten
    const kElektro = (await req('POST', '/api/products/kategorien', maxTok, { name: 'Elektro' })).body.kategorie;
    const kBefest = (await req('POST', '/api/products/kategorien', maxTok, { name: 'Befestigung' })).body.kategorie;
    for (const [name, code, kat, einheit] of [
      ['Kabelbinder 200 mm', '4050821808435', kBefest.id, 'Beutel'],
      ['Kabelkanal 40×40',   '4050821027843', kElektro.id, 'Stück'],
      ['Aderendhülse 2,5',   '4046281411223', kElektro.id, 'Packung'],
      ['Schrauben-Sortiment','4104640010552', kBefest.id, 'Koffer'],
    ]) await req('POST', '/api/products', maxTok, { name, barcode: code, category_id: kat, default_unit: einheit });

    // ZWEI GLEICHNAMIGE von verschiedenen Herstellern — der Fall, für den Alex das Feld wollte.
    // Wenn die Vorschlagsliste sie nicht unterscheidet, ist das Feld wertlos: Man bestellt dann
    // aufs Geratewohl einen der beiden.
    for (const [h, code] of [['OBO Bettermann', '4062679000015'], ['HellermannTyton', '4062679000022']])
      await req('POST', '/api/products', maxTok,
        { name: 'Schelle 16 mm', barcode: code, category_id: kBefest.id, hersteller: h });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];
    const m = await anmelden(browser, 'max', pw('max'));
    m.seite.on('pageerror', e => jsFehler.push(e.message));

    await m.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await m.seite.waitForSelector('#order-add-btn'); await sleep(900);
    await m.seite.click('#order-add-btn'); await sleep(700);

    console.log('── FREIER TEXT MUSS WEITER GEHEN ──');
    await m.seite.type('#of-product', 'Irgendwas ganz Neues');
    await m.seite.evaluate(() => { document.getElementById('of-qty').value = '3'; });
    await m.seite.evaluate(() => document.querySelector('#order-form button[type="submit"]').click());
    // VORHER zählen statt eine feste Zahl hinzuschreiben: Sonst bricht diese Zusicherung jedes
    // Mal, wenn oben ein Testprodukt dazukommt — und man gewöhnt sich an, sie anzupassen, statt
    // sie zu lesen. Gemessen wird die Veränderung, und die soll null sein.
    const vorher = (await req('GET', '/api/products/katalog', maxTok)).body.produkte.length;
    await sleep(1800);
    const frei = await req('GET', '/api/orders', maxTok);
    ok('eine getippte Bestellung geht wie immer',
      frei.body.orders.some(o => o.product === 'Irgendwas ganz Neues'),
      JSON.stringify(frei.body.orders.map(o => o.product)));
    const katalogDanach = await req('GET', '/api/products/katalog', maxTok);
    ok('… und legt NICHTS im Verzeichnis an', katalogDanach.body.produkte.length === vorher,
      String(katalogDanach.body.produkte.length));

    console.log('\n── Live-Suche, Zeichen für Zeichen ──');
    await m.seite.click('#order-add-btn'); await sleep(700);
    const tippenUndZaehlen = async (text) => {
      await m.seite.evaluate(() => { const f = document.getElementById('of-product'); f.value = ''; });
      for (const z of text) {
        await m.seite.type('#of-product', z, { delay: 10 });
      }
      await sleep(250);
      return m.seite.evaluate(() => {
        const l = document.getElementById('of-vorschlaege');
        // Nur zaehlen, was auch SICHTBAR ist. Eine versteckte Liste mit alten Eintraegen waere
        // ein Fehler — und war einer: Sie wurde versteckt, aber nicht geleert.
        const sichtbar = l.style.display !== 'none';
        return { sichtbar,
                 namen: sichtbar ? [...l.querySelectorAll('li')].map(li => li.dataset.name) : [] };
      });
    };
    for (const [text, erwartet] of [['kabel', 2], ['kabelb', 1], ['KABELBINDER', 1], ['kabel-binder', 1], ['hülse', 1], ['zzz', 0]]) {
      const r = await tippenUndZaehlen(text);
      ok(`„${text}" → ${erwartet} Vorschläge`, r.namen.length === erwartet, JSON.stringify(r.namen));
    }

    console.log('\n── Kategorie filtert mit ──');
    await m.seite.evaluate(() => { document.getElementById('of-product').value = ''; });
    await m.seite.select('#of-kategorie', String(kElektro.id));
    await sleep(400);
    const nurElektro = await m.seite.evaluate(() => {
      const l = document.getElementById('of-vorschlaege');
      return [...l.querySelectorAll('li')].map(li => li.dataset.name);
    });
    ok('Kategorie „Elektro" zeigt nur ihre zwei', nurElektro.length === 2, JSON.stringify(nurElektro));
    ok('… und der Kabelbinder ist nicht dabei', !nurElektro.some(n => /Kabelbinder/.test(n)), JSON.stringify(nurElektro));

    console.log('\n── Auswählen füllt Feld und Einheit ──');
    await m.seite.select('#of-kategorie', '');
    await m.seite.evaluate(() => { const f = document.getElementById('of-product'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    await m.seite.type('#of-product', 'aderend', { delay: 15 });
    await sleep(350);
    await m.seite.evaluate(() => document.querySelector('#of-vorschlaege li').click());
    await sleep(300);
    const gefuellt = await m.seite.evaluate(() => ({
      produkt: document.getElementById('of-product').value,
      einheit: document.getElementById('of-unit').value,
      id: document.getElementById('of-product').dataset.produktId || null,
      listeZu: document.getElementById('of-vorschlaege').style.display === 'none',
    }));
    ok('das Produkt steht im Feld', gefuellt.produkt === 'Aderendhülse 2,5', JSON.stringify(gefuellt));
    ok('… die Einheit ist vorbelegt', gefuellt.einheit === 'Packung', JSON.stringify(gefuellt));
    ok('… die Verknüpfung ist gemerkt', !!gefuellt.id, JSON.stringify(gefuellt));
    ok('… und die Liste ist zu', gefuellt.listeZu, JSON.stringify(gefuellt));

    console.log('\n── Weitertippen löst die Verknüpfung ──');
    await m.seite.type('#of-product', ' XL', { delay: 15 });
    await sleep(250);
    const gelöst = await m.seite.evaluate(() => document.getElementById('of-product').dataset.produktId || null);
    ok('nach dem Weitertippen ist die Verknüpfung weg', gelöst === null, String(gelöst));

    console.log('\n── Zwei gleichnamige Artikel, zwei Hersteller ──');
    await m.seite.evaluate(() => { const f = document.getElementById('of-product'); f.value = ''; f.focus(); });
    await m.seite.type('#of-product', 'schelle', { delay: 15 });
    await sleep(350);
    const zwei = await m.seite.evaluate(() => [...document.querySelectorAll('#of-vorschlaege li')]
      .map(li => li.innerText.replace(/\s+/g, ' ').trim()));
    ok('beide erscheinen in der Vorschlagsliste', zwei.length === 2, JSON.stringify(zwei));
    ok('… und sind am Hersteller zu unterscheiden',
      zwei.some(t => /OBO/.test(t)) && zwei.some(t => /HellermannTyton/.test(t)), JSON.stringify(zwei));

    // Und der Hersteller ist selbst ein Suchbegriff — im Lager weiss man oft die Marke, nicht den
    // genauen Artikelnamen.
    await m.seite.evaluate(() => { const f = document.getElementById('of-product'); f.value = ''; f.focus(); });
    await m.seite.type('#of-product', 'hellermann', { delay: 15 });
    await sleep(350);
    const ueberMarke = await m.seite.evaluate(() => [...document.querySelectorAll('#of-vorschlaege li')]
      .map(li => li.innerText.replace(/\s+/g, ' ').trim()));
    ok('die Suche nach der Marke findet den Artikel',
      ueberMarke.length === 1 && /Schelle 16 mm/.test(ueberMarke[0]), JSON.stringify(ueberMarke));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close(); srv.kill(); }

  console.log(`\nProduktsuche (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
