// Produktverzeichnis: Kategorien, Produkte, Barcodes (1:n).
//
// Die Regel, an der alles hängt (Alex, 07.09.2026): In den Katalog kommt beim SCANNEN nur, was
// einen Barcode hat. Eine getippte Bestellung erzeugt keinen Eintrag.
//
// Seit 09.09.2026 gibt es dazu eine Ausnahme mit Absicht: Wer „Lagerdaten pflegen" darf, legt ein
// Produkt auch OHNE Barcode an — etwa beim Zuordnen zu einem Großhändler. Ein solches Produkt ist
// nicht scannbar, aber über die Suche bestellbar, und beim ersten Scannen lernt es seinen Code
// dazu. Der Schutz vor Wildwuchs sitzt damit am Recht, nicht mehr am Barcode-Zwang.
//
// Der gefährlichste Fehler wäre nicht ein kaputter Katalog, sondern eine BESTELLSTRECKE, die
// vorher ging und jetzt hakt. Deshalb steht die Nullprobe am Anfang: ohne einen einzigen
// Katalogeintrag muss sich alles verhalten wie zuvor.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/produktkatalog.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/produktkatalog.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let PORT = 0;
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth','auth'],['/api/users','users'],['/api/orders','orders'],['/api/products','products'],['/api/projects','projects']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PWSEED })).body.token;
    const admin = await an('admin'), chef = await an('chef'), max = await an('max');

    console.log('── Nullprobe: ohne Katalog ist alles wie vorher ──');
    const leer = await req('GET', '/api/products/katalog', max);
    ok('der Katalog ist leer', leer.status === 200 && leer.body.produkte.length === 0 && leer.body.kategorien.length === 0,
      JSON.stringify(leer.body).slice(0, 90));
    const frei = await req('POST', '/api/orders', max, { product: '2 Rollen Klebeband', quantity: 2 });
    ok('eine getippte Bestellung geht wie immer', frei.status === 201, frei.status + ' ' + frei.text.slice(0, 90));
    const nachFrei = await req('GET', '/api/products/katalog', max);
    ok('… und legt NICHTS im Katalog an — die Regel, an der alles hängt',
      nachFrei.body.produkte.length === 0, JSON.stringify(nachFrei.body.produkte));

    console.log('\n── Ohne Barcode kein Katalogeintrag ──');
    const ohne = await req('POST', '/api/products', max, { name: 'Kabelbinder' });
    ok('Anlegen ohne Barcode wird abgewiesen', ohne.status === 400, ohne.status + ' ' + ohne.text.slice(0, 90));
    ok('… und erklärt, dass freier Text weiterhin geht', /freiem Text|freien Text/i.test(ohne.text), ohne.text.slice(0, 160));
    ok('… und nennt den Weg über das Pflegerecht', /Lagerdaten pflegen/.test(ohne.text), ohne.text.slice(0, 200));

    console.log('\n── Jeder Mitarbeiter darf anlegen ──');
    const kat = await req('POST', '/api/products/kategorien', max, { name: 'Elektro' });
    ok('ein Mitarbeiter legt eine Kategorie an', kat.status === 201, kat.status + ' ' + kat.text.slice(0, 90));
    const p1 = await req('POST', '/api/products', max, {
      name: 'Kabelbinder 200 mm', barcode: '4050821808435', category_id: kat.body.kategorie.id, default_unit: 'Beutel' });
    ok('… und ein Produkt mit Barcode', p1.status === 201, p1.status + ' ' + p1.text.slice(0, 110));
    ok('… das Produkt hat genau einen Barcode', p1.body.produkt.barcodes.length === 1, JSON.stringify(p1.body.produkt.barcodes));

    console.log('\n── 1:n — ein Produkt, mehrere Barcodes ──');
    for (const c of ['4050821027843', '4003899928864']) {
      const r = await req('POST', `/api/products/${p1.body.produkt.id}/barcodes`, max, { code: c });
      ok(`Barcode ${c} angelernt`, r.status === 201, r.status + ' ' + r.text.slice(0, 90));
    }
    const drei = await req('GET', `/api/products/barcode/4003899928864`, max);
    ok('alle drei führen auf dasselbe Produkt',
      drei.body.gefunden && drei.body.produkt.id === p1.body.produkt.id && drei.body.produkt.barcodes.length === 3,
      JSON.stringify(drei.body.produkt && drei.body.produkt.barcodes));

    console.log('\n── Ein Code gehört zu genau EINEM Produkt ──');
    const doppelt = await req('POST', '/api/products', max, { name: 'Etwas anderes', barcode: '4050821808435' });
    ok('ein vergebener Code wird abgewiesen', doppelt.status === 409, String(doppelt.status));
    ok('… und die App sagt, WELCHEM Produkt er gehört',
      /Kabelbinder 200 mm/.test(doppelt.text), doppelt.text.slice(0, 130));
    const anhaengen = await req('POST', `/api/products/${p1.body.produkt.id}/barcodes`, max, { code: '4050821808435' });
    ok('… auch beim Anlernen an dasselbe Produkt', anhaengen.status === 409, String(anhaengen.status));

    console.log('\n── Der letzte Barcode geht nur mit Rückfrage ──');
    const p2 = (await req('POST', '/api/products', max, { name: 'Aderendhülse 2,5', barcode: '4046281411223' })).body.produkt;
    const letzter = await req('DELETE', `/api/products/${p2.id}/barcodes/4046281411223`, chef);
    ok('der letzte Code wird verteidigt', letzter.status === 409, letzter.status + ' ' + letzter.text.slice(0, 90));
    ok('… und die Begründung sagt, was dann fehlt (Scannen) und was bleibt (Suche)',
      /scannen/i.test(letzter.text) && /Suche/i.test(letzter.text), letzter.text.slice(0, 160));
    const einerVonDreien = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/4003899928864`, chef);
    ok('einer von dreien geht dagegen', einerVonDreien.status === 200, String(einerVonDreien.status));
    ok('… und es bleiben zwei', einerVonDreien.body.produkt.barcodes.length === 2, JSON.stringify(einerVonDreien.body.produkt.barcodes));
    const maDarfNicht = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/4050821027843`, max);
    ok('ein Mitarbeiter darf keine Codes entfernen', maDarfNicht.status === 403, String(maDarfNicht.status));

    console.log('\n── Live-Suche findet trotz Schreibweise ──');
    await req('POST', '/api/products', max, { name: 'Schrauben-Sortiment', barcode: '4104640010552' });
    // „kabel-binder" MUSS „Kabelbinder 200 mm" finden — genau dafuer ist die Vergleichsform da.
    // Mein erster Entwurf erwartete hier 0 und behauptete damit das Gegenteil dessen, was gebaut
    // werden sollte. Ein Test, der die falsche Erwartung festschreibt, ist schlimmer als keiner.
    for (const [suche, erwartet] of [['kabel', 1], ['KABELBINDER', 1], ['kabel-binder', 1], ['schrauben sortiment', 1], ['Schraubensortiment', 1], ['xyz', 0]]) {
      const r = await req('GET', `/api/products?q=${encodeURIComponent(suche)}`, max);
      ok(`„${suche}" findet ${erwartet}`, r.body.produkte.length === erwartet,
        JSON.stringify(r.body.produkte.map(p => p.name)));
    }

    console.log('\n── Doppelte Kategorie wird erkannt ──');
    const katDoppelt = await req('POST', '/api/products/kategorien', max, { name: 'elektro' });
    ok('„elektro" gilt als „Elektro"', katDoppelt.status === 409, katDoppelt.status + ' ' + katDoppelt.text.slice(0, 90));

    console.log('\n── Unbekannter Code meldet sich sauber ──');
    const unbekannt = await req('GET', '/api/products/barcode/9999999999999', max);
    ok('nicht gefunden, ohne Fehler', unbekannt.status === 200 && unbekannt.body.gefunden === false, JSON.stringify(unbekannt.body));

    console.log('\n── Der Katalog kommt in einem Zug ──');
    const k = await req('GET', '/api/products/katalog', max);
    ok('Kategorien, Produkte und Codes zusammen',
      k.body.kategorien.length === 1 && k.body.produkte.length === 3 && k.body.produkte.every(p => Array.isArray(p.barcodes)),
      JSON.stringify({ kat: k.body.kategorien.length, prod: k.body.produkte.length }));
    ok('… jedes gescannte Produkt hat seinen Barcode',
      k.body.produkte.every(p => p.barcodes.length >= 1), JSON.stringify(k.body.produkte.map(p => p.barcodes.length)));

    console.log('\n── Ein Produkt OHNE Barcode (nur mit Pflegerecht) ──');
    const bcLos = await req('POST', '/api/products', chef, { name: 'Erdungsband 30x3' });
    ok('mit Pflegerecht entsteht es', bcLos.status === 201, bcLos.status + ' ' + bcLos.text.slice(0, 80));
    ok('… und es hat wirklich keinen Code', (bcLos.body.produkt.barcodes || []).length === 0,
      JSON.stringify(bcLos.body.produkt.barcodes));
    // Die Gegenprobe zur Zusicherung: Es ist da, aber NICHT scannbar.
    const suchbar = await req('GET', '/api/products?q=erdungsband', max);
    ok('über die Suche ist es zu finden',
      suchbar.body.produkte.some(p => p.id === bcLos.body.produkt.id),
      JSON.stringify(suchbar.body.produkte.map(p => p.name)));
    const imSpiegel = await req('GET', '/api/products/katalog', max);
    ok('… und es liegt im Offline-Spiegel (sonst fände die Anlern-Liste es nie)',
      imSpiegel.body.produkte.some(p => p.id === bcLos.body.produkt.id && p.barcodes.length === 0),
      JSON.stringify(imSpiegel.body.produkte.map(p => [p.name, p.barcodes.length])));
    const nichtScannbar = await req('GET', '/api/products/barcode/4260000000017', max);
    ok('gescannt findet es niemand', nichtScannbar.body.gefunden === false, JSON.stringify(nichtScannbar.body));

    // Genau der Fall, den Alex beschrieben hat: Der Artikel taucht später mit Code auf.
    const angelernt = await req('POST', `/api/products/${bcLos.body.produkt.id}/barcodes`, chef,
      { code: '4260000000017' });
    ok('beim ersten Scannen lernt es seinen Code dazu', angelernt.status === 200 || angelernt.status === 201,
      angelernt.status + ' ' + angelernt.text.slice(0, 80));
    const jetztScannbar = await req('GET', '/api/products/barcode/4260000000017', max);
    ok('… und ab jetzt findet der Scanner es',
      jetztScannbar.body.gefunden === true && jetztScannbar.body.produkt.id === bcLos.body.produkt.id,
      JSON.stringify(jetztScannbar.body).slice(0, 100));

    // Und zurück: Den letzten Code entfernen ist erlaubt, aber nur mit ausdrücklicher Bestätigung.
    const letzterOhne = await req('DELETE', `/api/products/${bcLos.body.produkt.id}/barcodes/4260000000017`, chef);
    ok('der letzte Code geht nicht versehentlich weg', letzterOhne.status === 409, String(letzterOhne.status));
    const letzterMit = await req('DELETE',
      `/api/products/${bcLos.body.produkt.id}/barcodes/4260000000017?trotzdem=1`, chef);
    ok('… mit Bestätigung schon', letzterMit.status === 200,
      letzterMit.status + ' ' + letzterMit.text.slice(0, 80));

    console.log('\n── Die Verknüpfung zur Bestellung ──');
    const mitProdukt = await req('POST', '/api/orders', max, {
      product: 'Kabelbinder 200 mm', quantity: 5, product_id: p1.body.produkt.id });
    ok('eine Bestellung mit Katalogprodukt geht', mitProdukt.status === 201, String(mitProdukt.status));
    const gespeichert = db.prepare('SELECT product, product_id FROM orders WHERE id = ?').get(mitProdukt.body.order.id);
    ok('… der TEXT ist gespeichert', gespeichert.product === 'Kabelbinder 200 mm', JSON.stringify(gespeichert));
    ok('… und die Verknüpfung auch', gespeichert.product_id === p1.body.produkt.id, JSON.stringify(gespeichert));

    // Eine ins Leere zeigende Verknuepfung darf die Bestellung NICHT scheitern lassen.
    const inLeere = await req('POST', '/api/orders', max, { product: 'Irgendwas', product_id: 999999 });
    ok('eine ungültige Verknüpfung wird still verworfen, nicht abgewiesen', inLeere.status === 201, String(inLeere.status));
    ok('… und die Bestellung steht trotzdem',
      db.prepare('SELECT product, product_id FROM orders WHERE id = ?').get(inLeere.body.order.id).product_id === null,
      JSON.stringify(db.prepare('SELECT product, product_id FROM orders WHERE id = ?').get(inLeere.body.order.id)));

    console.log('\n── Bestellungen bleiben unberührt ──');
    const best = await req('GET', '/api/orders', max);
    ok('die getippte Bestellung steht unverändert da',
      best.body.orders.some(o => o.product === '2 Rollen Klebeband'), JSON.stringify(best.body.orders.map(o => o.product)));

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Wer darf PFLEGEN? (Alex, 08.09.2026)
    //
    // Bis hierher hing das an der Rolle. Jetzt gibt es das Einzelrecht can_products — dieselbe
    // Idee wie beim Bestellrecht, wo Urlaub und Krankheit sonst die ganze Firma ausbremsen.
    //
    // Die Falle, gegen die dieser Abschnitt geschrieben ist: Beim Bestellrecht stand dieselbe
    // Regel an fuenf Stellen, drei davon falsch. Eine hingeschriebene Bedingung
    // `role IN ('chef','admin')` sieht richtig aus und uebersieht das Haekchen STILL — nichts
    // geht kaputt, es geht nur nicht. Deshalb wird hier nicht die Funktion geprueft, sondern
    // die WIRKUNG an der Route.
    console.log('\n── Wer darf die Lagerdaten pflegen ──');
    const buchhalter = await an('buchhalter');
    const maxId = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;
    const chefId = db.prepare("SELECT id FROM users WHERE username = 'chef'").get().id;
    const codesVonP1 = () => db.prepare('SELECT code FROM product_barcodes WHERE product_id = ? ORDER BY code').all(p1.body.produkt.id).map(r => r.code);
    const [codeA, codeB] = codesVonP1();

    // Gegenprobe zum Bestellrecht: Der Buchhalter hat es dort PER ROLLE — hier NICHT.
    const buchDarfNicht = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/${codeA}`, buchhalter);
    ok('der Buchhalter hat das Recht NICHT per Rolle', buchDarfNicht.status === 403, String(buchDarfNicht.status));

    // Anlegen bleibt fuer JEDEN offen — das ist kein Versehen, sondern der Zweck.
    const maLegtAn = await req('POST', '/api/products', max, { name: 'Isolierband schwarz', barcode: '4008196000119' });
    ok('anlegen darf weiterhin jeder, auch ohne Recht', maLegtAn.status === 201, maLegtAn.status + ' ' + maLegtAn.text.slice(0, 80));

    const setzen = async (id, wert, token) => req('PUT', `/api/users/${id}`, token, { can_products: wert });
    const gesetzt = await setzen(maxId, true, admin);
    ok('das Häkchen lässt sich setzen', gesetzt.status === 200, gesetzt.status + ' ' + gesetzt.text.slice(0, 90));
    ok('… und steht in der Datenbank',
      db.prepare('SELECT can_products FROM users WHERE id = ?').get(maxId).can_products === 1,
      JSON.stringify(db.prepare('SELECT can_products FROM users WHERE id = ?').get(maxId)));

    // Ohne neues Anmelden: die Middleware liest das Recht bei JEDER Anfrage frisch. Haenge es an
    // der Sitzung, muesste sich Max erst ab- und wieder anmelden — das wuerde niemand verstehen.
    const jetztErlaubt = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/${codeA}`, max);
    ok('mit Recht darf der Mitarbeiter — ohne neues Anmelden', jetztErlaubt.status === 200,
      jetztErlaubt.status + ' ' + jetztErlaubt.text.slice(0, 90));
    ok('… der Code ist wirklich weg', !codesVonP1().includes(codeA), JSON.stringify(codesVonP1()));

    // Das Recht steht im Protokoll — sonst laesst sich hinterher nicht klaeren, wer es vergab.
    const spur = db.prepare("SELECT details FROM audit_logs WHERE action = 'user_update' ORDER BY id DESC LIMIT 1").get();
    ok('die Vergabe steht im Protokoll', /Produktverzeichnis/.test(spur && spur.details || ''),
      JSON.stringify(spur));

    // Entziehen muss genauso wirken. Ein Recht, das man nicht zurueckgeben kann, ist keins.
    await setzen(maxId, false, admin);
    const wiederGesperrt = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/${codeB}`, max);
    ok('entzogen wirkt es sofort wieder', wiederGesperrt.status === 403, String(wiederGesperrt.status));
    ok('… und der Code steht noch da', codesVonP1().includes(codeB), JSON.stringify(codesVonP1()));

    // Chef/Admin haben es per Rolle — das Haekchen bleibt bei ihnen auf 0, damit nicht zwei
    // Quellen dasselbe behaupten (und eine spaeter still veraltet).
    await setzen(chefId, true, admin);
    ok('beim Chef bleibt das Häkchen leer (er hat es per Rolle)',
      db.prepare('SELECT can_products FROM users WHERE id = ?').get(chefId).can_products === 0,
      JSON.stringify(db.prepare('SELECT can_products FROM users WHERE id = ?').get(chefId)));
    const chefDarfWeiter = await req('DELETE', `/api/products/${p1.body.produkt.id}/barcodes/${codeB}`, chef);
    ok('… und er darf trotzdem', chefDarfWeiter.status === 409 || chefDarfWeiter.status === 200,
      String(chefDarfWeiter.status));

  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nProduktverzeichnis: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
