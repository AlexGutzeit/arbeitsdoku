// API-Test: Soll-Stunden-Routen validieren valid_from (Nachzug zu B4, gleiche Lösung wie beim Urlaubsanspruch).
//   node tests/targets-date-guard.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3226, DB = '/tmp/targets-date-guard.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/targets-date-guard-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/targets-date-guard-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'sollma', password: 'Test1234!', name: 'Soll MA', role: 'mitarbeiter' })).body.user;
    const body = (vf) => ({ hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 6, valid_from: vf });

    ok('POST targets valid_from Unsinn ("heute") → 400', (await req('POST', `/api/statistics/targets/${ma.id}`, admin, body('heute'))).status === 400);
    ok('POST targets unmöglicher Tag (2024-02-30) → 400', (await req('POST', `/api/statistics/targets/${ma.id}`, admin, body('2024-02-30'))).status === 400);
    ok('POST targets fehlt → 400', (await req('POST', `/api/statistics/targets/${ma.id}`, admin, body(undefined))).status === 400);
    const good = await req('POST', `/api/statistics/targets/${ma.id}`, admin, body('2024-01-01'));
    ok('POST targets gültig (2024-01-01) → 200', good.status === 200, 'status=' + good.status);
    const tid = good.body.targets[0].id;
    ok('PUT targets valid_from Unsinn → 400', (await req('PUT', `/api/statistics/targets/${ma.id}/${tid}`, admin, body('kaputt'))).status === 400);
    ok('PUT targets gültig → 200', (await req('PUT', `/api/statistics/targets/${ma.id}/${tid}`, admin, body('2024-02-01'))).status === 200);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nTargets-Date-Guard: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
