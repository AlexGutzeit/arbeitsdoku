// Abwaertskompatibilitaet des Arbeitsbeginns — der Aussperr-Fall.
//
// work_start wird in middleware/auth.js bei JEDER Anfrage mitgelesen. Fehlt die Spalte nach dem
// Wiederherstellen eines alten Backups und greift die Restore-Migration nicht, schlaegt dieser SELECT
// fehl und sperrt ALLE Nutzer aus — nicht nur den Arbeitsbeginn.
//
// Der Test entfernt die Spalte auf einer ARBEITSKOPIE der Produktivdaten und prueft, dass die App
// sauber hochzieht und die Anmeldung weiter funktioniert. Nur lesend gegenueber der Quelle.
//   node tests/arbeitsbeginn-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3157, QUELLE = '/tmp/prodklon.db', DB = '/tmp/arbeitsbeginn-klon.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const hole = (pfad, token) => new Promise(res => {
  const r = http.request({ host: 'localhost', port: PORT, path: pfad, headers: token ? { Authorization: 'Bearer ' + token } : {} },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
  r.on('error', () => res({ status: 0 })); r.end();
});

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test uebersprungen.'); process.exit(0); }
  fs.copyFileSync(QUELLE, DB);
  const pruefsumme = require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');

  const SQL = await initSqlJs();
  {
    const d = new SQL.Database(fs.readFileSync(DB));
    if (d.exec("PRAGMA table_info(users)")[0].values.some(v => v[1] === 'work_start')) {
      try { d.run("ALTER TABLE users DROP COLUMN work_start"); } catch (e) { console.log('  Hinweis:', e.message); }
      fs.writeFileSync(DB, Buffer.from(d.export()));
    }
    d.close();
  }
  const vor = new SQL.Database(fs.readFileSync(DB));
  const spalten = vor.exec("PRAGMA table_info(users)")[0].values.map(v => v[1]);
  const [adminId, adminName] = vor.exec("SELECT id, name FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
  const alleIds = vor.exec("SELECT id FROM users")[0].values.map(v => v[0]);
  vor.close();
  ok('Arbeitskopie hat die Spalte NICHT (alter Datenstand nachgestellt)', !spalten.includes('work_start'));
  console.log(`  ${alleIds.length} Nutzer, angemeldet als ${adminName}`);

  const lg = fs.openSync('/tmp/arbeitsbeginn-klon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { const h = await hole('/health'); if (h.status === 200) break; await sleep(250); }
    ok('Server startet auf dem alten Datenstand', (await hole('/health')).status === 200);
    ok('Migration lief automatisch', /work_start/.test(fs.readFileSync('/tmp/arbeitsbeginn-klon-srv.log', 'utf8')),
      fs.readFileSync('/tmp/arbeitsbeginn-klon-srv.log', 'utf8').split('\n').filter(l => /Migration/.test(l)).join(' | ').slice(0, 160));

    // DER Aussperr-Fall: authenticate laeuft bei jeder Anfrage. Fuer JEDEN Nutzer pruefen.
    let ausgesperrt = [];
    for (const id of alleIds) {
      const t = jwt.sign({ userId: id, role: 'mitarbeiter' }, SECRET, { expiresIn: '1h' });
      const me = await hole('/api/auth/me', t);
      if (me.status !== 200 && me.status !== 401) ausgesperrt.push(`${id}:${me.status}`);
      else if (me.status === 200 && !('work_start' in (me.body.user || {}))) ausgesperrt.push(`${id}: work_start fehlt`);
    }
    ok(`kein Nutzer ausgesperrt (${alleIds.length} geprüft, alle liefern den Arbeitsbeginn)`,
      ausgesperrt.length === 0, ausgesperrt.slice(0, 5).join(', '));

    const t = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '1h' });
    // Bestandsnutzer sollen NICHTS Eigenes haben: leer bedeutet „es gilt der Firmenwert". Stuende hier
    // bei jedem fest 07:00, wuerde eine spaetere Umstellung der Firmenvorgabe bei NIEMANDEM greifen.
    const liste = await hole('/api/users', t);
    const mitEigenem = ((liste.body && liste.body.users) || []).filter(u => u.work_start);
    ok('Bestandsnutzer haben keinen eigenen Wert (folgen der Firma)',
      liste.status === 200 && mitEigenem.length === 0,
      mitEigenem.map(u => `${u.name}=${u.work_start}`).slice(0, 4).join(', '));

    const vorgaben = await hole('/api/settings/arbeitszeit', t);
    ok('Firmenvorgabe greift: 07:00 / 8 h / 30 min',
      vorgaben.status === 200
      && vorgaben.body.arbeitszeit.work_start_default === '07:00'
      && Number(vorgaben.body.arbeitszeit.work_hours_per_day) === 8
      && Number(vorgaben.body.arbeitszeit.break_minutes_default) === 30,
      JSON.stringify(vorgaben.body));

    // Bestehende Funktionen unberuehrt
    for (const pfad of ['/api/statistics?period=month&date=2026-07-15', '/api/entries?date_from=2026-07-01&date_to=2026-07-31']) {
      ok(`weiterhin erreichbar: ${pfad.split('?')[0]}`, (await hole(pfad, t)).status === 200);
    }
  } finally { srv.kill('SIGTERM'); await sleep(1200); }

  ok('Ausgangskopie unberührt',
    require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex') === pruefsumme);
  console.log(`\nArbeitsbeginn am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  try { fs.unlinkSync(DB); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
