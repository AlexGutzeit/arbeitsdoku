// Drei kleine Punkte der Bugliste v7 (29.09.2026):
//   R15  Auszahlungen: gespeichert wird überall der ANZEIGENAME (vorher beim Bestätigen/Ablehnen/Zurückziehen
//        der Benutzername); „Wirksam ab" muss ein kalendarisch gültiges Datum sein („2026-02-31" → 400).
//   R16  Urlaubsübersicht: „Stand:" in deutscher Ortszeit. Der Server läuft dafür auf 00:30 Uhr nachts
//        (tests/hilfen/uhr-stellen.js) — genau dann zeigte UTC noch den Vortag.
//   R17  Löschen hinterlässt eine Spur im Protokoll: Aushang und Bestellung per Knopf, dazu das automatische
//        Aufräumen (abgelaufene Aushänge, bestellte Bestellungen nach einem Monat).
//
//   node tests/bugliste-r15-r16-r17.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');

const PORT = 3355, DB = '/tmp/bugliste-r15.db', LOG = '/tmp/bugliste-r15.log';
const WURZEL = path.join(__dirname, '..');
// 22:30 UTC am 30.09. = 00:30 Uhr am 01.10. in Berlin (Sommerzeit)
const NACHT = '2026-09-30T22:30:00Z', HEUTE_BERLIN = '2026-10-01', VORTAG_UTC = '2026-09-30';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  const SQL = await initSqlJs();
  try { fs.unlinkSync(DB); } catch (_) {}
  // Anlegen lassen, dann Altbestand fürs automatische Aufräumen hineinlegen (per Oberfläche nicht herstellbar)
  const erst = spawnSync('node', ['-e', `process.env.DB_PATH=${JSON.stringify(DB)};process.env.JWT_SECRET='x'.repeat(40);
    const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))}); m.initDatabase().then(() => { m.saveToFile(); process.exit(0); });`], { encoding: 'utf8' });
  const pwAdmin = ((erst.stdout || '').match(/admin\s+->\s+(\S+)/) || [])[1];
  {
    const d = new SQL.Database(fs.readFileSync(DB));
    const admin = d.exec("SELECT id FROM users WHERE username='admin'")[0].values[0][0];
    d.run("INSERT INTO bulletin_entries (created_by, title, text, auto_delete_date) VALUES (?, 'Sommerfest', '', '2026-09-15')", [admin]);
    d.run("INSERT INTO orders (user_id, product, quantity, ordered_at, ordered_by) VALUES (?, 'Altlast-Dübel', 5, '2026-01-01 10:00:00', ?)", [admin, admin]);
    fs.writeFileSync(DB, Buffer.from(d.export())); d.close();
  }
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['--require', path.join(__dirname, 'hilfen', 'uhr-stellen.js'), 'server.js'], { cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, FESTE_UHR: NACHT }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', pwAdmin);
    const id = {}, t = {};
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'], ['tom', 'Tom Kraus', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }

    console.log('R16 · Urlaubsübersicht „Stand:" um 00:30 Uhr');
    const ue = await req('GET', '/api/absences/vacation-overview?year=2026', t.carla);
    ok(`„Stand" ist der ${HEUTE_BERLIN} (Ortszeit), nicht der ${VORTAG_UTC} (UTC)`, ue.status === 200 && ue.body.stand === HEUTE_BERLIN, JSON.stringify({ s: ue.status, stand: ue.body && ue.body.stand }));

    console.log('R15 · Auszahlungen');
    const falsch = await req('POST', '/api/payouts', t.carla, { user_id: id.anna, stunden: 4, wirksam_ab: '2026-02-31' });
    ok('„Wirksam ab 2026-02-31" wird abgelehnt (400)', falsch.status === 400, JSON.stringify(falsch));
    const a1 = await req('POST', '/api/payouts', t.carla, { user_id: id.anna, stunden: 4, wirksam_ab: HEUTE_BERLIN });
    ok('gültiges Datum wird angenommen', a1.status === 201, JSON.stringify(a1.body).slice(0, 200));
    ok('angelegt von: Anzeigename „Carla Chef"', a1.body.auszahlung && a1.body.auszahlung.created_by_name === 'Carla Chef', JSON.stringify(a1.body.auszahlung));
    const best = await req('POST', `/api/payouts/${a1.body.auszahlung.id}/bestaetigen`, t.anna, {});
    ok('bestätigt von: Anzeigename „Anna Berger" (vorher „anna")', best.status === 200 && best.body.auszahlung.entschieden_von_name === 'Anna Berger', JSON.stringify(best.body).slice(0, 200));
    const a2 = await req('POST', '/api/payouts', t.carla, { user_id: id.tom, stunden: 2, wirksam_ab: HEUTE_BERLIN });
    await req('POST', `/api/payouts/${a2.body.auszahlung.id}/zurueckziehen`, t.carla, {});
    const liste = (await req('GET', `/api/payouts?user_id=${id.tom}`, t.carla)).body.auszahlungen || [];
    const zurueck = liste.find(z => z.id === a2.body.auszahlung.id);
    ok('zurückgezogen von: Anzeigename „Carla Chef" (vorher „carla")', zurueck && zurueck.entschieden_von_name === 'Carla Chef', JSON.stringify(zurueck));

    console.log('R17 · Löschen im Protokoll');
    const brett = await req('GET', '/api/bulletin', t.anna);   // räumt dabei Abgelaufenes ab
    ok('abgelaufener Aushang „Sommerfest" ist weg', !JSON.stringify(brett.body).includes('Sommerfest'));
    const aushang = (await req('POST', '/api/bulletin', t.carla, { title: 'Grillfest', text: 'Freitag' })).body;
    const aushangId = aushang.id || (aushang.entry && aushang.entry.id);
    ok('Aushang löschen per Knopf', (await req('DELETE', `/api/bulletin/${aushangId}`, t.carla)).status === 200);
    const best1 = (await req('POST', '/api/orders', t.anna, { product: 'Kabelbinder', quantity: 2, unit: 'Pack' })).body;
    const bestId = best1.id || (best1.order && best1.order.id);
    await req('GET', '/api/orders', t.carla);   // räumt dabei alte bestellte ab
    ok('Bestellung löschen per Knopf', (await req('DELETE', `/api/orders/${bestId}`, t.anna)).status === 200);
    const prot = ((await req('GET', '/api/audit?limit=200', admin)).body.logs || []);
    const finde = (aktion) => prot.filter(l => l.action === aktion);
    ok('„Aushang gelöscht: „Grillfest"", von carla', finde('bulletin_delete').some(l => l.username === 'carla' && /Grillfest/.test(l.details)), JSON.stringify(finde('bulletin_delete')));
    ok('„1 Aushang nach Ablauf entfernt: „Sommerfest"", vom System', finde('bulletin_ablauf').some(l => l.username === 'System' && /Sommerfest/.test(l.details)), JSON.stringify(finde('bulletin_ablauf')));
    ok('„Bestellung gelöscht: 2 Pack Kabelbinder (für Anna Berger, noch offen)", von anna',
      finde('order_delete').some(l => l.username === 'anna' && l.details === 'Bestellung gelöscht: 2 Pack Kabelbinder (für Anna Berger, noch offen)'), JSON.stringify(finde('order_delete')));
    ok('„1 bestellte Bestellung nach einem Monat entfernt", vom System', finde('order_aufgeraeumt').some(l => l.username === 'System' && /^1 bestellte Bestellung/.test(l.details)), JSON.stringify(finde('order_aufgeraeumt')));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nBugliste R15/R16/R17: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
