// Auftrags-Kategorien: „Kleinarbeiten", „PV", „Zählerschrank" … (Alex, 15.09.2026)
//
// Ein Auftrag kann Mitarbeitern UND Kategorien zugeordnet sein — beides unabhängig voneinander.
// Diese Datei prüft den Serverteil; die drei Board-Ansichten (Alle / Mitarbeiter / Kategorien)
// stehen in tests/auftrags-kategorien-ui.js.
//
// WAS HIER BESONDERS ZÄHLT:
//
//  * Auftrags-Kategorien sind NICHT die Produkt-Kategorien im Lager. Gleicher Name, andere Sache
//    (Art der Arbeit vs. Art der Ware). Beide Tabellen dürfen sich nicht sehen — dafür gibt es
//    unten eine eigene Zusicherung.
//  * Ein PUT ohne `category_ids` darf die Zuordnungen NICHT löschen. Sonst räumte jedes Umschalten
//    der Dringlichkeit still die Kategorien ab.
//  * Doppel werden hier ABGEWIESEN, nicht bloss gewarnt: Zwei Kategorien „PV" und „p.v." wären
//    zwei Spalten für dieselbe Sache.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//
//   node tests/auftrags-kategorien.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/auftrags-kategorien.db';
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
  for (const [pfad, mod] of [['/api/auth', 'auth'], ['/api/users', 'users'], ['/api/projects', 'projects'],
    ['/api/products', 'products']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: PWSEED })).body.token;
    const admin = await an('admin'), chef = await an('chef'), max = await an('max');
    const maxId = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;

    console.log('── Anlegen, umbenennen, Doppel abweisen ──');
    const pv = await req('POST', '/api/projects/kategorien', chef, { name: 'PV' });
    ok('der Chef legt eine Kategorie an', pv.status === 201 && pv.body.kategorie.name === 'PV',
      pv.status + ' ' + pv.text.slice(0, 80));
    ok('… ein Mitarbeiter darf das nicht',
      (await req('POST', '/api/projects/kategorien', max, { name: 'Heimlich' })).status === 403);
    ok('… ein zu kurzer Name wird abgewiesen',
      (await req('POST', '/api/projects/kategorien', chef, { name: 'X' })).status === 400);
    const doppelt = await req('POST', '/api/projects/kategorien', chef, { name: 'p.v.' });
    ok('„p.v." gilt als dasselbe wie „PV" und wird abgewiesen', doppelt.status === 409,
      doppelt.status + ' ' + doppelt.text.slice(0, 80));
    const zaehler = (await req('POST', '/api/projects/kategorien', chef, { name: 'Zählerschrank' })).body.kategorie;
    const klein = (await req('POST', '/api/projects/kategorien', chef, { name: 'Kleinarbeiten' })).body.kategorie;
    ok('drei Kategorien stehen in der Liste',
      (await req('GET', '/api/projects/kategorien', max)).body.kategorien.length === 3);
    const um = await req('PUT', `/api/projects/kategorien/${klein.id}`, chef, { name: 'Kleinaufträge' });
    ok('umbenennen geht', um.status === 200 && um.body.kategorie.name === 'Kleinaufträge', um.text.slice(0, 80));
    ok('… aber nicht auf einen belegten Namen',
      (await req('PUT', `/api/projects/kategorien/${klein.id}`, chef, { name: 'PV' })).status === 409);

    console.log('\n── Ein Auftrag kann beides: Mitarbeiter UND Kategorien ──');
    const a1 = await req('POST', '/api/projects', chef, { name: 'Halle 3 Dach',
      assigned_user_ids: [maxId], category_ids: [pv.body.kategorie.id, zaehler.id] });
    ok('Auftrag mit einem MA und zwei Kategorien angelegt', a1.status === 201, a1.status + ' ' + a1.text.slice(0, 90));
    ok('… der Mitarbeiter steht dran', (a1.body.project.assigned_users || []).length === 1);
    ok('… und beide Kategorien auch',
      (a1.body.project.categories || []).map(c => c.name).sort().join('|') === 'PV|Zählerschrank',
      JSON.stringify((a1.body.project.categories || []).map(c => c.name)));

    const a2 = await req('POST', '/api/projects', chef, { name: 'Nur Kategorie', category_ids: [pv.body.kategorie.id] });
    ok('ein Auftrag NUR mit Kategorie geht', a2.status === 201
      && (a2.body.project.assigned_users || []).length === 0
      && (a2.body.project.categories || []).length === 1, a2.text.slice(0, 90));

    // DIE ZUSICHERUNG, die am ehesten bricht: ein PUT ohne category_ids.
    const nurDringlichkeit = await req('PUT', `/api/projects/${a1.body.project.id}`, chef, { urgency: 'rot' });
    ok('ein PUT OHNE category_ids lässt die Zuordnungen stehen',
      nurDringlichkeit.status === 200 && (nurDringlichkeit.body.project.categories || []).length === 2,
      JSON.stringify((nurDringlichkeit.body.project.categories || []).map(c => c.name)));
    const geleert = await req('PUT', `/api/projects/${a1.body.project.id}`, chef, { category_ids: [] });
    ok('… mit leerer Liste werden sie bewusst entfernt', (geleert.body.project.categories || []).length === 0);
    await req('PUT', `/api/projects/${a1.body.project.id}`, chef, { category_ids: [pv.body.kategorie.id, zaehler.id] });

    ok('eine erfundene Kategorie-ID wird stillschweigend ignoriert (keine Leiche in der Tabelle)',
      (await req('PUT', `/api/projects/${a2.body.project.id}`, chef,
        { category_ids: [pv.body.kategorie.id, 999999] })).body.project.categories.length === 1);

    console.log('\n── Löschen: die Aufträge bleiben ──');
    const wehrt = await req('DELETE', `/api/projects/kategorien/${pv.body.kategorie.id}`, chef);
    ok('eine belegte Kategorie wird nicht ohne Rückfrage gelöscht', wehrt.status === 409, String(wehrt.status));
    ok('… und die Meldung nennt die Zahl', wehrt.body.anzahl === 2, JSON.stringify(wehrt.body));
    ok('… in richtiger Mehrzahl („2 Aufträge", nicht „2 Auftrag/Aufträge")',
      /hängen noch 2 Aufträge\./.test(wehrt.body.error), wehrt.body.error);
    // Gegenprobe Einzahl: ein einziger Auftrag darf nicht „1 Aufträge" heissen.
    const einzeln = (await req('POST', '/api/projects/kategorien', chef, { name: 'Einzelfall' })).body.kategorie;
    await req('POST', '/api/projects', chef, { name: 'Ein Auftrag', category_ids: [einzeln.id] });
    const einer = await req('DELETE', `/api/projects/kategorien/${einzeln.id}`, chef);
    ok('… und in richtiger Einzahl („hängt noch 1 Auftrag")',
      /hängt noch 1 Auftrag\. Bestätige, dass er/.test(einer.body.error), einer.body.error);
    const weg = await req('DELETE', `/api/projects/kategorien/${pv.body.kategorie.id}`, chef, { loesen: true });
    ok('… mit Bestätigung geht es', weg.status === 200, weg.text.slice(0, 80));
    const nachher = (await req('GET', '/api/projects', chef)).body.projects;
    ok('… die Aufträge existieren weiter', nachher.length >= 2, String(nachher.length));
    ok('… nur ohne diese Kategorie',
      !nachher.some(p => (p.categories || []).some(c => c.name === 'PV')),
      JSON.stringify(nachher.map(p => [p.name, (p.categories || []).map(c => c.name)])));
    ok('… „Zählerschrank" hängt aber noch dran',
      nachher.find(p => p.name === 'Halle 3 Dach').categories.some(c => c.name === 'Zählerschrank'));
    ok('… und der Vorgang steht im Protokoll',
      db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'project_category_delete'").get().c === 1);

    console.log('\n── Getrennt von den Produkt-Kategorien ──');
    // Beide heissen „Kategorie", haben aber nichts miteinander zu tun. Ein gemeinsamer Topf waere
    // der naheliegende und falsche Schritt.
    await req('POST', '/api/products/kategorien', admin, { name: 'Zählerschrank' });
    const produktKats = (await req('GET', '/api/products/verzeichnis', admin)).body.kategorien.map(k => k.name);
    const auftragsKats = (await req('GET', '/api/projects/kategorien', admin)).body.kategorien.map(k => k.name);
    ok('derselbe Name darf in beiden Welten stehen',
      produktKats.includes('Zählerschrank') && auftragsKats.includes('Zählerschrank'),
      JSON.stringify({ produktKats, auftragsKats }));
    const pkZeile = db.prepare("SELECT id FROM product_categories WHERE name = 'Zählerschrank'").all();
    const akZeile = db.prepare("SELECT id FROM project_categories WHERE name = 'Zählerschrank' AND deleted_at IS NULL").all();
    ok('… es sind zwei verschiedene Tabellen mit je einer eigenen Zeile',
      pkZeile.length === 1 && akZeile.length === 1,
      JSON.stringify({ produkt: pkZeile, auftrag: akZeile }));
    // Gegenprobe: Die Produkt-Kategorie zu loeschen darf die Auftrags-Kategorie nicht beruehren.
    const pk = (await req('GET', '/api/products/verzeichnis', admin)).body.kategorien.find(k => k.name === 'Zählerschrank');
    await req('DELETE', `/api/products/kategorien/${pk.id}`, admin);
    ok('… und das Löschen der einen lässt die andere unberührt',
      (await req('GET', '/api/projects/kategorien', admin)).body.kategorien.some(k => k.name === 'Zählerschrank'));

  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nAuftrags-Kategorien: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
