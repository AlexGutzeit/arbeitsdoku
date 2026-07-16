// API-Test (B1): Rollen-Absicherung von POST/PUT /api/users.
// Ein Chef darf keinen Nutzer (und nicht sich selbst) zu 'admin' hochstufen; ungültige Rollen → 400.
// Normale Bearbeitung (Name/Rechte/erlaubte Rollen) bleibt möglich.
//   node tests/user-role-guard.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3218, DB = '/tmp/user-role-guard.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = async (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const roleOf = async (admin, id) => (await req('GET', `/api/users/${id}`, admin)).body.user.role;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/user-role-guard-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/user-role-guard-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const chefLogin = await login('chef', cpw);
    const chef = chefLogin.body.token;
    const chefId = chefLogin.body.user.id;
    const opfer = (await req('POST', '/api/users', admin, { username: 'opfer', password: 'Test1234!', name: 'Opfer', role: 'mitarbeiter' })).body.user;
    ok('Setup: admin + chef Login, MA angelegt', !!(admin && chef && opfer));

    // ── Kern von B1: Chef darf NICHT zu admin hochstufen ──
    let r = await req('PUT', `/api/users/${opfer.id}`, chef, { role: 'admin' });
    ok('Chef → MA auf admin: 403', r.status === 403, 'status=' + r.status);
    ok('Rolle unverändert (mitarbeiter)', (await roleOf(admin, opfer.id)) === 'mitarbeiter');

    r = await req('PUT', `/api/users/${chefId}`, chef, { role: 'admin' });
    ok('Chef → sich selbst auf admin: 403', r.status === 403, 'status=' + r.status);
    ok('Chef-Rolle unverändert (chef)', (await roleOf(admin, chefId)) === 'chef');

    r = await req('PUT', `/api/users/${opfer.id}`, chef, { role: 'superuser' });
    ok('Chef → ungültige Rolle: 400', r.status === 400, 'status=' + r.status);

    r = await req('POST', '/api/users', chef, { username: 'x_admin', password: 'Test1234!', name: 'X', role: 'admin' });
    ok('Chef → POST role=admin: 400 (Regression, war schon so)', r.status === 400, 'status=' + r.status);

    // ── Erlaubtes bleibt erlaubt ──
    r = await req('PUT', `/api/users/${opfer.id}`, chef, { name: 'Opfer Neu', target_hours_per_week: 35 });
    ok('Chef → normale Bearbeitung (Name/Soll, keine Rolle): 200', r.status === 200, 'status=' + r.status);

    r = await req('PUT', `/api/users/${opfer.id}`, chef, { role: 'buchhalter' });
    ok('Chef → erlaubte Rolle (buchhalter): 200', r.status === 200 && (await roleOf(admin, opfer.id)) === 'buchhalter', 'status=' + r.status);

    // ── Admin DARF admin vergeben ──
    r = await req('PUT', `/api/users/${opfer.id}`, admin, { role: 'admin' });
    ok('Admin → MA auf admin: 200', r.status === 200 && (await roleOf(admin, opfer.id)) === 'admin', 'status=' + r.status);

    // ── Folge: da opfer jetzt admin ist, darf der Chef ihn gar nicht mehr bearbeiten (bestehender Guard) ──
    r = await req('PUT', `/api/users/${opfer.id}`, chef, { name: 'egal' });
    ok('Chef → bestehenden Admin bearbeiten: 403 (Guard bleibt)', r.status === 403, 'status=' + r.status);

    // ── B2: Benutzernamen-Eindeutigkeit im PUT ──
    console.log('\nB2 — username-Eindeutigkeit:');
    const u1 = (await req('POST', '/api/users', admin, { username: 'name_a', password: 'Test1234!', name: 'A', role: 'mitarbeiter' })).body.user;
    const u2 = (await req('POST', '/api/users', admin, { username: 'name_b', password: 'Test1234!', name: 'B', role: 'mitarbeiter' })).body.user;
    r = await req('PUT', `/api/users/${u2.id}`, admin, { username: 'name_a' });
    ok('PUT auf bereits vergebenen Benutzernamen: 409', r.status === 409, 'status=' + r.status);
    ok('Benutzername unverändert nach 409', (await req('GET', `/api/users/${u2.id}`, admin)).body.user.username === 'name_b');
    r = await req('PUT', `/api/users/${u2.id}`, admin, { username: 'name_b', name: 'B neu' });
    ok('PUT mit unverändertem eigenen Namen: 200 (kein Fehlalarm)', r.status === 200, 'status=' + r.status);
    r = await req('PUT', `/api/users/${u2.id}`, admin, { username: 'name_c' });
    ok('PUT auf freien Benutzernamen: 200', r.status === 200, 'status=' + r.status);

    // ── S3: der LETZTE aktive Admin darf nicht herabgestuft/ausgestellt werden ──
    console.log('\nS3 — Schutz des letzten Admins:');
    const adminId = (await login('admin', apw)).body.user.id;
    // Aktuell zwei aktive Admins (Seed-admin + opfer). opfer herabstufen ist erlaubt → wieder 1 Admin (Seed).
    r = await req('PUT', `/api/users/${opfer.id}`, admin, { role: 'mitarbeiter' });
    ok('Admin → anderen Admin (nicht der letzte) herabstufen: 200', r.status === 200 && (await roleOf(admin, opfer.id)) === 'mitarbeiter', 'status=' + r.status);
    // Jetzt ist der Seed-admin der einzige Admin: sich selbst herabstufen muss scheitern.
    r = await req('PUT', `/api/users/${adminId}`, admin, { role: 'mitarbeiter' });
    ok('Admin → letzten Admin herabstufen: 400', r.status === 400, 'status=' + r.status);
    ok('Letzter Admin bleibt admin', (await roleOf(admin, adminId)) === 'admin');
    // Und ausstellen des letzten Admins per API ebenfalls nicht.
    r = await req('POST', `/api/users/${adminId}/deactivate`, admin, {});
    ok('Admin → letzten Admin ausstellen: 400', r.status === 400, 'status=' + r.status);
    // Mit einem zweiten Admin ist Herabstufen wieder erlaubt.
    const admin2 = (await req('POST', '/api/users', admin, { username: 'admin2', password: 'Test1234!', name: 'Admin Zwei', role: 'admin' })).body.user;
    r = await req('PUT', `/api/users/${admin2.id}`, admin, { role: 'mitarbeiter' });
    ok('Admin → zweiten Admin (nicht der letzte) herabstufen: 200', r.status === 200 && (await roleOf(admin, admin2.id)) === 'mitarbeiter', 'status=' + r.status);
    // Nicht-letzten Admin ausstellen bleibt erlaubt.
    const admin3 = (await req('POST', '/api/users', admin, { username: 'admin3', password: 'Test1234!', name: 'Admin Drei', role: 'admin' })).body.user;
    r = await req('POST', `/api/users/${admin3.id}/deactivate`, admin, {});
    ok('Admin → zweiten Admin (nicht der letzte) ausstellen: 200', r.status === 200, 'status=' + r.status);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nUser-Role-Guard: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
