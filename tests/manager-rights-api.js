// API-Test (#9): Beim Anlegen/Bearbeiten werden die Einzelrecht-Flags (can_plan/can_plan_all/
// can_bulletin/can_upload) für Chef/Admin serverseitig auf 0 gehalten; Mitarbeiter behalten sie.
//   node tests/manager-rights-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3219, DB = '/tmp/manager-rights-api.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const flagsOf = async (admin, id) => { const u = (await req('GET', `/api/users/${id}`, admin)).body.user; return { p: u.can_plan, pa: u.can_plan_all, b: u.can_bulletin, u: u.can_upload }; };
const allZero = f => f.p === 0 && f.pa === 0 && f.b === 0 && f.u === 0;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/manager-rights-api-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/manager-rights-api-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    ok('Setup: admin-Login', !!admin);

    // 1) Chef ANLEGEN mit gesetzten Einzelrechten → alle 0
    const chef = (await req('POST', '/api/users', admin, { username: 'chef9', password: 'Test1234!', name: 'Chef Neun', role: 'chef', can_plan: true, can_plan_all: true, can_bulletin: true, can_upload: true })).body.user;
    ok('Chef anlegen: Flags direkt in Antwort 0', chef && allZero({ p: chef.can_plan, pa: chef.can_plan_all, b: chef.can_bulletin, u: chef.can_upload }), JSON.stringify(chef));
    ok('Chef anlegen: Flags in DB 0', allZero(await flagsOf(admin, chef.id)));

    // 2) Admin ANLEGEN mit Flags → alle 0
    const adm = (await req('POST', '/api/users', admin, { username: 'admin9', password: 'Test1234!', name: 'Admin Neun', role: 'admin', can_plan: true, can_bulletin: true })).body.user;
    ok('Admin anlegen: Flags 0', allZero(await flagsOf(admin, adm.id)));

    // 3) Mitarbeiter ANLEGEN mit Rechten → behält sie
    const ma = (await req('POST', '/api/users', admin, { username: 'ma9', password: 'Test1234!', name: 'MA Neun', role: 'mitarbeiter', can_plan: true, can_bulletin: true })).body.user;
    let f = await flagsOf(admin, ma.id);
    ok('Mitarbeiter anlegen: can_plan/can_bulletin behalten (1)', f.p === 1 && f.b === 1, JSON.stringify(f));

    // 4) Mitarbeiter → Chef HOCHSTUFEN nullt die Flags
    await req('PUT', `/api/users/${ma.id}`, admin, { role: 'chef' });
    ok('MA→Chef: Flags jetzt 0', allZero(await flagsOf(admin, ma.id)));

    // 5) Zurück zu Mitarbeiter: Flags bleiben 0 (werden nicht magisch wiederhergestellt)
    await req('PUT', `/api/users/${ma.id}`, admin, { role: 'mitarbeiter' });
    ok('Chef→MA zurück: Flags bleiben 0', allZero(await flagsOf(admin, ma.id)));

    // 6) Als Mitarbeiter Recht wieder explizit setzen klappt
    await req('PUT', `/api/users/${ma.id}`, admin, { can_plan: true });
    ok('MA: can_plan wieder setzbar (1)', (await flagsOf(admin, ma.id)).p === 1);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nManager-Rights-API: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
