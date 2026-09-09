// Verzeichnis-Pflege und Großhändler (Alex, 08./09.09.2026).
//
// Zwei Dinge stehen hier auf dem Spiel, und beide sind still:
//
//  1. RECHTE. Pflegen darf nur, wer can_products hat (oder Chef/Admin ist). Ansehen der
//     Händler-Angaben darf zusätzlich, wer bestellen darf — das ist der ganze Zweck. Eine Route,
//     die den Riegel vergisst, fällt niemandem auf: Es geht ja etwas, es geht nur zu viel.
//
//  2. DATENVERLUST BEIM ZUSAMMENFÜHREN. UNIQUE(product_id, supplier_id) lässt nicht zu, dass ein
//     zusammengeführtes Produkt zweimal denselben Händler hat. Ein schlichtes UPDATE würde eine
//     der beiden Bestellnummern verschlucken — abgetippt von Hand, vermisst erst Monate später
//     beim Bestellen. Der Abschnitt „Die Kollision" ist der eigentliche Grund für diese Datei.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]), eigener Port über listen(0).
//
//   node tests/produktpflege.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/produktpflege.db';
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
  const PW = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PW, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth','auth'],['/api/users','users'],['/api/orders','orders'],
                             ['/api/products','products'],['/api/suppliers','suppliers'],['/api/projects','projects']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PW })).body.token;
    const admin = await an('admin'), chef = await an('chef'), max = await an('max'), buch = await an('buchhalter');
    const maxId = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;
    const neu = async (name, code) => (await req('POST', '/api/products', max, { name, barcode: code })).body.produkt;

    console.log('── Ohne Recht kommt niemand an die Pflege ──');
    const p1 = await neu('Kabelbinder 200 mm', '4001');
    const p2 = await neu('kabel-binder 200mm', '4002');
    for (const [m, pfad, rumpf] of [
      ['GET', '/api/products/verzeichnis', null],
      ['PUT', `/api/products/${p1.id}`, { name: 'Anders' }],
      ['DELETE', `/api/products/${p1.id}`, null],
      ['POST', `/api/products/${p1.id}/zusammenfuehren`, { von_id: p2.id }],
      ['PUT', '/api/products/kategorien/1', { name: 'X' }],
      ['POST', '/api/suppliers', { name: 'Sonepar' }],
    ]) {
      const r = await req(m, pfad, max, rumpf);
      ok(`${m} ${pfad.replace('/api/', '')} → 403`, r.status === 403, String(r.status));
    }

    console.log('\n── Umbenennen, und die Warnung vor dem Doppel ──');
    const warn = await req('PUT', `/api/products/${p1.id}`, chef, { name: 'kabel-binder 200mm' });
    ok('ein vorhandener Name wird gemeldet', warn.status === 409, warn.status + ' ' + warn.text.slice(0, 80));
    ok('… und das vorhandene Produkt genannt', warn.body.aehnliche && warn.body.aehnliche[0].id === p2.id,
      JSON.stringify(warn.body.aehnliche));
    const trotz = await req('PUT', `/api/products/${p1.id}`, chef, { name: 'kabel-binder 200mm', trotzdem: true });
    ok('mit „trotzdem" geht es doch', trotz.status === 200, trotz.status + ' ' + trotz.text.slice(0, 80));
    await req('PUT', `/api/products/${p1.id}`, chef, { name: 'Kabelbinder 200 mm', trotzdem: true });

    console.log('\n── Der Pfleger darf, sobald er das Häkchen hat ──');
    await req('PUT', `/api/users/${maxId}`, admin, { can_products: true });
    const jetzt = await req('GET', '/api/products/verzeichnis', max);
    ok('das Verzeichnis öffnet sich', jetzt.status === 200, String(jetzt.status));
    ok('… und meldet die beiden Namensgleichen als Dublette',
      jetzt.body.dubletten.length === 1 && jetzt.body.dubletten[0].length === 2,
      JSON.stringify(jetzt.body.dubletten));

    console.log('\n── Löschen ist weich, der Barcode erzählt weiter ──');
    const p3 = await neu('Isolierband', '4003');
    ok('gelöscht', (await req('DELETE', `/api/products/${p3.id}`, chef)).status === 200);
    const nachher = await req('GET', '/api/products/barcode/4003', max);
    ok('der Code sagt „gehörte zu …" statt „unbekannt"',
      nachher.body.gefunden === false && nachher.body.geloeschtes_produkt
        && nachher.body.geloeschtes_produkt.id === p3.id, JSON.stringify(nachher.body));
    ok('wiederhergestellt', (await req('POST', `/api/products/${p3.id}/wiederherstellen`, chef)).status === 200);
    ok('… und wieder auffindbar', (await req('GET', '/api/products/barcode/4003', max)).body.gefunden === true);

    // SACKGASSE, gefunden am 09.09.2026: Der Barcode eines geloeschten Produkts bleibt belegt.
    // Frueher bot die App an, damit ein NEUES Produkt anzulegen — das scheiterte dann. Und
    // ANLERNEN an ein anderes Produkt scheitert aus demselben Grund. Der einzige Weg ist das
    // Zurueckholen; die Meldung muss das sagen, sonst steht man davor.
    await req('DELETE', `/api/products/${p3.id}`, chef);
    const neuMitBelegtem = await req('POST', '/api/products', max, { name: 'Etwas anderes', barcode: '4003' });
    ok('mit dem Code eines gelöschten Produkts lässt sich nichts Neues anlegen',
      neuMitBelegtem.status === 409, String(neuMitBelegtem.status));
    ok('… und die Meldung sagt WARUM und wie man herauskommt',
      /gelöschten Produkt/.test(neuMitBelegtem.text) && /zurück/.test(neuMitBelegtem.text),
      neuMitBelegtem.body && neuMitBelegtem.body.error);
    const anlernenBelegt = await req('POST', `/api/products/${p1.id}/barcodes`, chef, { code: '4003' });
    ok('… auch das Anlernen an ein anderes Produkt erklärt sich',
      anlernenBelegt.status === 409 && /gelöschten Produkt/.test(anlernenBelegt.text),
      anlernenBelegt.body && anlernenBelegt.body.error);
    ok('… und der Ausweg funktioniert',
      (await req('POST', `/api/products/${p3.id}/wiederherstellen`, chef)).status === 200);

    console.log('\n── Kategorien ──');
    const kA = (await req('POST', '/api/products/kategorien', max, { name: 'Elektro' })).body.kategorie;
    const kB = (await req('POST', '/api/products/kategorien', max, { name: 'Elektrik' })).body.kategorie;
    await req('PUT', `/api/products/${p1.id}`, chef, { category_id: kA.id });
    const katWeg = await req('DELETE', `/api/products/kategorien/${kA.id}`, chef);
    ok('eine belegte Kategorie wird nicht einfach gelöscht', katWeg.status === 409, String(katWeg.status));
    ok('… und die Zahl steht dabei', katWeg.body.anzahl === 1, JSON.stringify(katWeg.body));
    const zus = await req('POST', `/api/products/kategorien/${kA.id}/zusammenfuehren`, chef, { nach_id: kB.id });
    ok('zusammenführen verschiebt die Produkte', zus.status === 200 && zus.body.verschoben === 1, JSON.stringify(zus.body));
    ok('… und das Produkt hängt jetzt an der anderen',
      db.prepare('SELECT category_id FROM products WHERE id = ?').get(p1.id).category_id === kB.id);

    console.log('\n── Zusammenführen zweier Produkte ──');
    const best = await req('POST', '/api/orders', max, { product: 'kabel-binder 200mm', quantity: 3, product_id: p2.id });
    const bId = best.body.order.id;
    await req('POST', `/api/products/${p2.id}/barcodes`, max, { code: '4002b' });
    const zf = await req('POST', `/api/products/${p1.id}/zusammenfuehren`, chef, { von_id: p2.id, name: 'Kabelbinder 200 mm' });
    ok('zusammengeführt', zf.status === 200, zf.status + ' ' + zf.text.slice(0, 90));
    ok('… beide Barcodes hängen jetzt am Überlebenden',
      zf.body.produkt.barcodes.includes('4002') && zf.body.produkt.barcodes.includes('4002b')
        && zf.body.produkt.barcodes.includes('4001'), JSON.stringify(zf.body.produkt.barcodes));
    const nachBest = db.prepare('SELECT product, product_id FROM orders WHERE id = ?').get(bId);
    ok('… die Bestellung zeigt auf das Überlebende', nachBest.product_id === p1.id, JSON.stringify(nachBest));
    ok('… IHR TEXT ist unangetastet', nachBest.product === 'kabel-binder 200mm', JSON.stringify(nachBest));
    ok('… das aufgegangene Produkt ist als solches vermerkt',
      db.prepare('SELECT merged_into, deleted_at FROM products WHERE id = ?').get(p2.id).merged_into === p1.id);
    const zurueck = await req('POST', `/api/products/${p2.id}/wiederherstellen`, chef);
    ok('… und lässt sich nicht als eigenes zurückholen', zurueck.status === 409, String(zurueck.status));

    console.log('\n── Großhändler ──');
    const sHin = await req('POST', '/api/suppliers', chef, {
      name: 'Sonepar', homepage: 'shop.sonepar.de', kundennummer: '4711',
      ansprechpartner: 'Frau Meier', telefon: '0711 1234', email: 'meier@example.org', notiz: 'Lieferung Di + Do' });
    ok('angelegt', sHin.status === 201, sHin.status + ' ' + sHin.text.slice(0, 90));
    ok('… die Homepage bekam ihr https://', sHin.body.haendler.homepage === 'https://shop.sonepar.de/',
      JSON.stringify(sHin.body.haendler.homepage));
    const sId = sHin.body.haendler.id;
    const doppelt = await req('POST', '/api/suppliers', chef, { name: 'sonepar' });
    ok('derselbe Händler nicht zweimal', doppelt.status === 409, String(doppelt.status));
    const boese = await req('POST', '/api/suppliers', chef, { name: 'Böse', homepage: 'javascript:alert(1)' });
    ok('ein javascript:-Link wird abgewiesen', boese.status === 400 && /http/.test(boese.text),
      boese.status + ' ' + boese.text.slice(0, 100));

    console.log('\n── Was das Produkt bei diesem Händler ist ──');
    const eintrag = await req('PUT', `/api/products/${p1.id}/haendler/${sId}`, chef, {
      bestellnummer: '88123', link: 'https://shop.sonepar.de/artikel/88123', kommentar: 'VPE 100' });
    ok('hinterlegt', eintrag.status === 200, eintrag.status + ' ' + eintrag.text.slice(0, 90));
    const boeserLink = await req('PUT', `/api/products/${p1.id}/haendler/${sId}`, chef, { link: 'javascript:alert(1)' });
    ok('auch hier kein javascript:', boeserLink.status === 400, String(boeserLink.status));
    const alsBuch = await req('GET', `/api/products/${p1.id}/haendler`, buch);
    ok('wer bestellen darf, sieht die Angaben', alsBuch.status === 200 && alsBuch.body.haendler.length === 1,
      alsBuch.status + ' ' + alsBuch.text.slice(0, 90));
    ok('… mit Bestellnummer und Link', alsBuch.body.haendler[0].bestellnummer === '88123'
      && alsBuch.body.haendler[0].link === 'https://shop.sonepar.de/artikel/88123', JSON.stringify(alsBuch.body.haendler[0]));
    ok('… und den Angaben zum Händler selbst', alsBuch.body.haendler[0].kundennummer === '4711'
      && alsBuch.body.haendler[0].ansprechpartner === 'Frau Meier', JSON.stringify(alsBuch.body.haendler[0]));

    console.log('\n── Die Kollision: beide Produkte beim selben Händler ──');
    // Der Grund fuer diese Datei. Zwei Produkte, dieselbe Firma, ZWEI verschiedene Bestellnummern.
    const a1 = await neu('Aderendhülse 2,5', '5001');
    const a2 = await neu('aderendhuelse 2.5', '5002');
    await req('PUT', `/api/products/${a1.id}/haendler/${sId}`, chef, { bestellnummer: 'AEH-25-100', kommentar: '100er Beutel' });
    await req('PUT', `/api/products/${a2.id}/haendler/${sId}`, chef, { bestellnummer: 'AEH-25-500', link: 'https://shop.sonepar.de/500' });
    const koll = await req('POST', `/api/products/${a1.id}/zusammenfuehren`, chef, { von_id: a2.id });
    ok('zusammengeführt', koll.status === 200, koll.status + ' ' + koll.text.slice(0, 90));
    ok('… der Händler wird als verschmolzen gemeldet, nicht als übernommen',
      koll.body.haendler_uebernommen === 0 && koll.body.haendler_verschmolzen.includes('Sonepar'),
      JSON.stringify({ u: koll.body.haendler_uebernommen, v: koll.body.haendler_verschmolzen }));
    const nachKoll = (await req('GET', `/api/products/${a1.id}/haendler`, chef)).body.haendler;
    ok('… es steht genau EIN Eintrag da', nachKoll.length === 1, JSON.stringify(nachKoll.map(h => h.bestellnummer)));
    ok('… die eigene Bestellnummer ist unverändert', nachKoll[0].bestellnummer === 'AEH-25-100', nachKoll[0].bestellnummer);
    // DAS ist die Zusage: die zweite Nummer ist NICHT weg.
    ok('… und die ZWEITE Nummer steht im Kommentar', /AEH-25-500/.test(nachKoll[0].kommentar || ''), nachKoll[0].kommentar);
    ok('… samt Herkunft', /aderendhuelse/i.test(nachKoll[0].kommentar || ''), nachKoll[0].kommentar);
    ok('… und der ursprüngliche Kommentar blieb stehen', /100er Beutel/.test(nachKoll[0].kommentar || ''), nachKoll[0].kommentar);
    ok('… auch der Link der Quelle ging nicht verloren', /shop\.sonepar\.de\/500/.test(nachKoll[0].kommentar || ''), nachKoll[0].kommentar);

    console.log('\n── Händler löschen ──');
    const weg1 = await req('DELETE', `/api/suppliers/${sId}`, chef);
    ok('mit hinterlegten Produkten wird erst gefragt', weg1.status === 409, String(weg1.status));
    ok('… und die Zahl genannt', weg1.body.anzahl >= 2, JSON.stringify(weg1.body.anzahl));
    const weg2 = await req('DELETE', `/api/suppliers/${sId}`, chef, { trotzdem: true });
    ok('bestätigt geht es', weg2.status === 200, String(weg2.status));
    ok('… die Einträge bleiben aber in der Datenbank stehen',
      db.prepare('SELECT COUNT(*) AS c FROM product_suppliers WHERE supplier_id = ?').get(sId).c >= 2,
      JSON.stringify(db.prepare('SELECT COUNT(*) AS c FROM product_suppliers WHERE supplier_id = ?').get(sId)));
    ok('… und tauchen beim Produkt nicht mehr auf',
      (await req('GET', `/api/products/${p1.id}/haendler`, chef)).body.haendler.length === 0);

    console.log('\n── Der gelöschte Händler kommt zurück ──');
    // Die Loeschmeldung verspricht: „Die bleiben erhalten und kommen zurueck, wenn der Haendler
    // wiederhergestellt wird." Das WAR nicht wahr — es gab kein Wiederherstellen, und wer denselben
    // Namen neu anlegte, bekam einen neuen Haendler; die alten Bestellnummern blieben als
    // unsichtbare Zeilen liegen. Gefunden am 09.09.2026.
    const haendlerZurueck = await req('POST', `/api/suppliers/${sId}/wiederherstellen`, chef);
    ok('der gelöschte Händler lässt sich zurückholen', haendlerZurueck.status === 200,
      haendlerZurueck.status + ' ' + haendlerZurueck.text.slice(0, 80));
    const wiederDa = (await req('GET', `/api/products/${p1.id}/haendler`, chef)).body.haendler;
    ok('… und die hinterlegte Bestellnummer ist wieder da',
      wiederDa.length === 1 && wiederDa[0].bestellnummer === '88123', JSON.stringify(wiederDa.map(h => h.bestellnummer)));
    ok('… es liegen keine verwaisten Zeilen mehr herum',
      db.prepare('SELECT COUNT(*) c FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE s.deleted_at IS NOT NULL').get().c === 0);
    // Und der Grenzfall: Name inzwischen neu vergeben.
    await req('DELETE', `/api/suppliers/${sId}`, chef, { trotzdem: true });
    await req('POST', '/api/suppliers', chef, { name: 'Sonepar' });
    const kollision = await req('POST', `/api/suppliers/${sId}/wiederherstellen`, chef);
    ok('… ist der Name inzwischen neu vergeben, wird das erklärt statt still zu scheitern',
      kollision.status === 409 && /umbenennen|Benenne/.test(kollision.text), kollision.body && kollision.body.error);

    console.log('\n── Ansehen ist an das Bestellrecht geknüpft ──');
    // Max hat inzwischen das PFLEGE-Recht — deshalb ein Kollege ohne beides.
    const ohne = (await req('POST', '/api/users', admin, {
      username: 'lager', password: PW, name: 'Lager', role: 'mitarbeiter' })).body;
    const lager = await an('lager');
    ok('wer weder bestellen noch pflegen darf, sieht nichts',
      (await req('GET', `/api/products/${p1.id}/haendler`, lager)).status === 403);
    ok('… kommt auch nicht an die Händlerliste',
      (await req('GET', '/api/suppliers', lager)).status === 403);
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nVerzeichnis-Pflege: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
