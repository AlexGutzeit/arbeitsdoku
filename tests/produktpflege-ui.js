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
    const lg1 = (await req('POST', '/api/users', admin, { username: 'lagerist', password: PW, name: 'Lena Lagerist', role: 'mitarbeiter', target_hours_per_week: 40, can_order: true, can_products_add: true })).body.user;
    const lagerTok = (await req('POST', '/api/auth/login', null, { username: 'lagerist', password: PW })).body.token;
    // Ein Monteur, der Material ANFORDERT, aber keine Bestellungen abschliesst — die Mehrheit.
    await req('POST', '/api/users', admin, { username: 'monteur', password: PW, name: 'Mia Monteurin',
      role: 'mitarbeiter', target_hours_per_week: 40 });
    const monteurTok = (await req('POST', '/api/auth/login', null, { username: 'monteur', password: PW })).body.token;

    // Ausgangslage: ein Katalogprodukt, eine Bestellung darauf, ein Händler mit Angaben.
    const prod = (await req('POST', '/api/products', lagerTok, { name: 'Kabelbinder 200 mm', barcode: '4001111111111' })).body.produkt;
    await req('POST', '/api/orders', lagerTok, { product: 'Kabelbinder 200 mm', quantity: 5, product_id: prod.id });
    await req('POST', '/api/orders', lagerTok, { product: '2 Rollen Klebeband', quantity: 2 });
    // Ein zweites Produkt, das dem Händler NICHT zugeordnet ist — es muss über die Suche kommen.
    // Es entsteht VOR dem ersten Aufbau der Seite: Die Verzeichnis-Ansicht baut sich bei fremden
    // Änderungen mit Absicht nicht neu auf (sie ist voller Eingabefelder), sondern blendet nur
    // einen Hinweis ein. Ein später angelegtes Produkt wäre also zu Recht noch nicht in der Liste.
    const zweit = (await req('POST', '/api/products', admin,
      { name: 'Aderendhülse 2,5', barcode: '4003333333333' })).body.produkt;
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
    // target="_blank" ist das, was den Link aus der App HINAUS fuehrt: in der installierten App
    // uebernimmt der Browser des Geraets, die Arbeitsdoku bleibt im Hintergrund stehen. Ohne das
    // waere der Webshop IN der App geoeffnet worden — mit der Anmeldung daneben und ohne Weg
    // zurueck ausser neu laden (Alex, 14.09.2026: „öffnen sich dann im Standardbrowser?").
    ok('… und mit target="_blank" — der Webshop öffnet ausserhalb der App',
      link && link.target === '_blank', JSON.stringify(link && link.target));
    ok('… und die Domain steht sichtbar daneben', link && /shop\.sonepar\.de/.test(link.text), JSON.stringify(link && link.text));
    ok('ohne Pflegerecht KEIN Bearbeiten-Knopf',
      !(await l.seite.evaluate(() => !!document.querySelector('.order-hnd a[href^="#/produkte/"]'))));

    // ── Wer sieht die Großhändler-Angaben? ───────────────────────────────────────────────────
    //
    // Alex am 14.09.2026: „ist nur für Bestellberechtigte zu sehen oder für alle?" Antwort: nur
    // mit dem Recht „Bestellungen abschliessen". Wer bloss Material anfordert, braucht Kunden-
    // und Bestellnummer des Großhändlers nicht — und sie sind Geschäftsdaten.
    //
    // Geprüft wird BEIDES: dass der Knopf fehlt UND dass der Server die Daten verweigert. Eine
    // nur ausgeblendete Anzeige ist kein Schutz; die Abfrage steht jedem offen, der sie kennt.
    console.log('\n── Ohne Bestellrecht bleiben die Händler-Angaben zu ──');
    const m = await anmelden(browser, 'monteur', PW);
    m.seite.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    await m.seite.goto(BASIS + '/#/orders', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    ok('die Bestellseite ist da (anfordern darf jeder)',
      await m.seite.evaluate(() => !!document.getElementById('order-add-btn')));
    ok('… aber KEIN Großhändler-Knopf', !(await sichtbar(m.seite, '.order-hnd-btn')),
      await m.seite.evaluate(() => document.querySelectorAll('.order-hnd-btn').length));
    const verweigert = await req('GET', `/api/products/${prod.id}/haendler`, monteurTok);
    ok('… und der Server verweigert die Angaben auch direkt', verweigert.status === 403,
      verweigert.status + ' ' + verweigert.text.slice(0, 80));
    await m.seite.close(); await m.ktx.close();

    console.log('\n── Mit dem Recht: Menüpunkt, Sprung, Pflege ──');
    await req('PUT', `/api/users/${lg1.id}`, admin, { can_products_edit: true });
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

    console.log('\n── Von Hand anlegen, ohne zu scannen ──');
    // Alex (14.09.2026): „könnte ich im Katalog auch komplett wie im Supermarkt die Artikel mit
    // ihren Nummern anlegen?" Vorher ging das nur über eine Händlerkarte — im Reiter „Produkte"
    // gab es keinen Knopf.
    ok('im Reiter „Produkte" gibt es einen Anlegen-Knopf', await sichtbar(l.seite, '#pv-neu'));
    await l.seite.click('#pv-neu');
    await l.seite.waitForSelector('#pnp-name');
    await l.seite.type('#pnp-name', 'Aufputzdose 1-fach');
    await l.seite.type('#pnp-hersteller', 'OBO Bettermann');
    await l.seite.type('#pnp-code', '4062679000015');
    await sleep(250);
    ok('… die Prüfziffer wird beim Tippen nachgerechnet',
      /Prüfziffer stimmt/.test(await l.seite.evaluate(() => document.getElementById('pnp-pruef').textContent)),
      await l.seite.evaluate(() => document.getElementById('pnp-pruef').textContent));
    // Gegenprobe: eine Ziffer verdreht — die Bestätigung muss verschwinden.
    await l.seite.evaluate(() => {
      const f = document.getElementById('pnp-code');
      f.value = '4062679000016';
      f.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    ok('… und meldet sich, sobald eine Ziffer nicht stimmt',
      /Keine gültige/.test(await l.seite.evaluate(() => document.getElementById('pnp-pruef').textContent)),
      await l.seite.evaluate(() => document.getElementById('pnp-pruef').textContent));
    await l.seite.evaluate(() => {
      const f = document.getElementById('pnp-code');
      f.value = '4062679000015';
      f.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await l.seite.click('.dialog-modal [data-act="ok"]');
    await sleep(2200);
    const vonHand = (await req('GET', '/api/products/verzeichnis', admin)).body.produkte
      .find(p => p.name === 'Aufputzdose 1-fach');
    ok('das Produkt ist da — ohne Großhändler, ohne Scanner',
      !!vonHand && vonHand.hersteller === 'OBO Bettermann'
      && (vonHand.barcodes || []).includes('4062679000015'), JSON.stringify(vonHand));

    // ── Neue Kategorie mitten im Anlegen ─────────────────────────────────────────────────────
    //
    // Alex (15.09.2026): „Beim manuellen Produkt anlegen gibt es keinen '+ neue Kategorie
    // anlegen' Button." Die Scan-Maske hatte ihn, dieser Dialog nicht — und er ist modal: ohne
    // die Auswahl müsste man abbrechen, im Reiter eine Kategorie anlegen und von vorn beginnen.
    console.log('\n── Neue Kategorie direkt im Anlege-Dialog ──');
    await l.seite.click('#pv-neu');
    await l.seite.waitForSelector('#pnp-name');
    ok('die Auswahl bietet „neue Kategorie anlegen" an',
      await l.seite.evaluate(() => [...document.querySelectorAll('#pnp-kat option')]
        .some(o => o.value === '__neu')));
    ok('… das Namensfeld ist zunächst verborgen',
      !(await sichtbar(l.seite, '#pnp-katneu-feld')));
    await l.seite.evaluate(() => {
      const k = document.getElementById('pnp-kat');
      k.value = '__neu'; k.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(300);
    ok('… und erscheint, sobald man sie wählt', await sichtbar(l.seite, '#pnp-katneu-feld'));
    // Gegenprobe: ohne Namen darf nichts entstehen — weder Kategorie noch Produkt.
    await l.seite.type('#pnp-name', 'Dübel 8 mm');
    await l.seite.click('.dialog-modal [data-act="ok"]');
    await sleep(900);
    ok('… ohne Kategorienamen wird abgewiesen',
      /Namen für die neue Kategorie/.test(
        await l.seite.evaluate(() => document.getElementById('pnp-fehler').textContent)),
      await l.seite.evaluate(() => document.getElementById('pnp-fehler').textContent));
    const vorher = (await req('GET', '/api/products/verzeichnis', admin)).body;
    ok('… und es ist WIRKLICH nichts entstanden',
      !vorher.produkte.some(p => p.name === 'Dübel 8 mm') && !vorher.kategorien.some(k => k.name === 'Montage'),
      JSON.stringify({ k: vorher.kategorien.map(k => k.name) }));

    await l.seite.type('#pnp-katname', 'Montage');
    await l.seite.click('.dialog-modal [data-act="ok"]');
    await sleep(2200);
    const nachher = (await req('GET', '/api/products/verzeichnis', admin)).body;
    const neueKat = nachher.kategorien.find(k => k.name === 'Montage');
    const neuesProd = nachher.produkte.find(p => p.name === 'Dübel 8 mm');
    ok('die Kategorie ist angelegt', !!neueKat, JSON.stringify(nachher.kategorien.map(k => k.name)));
    ok('… und das Produkt hängt daran',
      !!neuesProd && neueKat && neuesProd.category_id === neueKat.id, JSON.stringify(neuesProd));

    console.log('\n── Hersteller pflegen ──');
    await l.seite.evaluate(id => { document.querySelector(`.pv-produkt[data-id="${id}"]`).open = true; }, prod.id);
    await l.seite.waitForSelector('.pv-f-hersteller');
    ok('das Feld hat eine Vorschlagsliste (gegen ABB/abb/A.B.B.)',
      await l.seite.evaluate(() => document.querySelector('.pv-f-hersteller').getAttribute('list') === 'pv-hersteller-liste'
        && !!document.getElementById('pv-hersteller-liste')));
    await l.seite.evaluate(() => { document.querySelector('.pv-f-hersteller').value = 'OBO Bettermann'; });
    await l.seite.click('.pv-speichern');
    await sleep(1800);
    const mitH = (await req('GET', '/api/products/verzeichnis', admin)).body.produkte.find(p => p.id === prod.id);
    ok('der Hersteller ist gespeichert', mitH.hersteller === 'OBO Bettermann', JSON.stringify(mitH.hersteller));
    ok('… und steht in der Liste', /OBO Bettermann/.test(
      await l.seite.evaluate(id => document.querySelector(`.pv-produkt[data-id="${id}"] summary`).innerText, prod.id)),
      await l.seite.evaluate(id => document.querySelector(`.pv-produkt[data-id="${id}"] summary`).innerText, prod.id));
    ok('… und die Suche im Verzeichnis findet ihn',
      await l.seite.evaluate(id => document.querySelector(`.pv-produkt[data-id="${id}"]`).dataset.suchtext.includes('obo'), prod.id),
      await l.seite.evaluate(id => document.querySelector(`.pv-produkt[data-id="${id}"]`).dataset.suchtext, prod.id));

    // ── Der Papierkorb zählt beides und kann endgültig löschen ───────────────────────────────
    //
    // Alex (15.09.2026): „Im Reiter Gelöscht werden nur Produkte gezählt, aber keine Großhändler."
    // Und: „Im Gelöscht-Unterpunkt hätte ich gerne die Möglichkeit, einen Eintrag endgültig zu
    // löschen."
    console.log('\n── Papierkorb: Zählung und endgültiges Löschen ──');
    const wegH = (await req('POST', '/api/suppliers', admin, { name: 'Papierkorb-Händler' })).body.haendler;
    await req('DELETE', `/api/suppliers/${wegH.id}`, admin);
    const wegP = (await req('POST', '/api/products', admin,
      { name: 'Papierkorb-Produkt', barcode: '4062679500026' })).body.produkt;
    await req('DELETE', `/api/products/${wegP.id}`, admin);
    await l.seite.evaluate(() => renderProdukte());
    await sleep(2200);
    const zaehler = await l.seite.evaluate(() =>
      [...document.querySelectorAll('#pv-tabs .pv-tab-btn')].find(x => /Gelöscht/.test(x.textContent)).textContent);
    ok('der Reiter zählt Produkte UND Großhändler', /Gelöscht \(2\)/.test(zaehler), zaehler);

    await l.seite.evaluate(() => {
      const b = [...document.querySelectorAll('#pv-tabs .pv-tab-btn')].find(x => /Gelöscht/.test(x.textContent));
      b.click();
    });
    await sleep(600);
    ok('… und bietet „Endgültig löschen" an',
      await l.seite.evaluate(() => document.querySelectorAll('.pv-purge, .pv-h-purge').length === 2),
      await l.seite.evaluate(() => document.querySelectorAll('.pv-purge, .pv-h-purge').length));

    // Gegenprobe zuerst: Abbrechen darf nichts tun.
    await l.seite.evaluate((id) => document.querySelector(`.pv-purge[data-id="${id}"]`).click(), wegP.id);
    await sleep(700);
    const warnung = await l.seite.evaluate(() => (document.querySelector('.modal') || {}).innerText || '');
    ok('… mit Warnung, dass Bestellungen ihren Text behalten',
      /Text/.test(warnung) && /Verknüpfung/.test(warnung), warnung.slice(0, 180));
    await l.seite.evaluate(() => {
      [...document.querySelectorAll('.modal button')].find(x => /Abbrechen/i.test(x.textContent)).click();
    });
    await sleep(1000);
    ok('… Abbrechen löscht NICHT',
      (await req('GET', '/api/products/verzeichnis', admin)).body.geloescht.some(p => p.id === wegP.id));

    await l.seite.evaluate((id) => document.querySelector(`.pv-purge[data-id="${id}"]`).click(), wegP.id);
    await sleep(700);
    await l.seite.evaluate(() => {
      [...document.querySelectorAll('.modal button')].find(x => /Endgültig löschen/i.test(x.textContent)).click();
    });
    await sleep(2200);
    const danachV = (await req('GET', '/api/products/verzeichnis', admin)).body;
    ok('… mit Bestätigung ist das Produkt endgültig fort',
      !danachV.geloescht.some(p => p.id === wegP.id) && !danachV.produkte.some(p => p.id === wegP.id));
    ok('… der Großhändler liegt noch im Papierkorb',
      danachV.geloeschteHaendler.some(h => h.id === wegH.id));

    console.log('\n── Der Reiter „Großhändler" ──');
    await l.seite.evaluate(() => document.querySelectorAll('#pv-tabs .pv-tab-btn')[1].click());
    await sleep(600);
    ok('der Reiter zeigt den Händler', await sichtbar(l.seite, '.pv-haendler'));
    ok('… mit der Zahl der Produkte',
      /1 Produkt/.test(await l.seite.evaluate(() => document.querySelector('.pv-haendler summary').innerText)),
      await l.seite.evaluate(() => document.querySelector('.pv-haendler summary').innerText));

    // ── Nach dem Speichern bleibt man, wo man war ────────────────────────────────────────────
    //
    // Alex (15.09.2026): „Wenn ich im Unterpunkt Großhändler auf Speichern drücke, springt die
    // Ansicht sofort wieder auf Produkte, so dass ich beim Bearbeiten immer wieder hin und her
    // hüpfen muss." Jede Händler-Aktion baut die Seite neu auf — dabei ging der Reiter verloren.
    console.log('\n── Speichern wirft einen nicht aus dem Reiter ──');
    const reiterName = () => l.seite.evaluate(() =>
      (document.querySelector('#pv-tabs .pv-tab-btn.active') || {}).dataset?.tab || null);
    await l.seite.evaluate(() => {
      const b = [...document.querySelectorAll('#pv-tabs .pv-tab-btn')].find(x => /händler/i.test(x.textContent));
      b.click();
    });
    await sleep(500);
    await l.seite.evaluate(() => { document.querySelector('.pv-haendler').open = true; });
    await sleep(900);
    ok('wir stehen im Reiter „Großhändler"', (await reiterName()) === 'haendler', await reiterName());
    await l.seite.evaluate(() => {
      const k = document.querySelector('.pv-haendler');
      k.querySelector('.pv-hf-ansprechpartner').value = 'Herr Wagner';
      k.querySelector('.pv-h-save').click();
    });
    await sleep(2200);
    ok('nach dem Speichern immer noch im Reiter „Großhändler"',
      (await reiterName()) === 'haendler', await reiterName());
    ok('… und die bearbeitete Karte ist noch offen',
      await l.seite.evaluate(() => !!document.querySelector('.pv-haendler[open]')));
    ok('… gespeichert wurde auch wirklich',
      (await req('GET', '/api/suppliers', admin)).body.haendler.some(h => h.ansprechpartner === 'Herr Wagner'),
      JSON.stringify((await req('GET', '/api/suppliers', admin)).body.haendler.map(h => h.ansprechpartner)));

    // ── Löschen fragt nach ───────────────────────────────────────────────────────────────────
    //
    // Alex (15.09.2026): „Wenn ich auf Großhändler löschen klicke, hätte ich gerne eine
    // Sicherheitsabfrage." Bisher fragte nur der SERVER zurück, und auch nur dann, wenn Produkte
    // daranhingen — ein Händler ohne Zuordnungen verschwand auf einen Klick. Der rote Knopf sitzt
    // direkt neben „Speichern".
    console.log('\n── Löschen fragt nach ──');
    const hAnzahl = async () => (await req('GET', '/api/suppliers', admin)).body.haendler.length;
    const vorLoeschen = await hAnzahl();
    const wegwerf = (await req('POST', '/api/suppliers', admin, { name: 'Testhändler zum Löschen' })).body.haendler;
    await l.seite.evaluate(() => renderProdukte());
    await sleep(2000);
    await l.seite.evaluate((id) => {
      document.querySelector(`.pv-haendler[data-id="${id}"] .pv-h-del`).click();
    }, wegwerf.id);
    await sleep(700);
    const frage = await l.seite.evaluate(() => (document.querySelector('.modal') || {}).innerText || '');
    ok('eine Rückfrage erscheint', /löschen\?/i.test(frage), frage.slice(0, 140));
    ok('… sie nennt den Namen', /Testhändler zum Löschen/.test(frage), frage.slice(0, 140));
    ok('… und sagt, dass es einen Weg zurück gibt', /Gelöscht|Wiederherstell/i.test(frage), frage.slice(0, 200));
    // ABBRECHEN muss wirklich nichts tun — die wichtigere Hälfte.
    await l.seite.evaluate(() => {
      const b = [...document.querySelectorAll('.modal button')].find(x => /Abbrechen/i.test(x.textContent));
      b.click();
    });
    await sleep(1200);
    ok('Abbrechen löscht NICHT', (await hAnzahl()) === vorLoeschen + 1, String(await hAnzahl()));
    // Und mit Bestätigung verschwindet er.
    await l.seite.evaluate((id) => {
      document.querySelector(`.pv-haendler[data-id="${id}"] .pv-h-del`).click();
    }, wegwerf.id);
    await sleep(700);
    await l.seite.evaluate(() => {
      const b = [...document.querySelectorAll('.modal button')].find(x => /^Löschen$/i.test(x.textContent.trim()));
      b.click();
    });
    await sleep(2000);
    ok('… mit Bestätigung schon', (await hAnzahl()) === vorLoeschen, String(await hAnzahl()));

    console.log('\n── Die Gegenrichtung: vom Händler aus zuordnen ──');
    await l.seite.evaluate(() => { document.querySelector('.pv-haendler').open = true; });
    await l.seite.waitForSelector('.pv-hp-suche');
    await sleep(800);
    ok('die Händlerkarte listet sein Produkt',
      await l.seite.evaluate(() => document.querySelectorAll('.pv-hp-zeile').length === 1),
      await l.seite.evaluate(() => document.querySelectorAll('.pv-hp-zeile').length));

    await l.seite.type('.pv-hp-suche', 'aderend');
    await sleep(500);
    ok('die Suche findet das noch nicht zugeordnete Produkt',
      await sichtbar(l.seite, '.pv-hp-treffer-zeile'),
      await l.seite.evaluate(() => document.querySelector('.pv-hp-treffer').innerHTML.slice(0, 120)));
    // Gegenprobe: Das SCHON zugeordnete Produkt darf nicht auftauchen — ein Treffer, der beim
    // Klicken nichts bewirkt, ist schlimmer als keiner.
    await l.seite.evaluate(() => { const f = document.querySelector('.pv-hp-suche'); f.value = 'kabelbinder';
      f.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(400);
    ok('… und bietet das bereits zugeordnete NICHT noch einmal an',
      !(await sichtbar(l.seite, '.pv-hp-treffer-zeile')),
      await l.seite.evaluate(() => document.querySelector('.pv-hp-treffer').innerHTML.slice(0, 120)));

    await l.seite.evaluate(() => { const f = document.querySelector('.pv-hp-suche'); f.value = 'aderend';
      f.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(400);
    await l.seite.click('.pv-hp-treffer-zeile');
    await sleep(1500);
    const nachAnhaengen = (await req('GET', `/api/suppliers/${haendler.id}/produkte`, admin)).body.produkte;
    ok('der Klick hängt es wirklich an', nachAnhaengen.some(x => x.id === zweit.id),
      JSON.stringify(nachAnhaengen.map(x => x.name)));

    // Bestellnummer und Kommentar an der neuen Zeile — der Kommentar prüft, dass Speichern die
    // Felder nicht gegenseitig leert.
    await l.seite.evaluate(id => {
      const z = document.querySelector(`.pv-hp-zeile[data-pid="${id}"]`);
      z.querySelector('.pv-hp-nr').value = 'AE25';
      z.querySelector('.pv-hp-kommentar').value = 'nur im 100er-Beutel';
      z.querySelector('.pv-hp-save').click();
    }, zweit.id);
    await sleep(1500);
    const gespeichert = (await req('GET', `/api/suppliers/${haendler.id}/produkte`, admin))
      .body.produkte.find(x => x.id === zweit.id);
    ok('Bestellnummer und Kommentar stehen beide',
      gespeichert.bestellnummer === 'AE25' && gespeichert.kommentar === 'nur im 100er-Beutel',
      JSON.stringify(gespeichert));

    console.log('\n── Ein Produkt OHNE Barcode, direkt am Händler ──');
    await l.seite.click('.pv-hp-neu');
    await l.seite.waitForSelector('#pnp-name');
    await l.seite.type('#pnp-name', 'Erdungsband 30x3');
    await l.seite.click('.dialog-modal [data-act="ok"]');
    await sleep(2000);
    const ohneCode = (await req('GET', '/api/products?q=erdungsband', admin)).body.produkte[0];
    ok('es entsteht ohne Barcode', !!ohneCode, JSON.stringify(ohneCode));
    const amHaendler = (await req('GET', `/api/suppliers/${haendler.id}/produkte`, admin)).body.produkte;
    ok('… und hängt gleich am Händler', ohneCode && amHaendler.some(x => x.id === ohneCode.id),
      JSON.stringify(amHaendler.map(x => x.name)));
    const zeileText = await l.seite.evaluate(id => {
      const z = document.querySelector(`.pv-hp-zeile[data-pid="${id}"]`);
      return z ? z.innerText : null;
    }, ohneCode.id);
    ok('… seine Zeile am Händler ist als „ohne Barcode" gekennzeichnet',
      zeileText && /ohne Barcode/.test(zeileText), JSON.stringify(zeileText));
    // Und die Karte darf beim Anlegen NICHT zuklappen — sonst verliert man den Faden.
    ok('… die Händlerkarte bleibt dabei offen',
      await l.seite.evaluate(() => !!document.querySelector('.pv-haendler')?.open));

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
