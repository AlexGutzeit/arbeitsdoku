// Absturz-Schutz (R2) und Mitarbeiter-Anlage ganz oder gar nicht (R19), 29.09.2026.
//
//   A  Echter Server, Fehler per Sabotage-Trigger in der Test-Datenbank ausgelöst:
//      - scheitert beim Anlegen die Soll-Stunden-Zeile (NACH dem await des Passwort-Hashs, also in einer
//        async-Route): Antwort 500 „Interner Serverfehler", der Server läuft weiter, und es bleibt KEIN halber
//        Mitarbeiter ohne Soll-Stunden zurück (R19);
//      - meldet die Datenbank beim Einfügen eine Namensdopplung (der Wettlauf aus R2): 409, Server läuft;
//      - ein normales Anlegen legt Konto, Soll-Stunden und Anstellung an.
//   B  Prozess-Wächter: unbehandelte Ablehnung → protokolliert, gesichert, läuft weiter; unerwartete Ausnahme
//      → ERST gesichert, dann Ende mit Code 1 (systemd startet neu).
//   C  Express-Absicherung im Einzelnen: async-Fehler → Fehlerbehandlung; synchrone Fehler, normale async-
//      Routen, next() und Fehler-Middleware wie bisher.
//   D  Eingebaut: server.js richtet beides ein; der Zeitplaner fängt die async-Aufgabe mit .catch ab.
//
//   node tests/absturzschutz.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');

const PORT = 3353, PORT_C = 3354, DB = '/tmp/absturzschutz.db', LOG = '/tmp/absturzschutz.log';
const WURZEL = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(port, m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const gesund = (port) => req(port, 'GET', '/health').then(r => r.status === 200, () => false);
const werte = (db, sql, p) => { const s = db.prepare(sql); if (p) s.bind(p); const z = []; while (s.step()) z.push(s.get()); s.free(); return z; };
const eins = (db, sql, p) => (werte(db, sql, p)[0] || [])[0];

(async () => {
  const SQL = await initSqlJs();

  // ── A: echter Server ──────────────────────────────────────────────────────────────────────────
  console.log('A. Echter Server, Fehler per Sabotage-Trigger');
  try { fs.unlinkSync(DB); } catch (_) {}
  // 1) einmal anlegen lassen (Schema + Seed-Passwort), 2) Trigger einbauen, 3) mit Triggern starten
  const erst = spawnSync('node', ['-e', `process.env.DB_PATH=${JSON.stringify(DB)};process.env.JWT_SECRET='x'.repeat(40);
    const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))}); m.initDatabase().then(() => { m.saveToFile(); process.exit(0); });`], { encoding: 'utf8' });
  const pwAdmin = ((erst.stdout || '').match(/admin\s+->\s+(\S+)/) || [])[1];
  {
    const d = new SQL.Database(fs.readFileSync(DB));
    d.run("CREATE TRIGGER r2_soll_scheitert BEFORE INSERT ON user_target_hours WHEN NEW.hours_per_week = 99 BEGIN SELECT RAISE(ABORT, 'Probe: Soll-Stunden scheitern'); END");
    d.run("CREATE TRIGGER r2_wettlauf BEFORE INSERT ON users WHEN NEW.username = 'wettlauf' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.username'); END");
    fs.writeFileSync(DB, Buffer.from(d.export())); d.close();
  }
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: WURZEL, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: ['ignore', lg, lg] });
  let beendet = false;
  try {
    for (let i = 0; i < 200; i++) { if (await gesund(PORT)) break; await sleep(150); }
    const admin = (await req(PORT, 'POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    const neu = (u, extra) => req(PORT, 'POST', '/api/users', admin, { username: u, password: 'Test1234!', name: 'Probe ' + u, role: 'mitarbeiter', ...extra });

    const kaputt = await neu('kaputt', { target_hours_per_week: 99 });
    ok('Soll-Stunden scheitern nach dem await → 500 „Interner Serverfehler" (vorher: Server beendet)',
      kaputt.status === 500 && kaputt.body && kaputt.body.error === 'Interner Serverfehler', JSON.stringify(kaputt));
    await sleep(300);
    ok('… der Server läuft weiter', await gesund(PORT) && srv.exitCode === null);
    const wett = await neu('wettlauf');
    ok('Namensdopplung beim Einfügen (Wettlauf) → 409 „Benutzername bereits vergeben"', wett.status === 409 && /bereits vergeben/.test(wett.body.error || ''), JSON.stringify(wett));
    ok('… und läuft weiter', await gesund(PORT));
    const anna = await neu('anna');
    ok('normales Anlegen → 201', anna.status === 201 && anna.body.user && anna.body.user.id, JSON.stringify(anna.body).slice(0, 120));
    srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r)); beendet = true;
    const d = new SQL.Database(fs.readFileSync(DB));
    ok('KEIN halber Mitarbeiter: „kaputt" fehlt ganz — Konto, Soll-Stunden, Anstellung (R19)',
      eins(d, "SELECT COUNT(*) FROM users WHERE username = 'kaputt'") === 0
        && eins(d, 'SELECT COUNT(*) FROM user_target_hours WHERE user_id NOT IN (SELECT id FROM users)') === 0
        && eins(d, 'SELECT COUNT(*) FROM employment_periods WHERE user_id NOT IN (SELECT id FROM users)') === 0);
    ok('„anna" vollständig: Konto, Soll-Stunden, offene Anstellung',
      eins(d, 'SELECT COUNT(*) FROM user_target_hours WHERE user_id = ?', [anna.body.user.id]) === 1
        && eins(d, 'SELECT COUNT(*) FROM employment_periods WHERE user_id = ? AND end_date IS NULL', [anna.body.user.id]) === 1);
    d.close();
    const log = fs.readFileSync(LOG, 'utf8');
    ok('im Protokoll steht der Fehler (für den Betreiber), kein Absturz', /Probe: Soll-Stunden scheitern/.test(log) && !/unerwartete Ausnahme/.test(log));
  } catch (e) {
    ok('Ablauf A ohne Ausnahme', false, e && e.stack);
  } finally {
    if (!beendet) { srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); }); }
  }

  // ── B: Prozess-Wächter ────────────────────────────────────────────────────────────────────────
  console.log('B. Prozess-Wächter');
  const marke = '/tmp/absturzschutz-gesichert';
  const kind = (ausloesen) => {
    try { fs.unlinkSync(marke); } catch (_) {}
    return spawnSync('node', ['-e', `const a = require(${JSON.stringify(path.join(WURZEL, 'absturzschutz'))});
      a.prozessWaechter({ sichern: () => require('fs').writeFileSync(${JSON.stringify(marke)}, 'ja') });
      ${ausloesen}
      setTimeout(() => { console.log('lebt'); process.exit(0); }, 400);`], { encoding: 'utf8', timeout: 10000 });
  };
  const r1 = kind("Promise.reject(new Error('Probe-Ablehnung'));");
  ok('unbehandelte Ablehnung: läuft weiter, protokolliert, gesichert',
    r1.status === 0 && /lebt/.test(r1.stdout) && /unbehandelte Ablehnung/.test(r1.stderr) && fs.existsSync(marke), JSON.stringify({ s: r1.status, out: r1.stdout, err: r1.stderr.slice(0, 160) }));
  const r2 = kind("setTimeout(() => { throw new Error('Probe-Ausnahme'); }, 10);");
  ok('unerwartete Ausnahme: ERST gesichert, dann Ende mit Code 1 (systemd startet neu)',
    r2.status === 1 && !/lebt/.test(r2.stdout) && /unerwartete Ausnahme/.test(r2.stderr) && fs.existsSync(marke), JSON.stringify({ s: r2.status, err: r2.stderr.slice(0, 160) }));
  try { fs.unlinkSync(marke); } catch (_) {}

  // ── C: Express-Absicherung im Einzelnen ──────────────────────────────────────────────────────
  console.log('C. Express-Absicherung');
  const c = spawn('node', ['-e', `const express = require('express'); require(${JSON.stringify(path.join(WURZEL, 'absturzschutz'))}).asyncRoutenAbsichern();
    const app = express();
    app.get('/health', (q, s) => s.json({ ok: 1 }));
    app.get('/async-wirft', async (q, s) => { await new Promise(r => setTimeout(r, 5)); throw new Error('async-Probe'); });
    app.get('/sync-wirft', (q, s) => { throw new Error('sync-Probe'); });
    app.get('/async-gut', async (q, s) => { await new Promise(r => setTimeout(r, 5)); s.json({ gut: 1 }); });
    app.get('/weiter', async (q, s, n) => { await null; n(); }, (q, s) => s.json({ weiter: 1 }));
    app.use((err, q, s, n) => s.status(500).json({ error: 'Interner Serverfehler', grund: err.message }));
    app.listen(${PORT_C});`], { cwd: WURZEL, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 100; i++) { if (await gesund(PORT_C)) break; await sleep(100); }
    const a = await req(PORT_C, 'GET', '/async-wirft');
    ok('async-Route wirft nach await → Fehlerbehandlung (500), Prozess lebt', a.status === 500 && a.body.grund === 'async-Probe' && await gesund(PORT_C), JSON.stringify(a));
    const s = await req(PORT_C, 'GET', '/sync-wirft');
    ok('synchrone Route wirft → wie bisher 500', s.status === 500 && s.body.grund === 'sync-Probe');
    ok('normale async-Route und next() unverändert', (await req(PORT_C, 'GET', '/async-gut')).body.gut === 1 && (await req(PORT_C, 'GET', '/weiter')).body.weiter === 1);
  } catch (e) { ok('Ablauf C ohne Ausnahme', false, e && e.stack); }
  finally { c.kill('SIGTERM'); await sleep(200); }

  // ── D: eingebaut ──────────────────────────────────────────────────────────────────────────────
  console.log('D. Eingebaut');
  const server = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  ok('server.js richtet beides ein', /absturzschutz\.asyncRoutenAbsichern\(\)/.test(server) && /absturzschutz\.prozessWaechter\(/.test(server));
  ok('der Zeitplaner fängt die async-Aufgabe ab (tick(...).catch)', /tick\(getDb\(\)\)\.catch\(/.test(fs.readFileSync(path.join(WURZEL, 'scheduler.js'), 'utf8')));

  console.log(`\nAbsturz-Schutz: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
