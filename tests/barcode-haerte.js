// Barcode-Kette: die Grenzfälle, die im Lager irgendwann kommen.
//
// Die anderen Barcode-Tests prüfen, dass der GEWOLLTE Weg funktioniert. Hier geht es um das
// Gegenteil: Was passiert bei Eingaben, die niemand vorgesehen hat? Der Anlass war Alex' Bitte,
// „die Fehlerlosigkeit zu beweisen" (13.09.2026) — beweisen lässt sie sich nicht, aber man kann
// gezielt dort suchen, wo bisher nichts misst.
//
// Gefunden hat diese Datei drei Dinge, die vorher durchgingen:
//
//   1. Ein 5000 Zeichen langer Code wurde angenommen — und landet im Offline-Spiegel, den JEDES
//      Handy im Lager lädt.
//   2. Ein Code mit Zeilenumbruch (vCard-QR, WLAN-Zugang) wurde als Artikelnummer gespeichert.
//   3. Für `products` gab es keine Entsprechung zu tests/altdb-spalten.js: Was die Routen aus der
//      Tabelle LESEN, muss der Restore-Pfad nachziehen. Sonst antwortet der Server nach dem
//      Einspielen einer alten Sicherung mit „no such column".
//
// Der dritte Punkt ist der gefährlichste, weil er erst Monate später auffällt — beim Restore,
// also genau dann, wenn man ihn am wenigsten gebrauchen kann.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/barcode-haerte.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/barcode-haerte.db';
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

/**
 * Welche Spalten liest der Produkt-Router aus `products`?
 *
 * HERAUSGELESEN, nicht abgeschrieben — dieselbe Regel wie in tests/altdb-spalten.js. Ein Test, der
 * die Liste abschreibt, ist beim nächsten neuen Feld still veraltet, und genau dann bräuchte man
 * ihn. Gesucht wird nach `p.<spalte>` in den SQL-Zeilen des Routers.
 */
function spaltenDerProduktRouten() {
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'routes', 'products.js'), 'utf8');
  const treffer = new Set();
  for (const m of quelle.matchAll(/\bp\.([a-z_]+)\b/g)) treffer.add(m[1]);
  // `p.` steht auch für JavaScript-Objekte (p.name eines gelesenen Produkts). Deshalb wird
  // hinterher gegen die WIRKLICHEN Spalten geschnitten — was es in der Tabelle nicht gibt, kann
  // auch nicht fehlen.
  return treffer;
}

(async () => {
  await initDatabase();
  const db = getDb();
  const PWSEED = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PWSEED, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth', 'auth'], ['/api/users', 'users'], ['/api/orders', 'orders'],
    ['/api/products', 'products'], ['/api/suppliers', 'suppliers']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PWSEED })).body.token;
    const admin = await an('admin'), chef = await an('chef'), max = await an('max');
    const maxId = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;

    // ── 1. Was taugt als Barcode? ─────────────────────────────────────────────────────────────
    console.log('── Der Code selbst ──');
    const langer = await req('POST', '/api/products', chef, { name: 'Langer Code', barcode: '9'.repeat(5000) });
    ok('ein 5000 Zeichen langer Code wird abgewiesen', langer.status === 400, String(langer.status));
    ok('… und die Meldung sagt, was er vermutlich ist',
      /QR|Adresse|Artikelnummer/.test(langer.body.error || ''), langer.body.error);
    ok('genau an der Grenze (200) geht es noch',
      (await req('POST', '/api/products', chef, { name: 'Grenzfall', barcode: '7'.repeat(200) })).status === 201);
    ok('… eine Stelle darüber nicht mehr',
      (await req('POST', '/api/products', chef, { name: 'Zu lang', barcode: '7'.repeat(201) })).status === 400);

    const NL = String.fromCharCode(10), TAB = String.fromCharCode(9), GS = String.fromCharCode(29);
    for (const [name, zeichen] of [['Zeilenumbruch', NL], ['Tabulator', TAB], ['GS-Trenner', GS]]) {
      const r = await req('POST', '/api/products', chef, { name: 'Steuer ' + name, barcode: 'AA' + zeichen + 'BB' });
      ok(`ein Code mit ${name} wird abgewiesen`, r.status === 400, r.status + ' ' + r.text.slice(0, 70));
    }
    // Nicht stillschweigend abschneiden: Wer eine vCard scannt, soll es ERFAHREN.
    ok('… und nichts davon ist heimlich gespeichert worden',
      db.prepare("SELECT COUNT(*) AS c FROM product_barcodes WHERE code LIKE 'AA%'").get().c === 0);

    console.log('\n── Leerzeichen und Schreibweise ──');
    const getrimmt = await req('POST', '/api/products', chef, { name: 'Getrimmt', barcode: '  4050821808435  ' });
    ok('äussere Leerzeichen werden entfernt', getrimmt.status === 201
      && getrimmt.body.produkt.barcodes[0] === '4050821808435', JSON.stringify(getrimmt.body.produkt.barcodes));
    ok('… und der Code ist ohne sie auffindbar',
      (await req('GET', '/api/products/barcode/4050821808435', max)).body.gefunden === true);
    // Ein Code aus lauter Leerzeichen ist nach dem Trimmen KEIN Code — und damit gilt die Regel
    // fuer barcodelose Produkte: nur mit „Lagerdaten pflegen". Gemessen, nicht angenommen: Mein
    // erster Entwurf erwartete hier 400 und lag falsch.
    const leerChef = await req('POST', '/api/products', chef, { name: 'Leer als Chef', barcode: '   ' });
    ok('lauter Leerzeichen heisst „kein Barcode" — mit Pflegerecht also erlaubt',
      leerChef.status === 201 && (leerChef.body.produkt.barcodes || []).length === 0,
      leerChef.status + ' ' + JSON.stringify(leerChef.body.produkt && leerChef.body.produkt.barcodes));
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: true });
    const leerMax = await req('POST', '/api/products', max, { name: 'Leer als MA', barcode: '   ' });
    ok('… und ohne Pflegerecht wird genau das abgewiesen', leerMax.status === 400,
      leerMax.status + ' ' + leerMax.text.slice(0, 80));
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: false });
    ok('beim Anlernen an ein bestehendes Produkt ist ein leerer Code immer ein Fehler',
      (await req('POST', `/api/products/${getrimmt.body.produkt.id}/barcodes`, chef, { code: '  ' })).status === 400);

    // BEWUSSTE ENTSCHEIDUNG, hier festgenagelt: Gross- und Kleinschreibung sind VERSCHIEDENE
    // Codes. Ein QR-Inhalt ist eine Zeichenkette, und `id.abb/X` ist nicht `ID.ABB/x`. Wer das
    // später „aufräumt", bricht die Hersteller-QRs — deshalb steht es als Zusicherung da.
    const gross = await req('POST', '/api/products', chef, { name: 'Gross', barcode: 'ABC12345' });
    const klein = await req('POST', '/api/products', chef, { name: 'Klein', barcode: 'abc12345' });
    ok('Gross- und Kleinschreibung gelten als zwei Codes (Absicht, s. Kommentar)',
      gross.status === 201 && klein.status === 201, JSON.stringify([gross.status, klein.status]));
    ok('… und jeder führt auf SEIN Produkt',
      (await req('GET', '/api/products/barcode/ABC12345', max)).body.produkt.name === 'Gross'
      && (await req('GET', '/api/products/barcode/abc12345', max)).body.produkt.name === 'Klein');
    // Die eigentliche Gefahr wäre ein Widerspruch zwischen App-Prüfung und Datenbank-Zusicherung:
    // Wenn die App „frei" sagt und der UNIQUE-Index dann zuschlägt, gäbe es einen 500er.
    const nochmal = await req('POST', '/api/products', chef, { name: 'Nochmal', barcode: 'ABC12345' });
    ok('ein wirklich belegter Code endet in 409, nie in einem Serverfehler',
      nochmal.status === 409, nochmal.status + ' ' + nochmal.text.slice(0, 80));

    // ── 2. Das Recht ──────────────────────────────────────────────────────────────────────────
    console.log('\n── Das Einlernrecht, entzogen und zurückgegeben ──');
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: true });
    ok('mit Recht darf max anlernen',
      (await req('POST', '/api/products', max, { name: 'Von Max', barcode: '4062679100015' })).status === 201);
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: false });
    ok('der Entzug wirkt SOFORT, ohne neue Anmeldung',
      (await req('POST', '/api/products', max, { name: 'Danach', barcode: '4062679100022' })).status === 403);
    ok('… und das eben angelegte Produkt steht unverändert da',
      (await req('GET', '/api/products/barcode/4062679100015', max)).body.gefunden === true);
    // Das Pflegerecht schliesst das Einlernen ein — sonst dürfte ein Pfleger im Verzeichnis
    // Barcodes anlernen, am Regal aber nicht. Diese Folgerung ist leicht zu übersehen.
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_edit: true });
    ok('wer pflegen darf, darf auch einlernen (ohne eigenes Häkchen)',
      (await req('POST', '/api/products', max, { name: 'Über Pflegerecht', barcode: '4062679100039' })).status === 201);
    ok('… und das Einlern-Häkchen bleibt dabei leer (eine Quelle, nicht zwei)',
      db.prepare('SELECT can_products_add FROM users WHERE id = ?').get(maxId).can_products_add === 0,
      JSON.stringify(db.prepare('SELECT can_products_add, can_products_edit FROM users WHERE id = ?').get(maxId)));
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_edit: false });

    // ── 3. Der Spiegel zeigt Vergangenheit ────────────────────────────────────────────────────
    console.log('\n── Wenn der Offline-Spiegel veraltet ist ──');
    const kurzlebig = (await req('POST', '/api/products', chef,
      { name: 'Wird gelöscht', barcode: '4062679100046' })).body.produkt;
    const spiegel = (await req('GET', '/api/products/katalog', max)).body;
    ok('das Produkt liegt im Spiegel', spiegel.produkte.some(p => p.id === kurzlebig.id));
    await req('DELETE', `/api/products/${kurzlebig.id}`, chef);
    // Ein Handy im Funkloch kennt die Löschung nicht und schickt die alte ID mit. Der Server darf
    // die Bestellung NICHT ablehnen (der Mensch braucht das Material trotzdem) und sie auch nicht
    // an eine Leiche hängen.
    const mitToterId = await req('POST', '/api/orders', max,
      { product: 'Wird gelöscht', quantity: 2, product_id: kurzlebig.id });
    ok('eine Bestellung mit veralteter Produkt-ID geht trotzdem durch', mitToterId.status === 201,
      mitToterId.status + ' ' + mitToterId.text.slice(0, 80));
    const gespeichert = db.prepare('SELECT product, product_id FROM orders ORDER BY id DESC LIMIT 1').get();
    ok('… der TEXT bleibt erhalten', gespeichert.product === 'Wird gelöscht', JSON.stringify(gespeichert));
    ok('… die Verknüpfung zum gelöschten Produkt aber NICHT', gespeichert.product_id === null,
      JSON.stringify(gespeichert));
    ok('… und der Scan erklärt, dass der Code zu einem gelöschten Produkt gehört',
      (await req('GET', '/api/products/barcode/4062679100046', max)).body.geloeschtes_produkt !== undefined);

    // ── 4. Restore eines alten Standes ────────────────────────────────────────────────────────
    //
    // Der Fall, der erst Monate später auftritt: eine Sicherung von vor dem Hersteller-Feld wird
    // eingespielt. Die Routen lesen `p.hersteller` NAMENTLICH — fehlt die Spalte, antwortet der
    // Server mit „no such column", und zwar auf jede Produktabfrage.
    console.log('\n── Was die Routen aus `products` lesen, muss der Restore-Pfad nachziehen ──');
    const spaltenDa = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
    const gelesen = [...spaltenDerProduktRouten()].filter(n => spaltenDa.has(n));
    ok('die Liste wurde wirklich aus dem Quelltext gezogen', gelesen.length >= 5, JSON.stringify(gelesen));
    ok('… und „hersteller" ist dabei (sonst misst der nächste Punkt nichts)',
      gelesen.includes('hersteller'), JSON.stringify(gelesen));

    // Alten Stand nachbauen: dieselbe Tabelle OHNE die neuen Spalten.
    db.exec('CREATE TABLE alt_products AS SELECT id, name, category_id FROM products');
    db.exec('DROP TABLE products');
    db.exec('ALTER TABLE alt_products RENAME TO products');
    const fehlenVorher = gelesen.filter(n => !db.prepare('PRAGMA table_info(products)').all().some(c => c.name === n));
    ok('der nachgebaute Altstand hat die neuen Spalten wirklich nicht',
      fehlenVorher.includes('hersteller'), JSON.stringify(fehlenVorher));

    // Genau das tut der Restore-Pfad (database/init.js, ensureSchema/addCol) beim Einspielen.
    // Der ECHTE Restore-Pfad, nicht nachgebaut: ensureAuditSchema() enthält alle addCol-Aufrufe
    // und läuft beim Einspielen einer Sicherung. Ein nachgebauter Pfad prüfte sich selbst.
    const { ensureAuditSchema } = require('../database/init');
    ok('der Restore-Pfad ist als Funktion erreichbar', typeof ensureAuditSchema === 'function');
    ensureAuditSchema(db);
    const nachher = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
    ok('nach dem Nachziehen sind alle gelesenen Spalten da',
      gelesen.every(n => nachher.includes(n)),
      JSON.stringify(gelesen.filter(n => !nachher.includes(n))));

  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nBarcode-Härtetest: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
