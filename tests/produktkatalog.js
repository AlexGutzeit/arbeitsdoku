// Produktverzeichnis: Kategorien, Produkte, Barcodes (1:n).
//
// Die Regel, an der alles hängt (Alex, 07.09.2026): In den Katalog kommt NUR, was einen Barcode
// hat. Eine getippte Bestellung erzeugt keinen Eintrag. Daraus folgt die harte Zusicherung, dass
// ein Produkt immer mindestens einen Barcode hat — den letzten zu entfernen wird abgewiesen.
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

    console.log('\n── Der letzte Barcode lässt sich nicht entfernen ──');
    const p2 = (await req('POST', '/api/products', max, { name: 'Aderendhülse 2,5', barcode: '4046281411223' })).body.produkt;
    const letzter = await req('DELETE', `/api/products/${p2.id}/barcodes/4046281411223`, chef);
    ok('der letzte Code wird verteidigt', letzter.status === 409, letzter.status + ' ' + letzter.text.slice(0, 90));
    ok('… mit Begründung', /mindestens einen/i.test(letzter.text), letzter.text.slice(0, 140));
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
    ok('… jedes Produkt hat mindestens einen Barcode',
      k.body.produkte.every(p => p.barcodes.length >= 1), JSON.stringify(k.body.produkte.map(p => p.barcodes.length)));

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
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nProduktverzeichnis: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
