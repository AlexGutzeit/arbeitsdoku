// Audit-Events-Test: prüft, dass login_success, logout (manuell), session_expired (abgelaufenes
// Token) und settings_update tatsächlich ins Audit-Log geschrieben werden.
// Start:  node tests/audit-events.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const PORT = 3095;
const DB = '/tmp/audit-events-test.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';

function req(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

async function auditCount(token, action) {
  const r = await req('GET', '/api/audit?action=' + action, token);
  return r.body && typeof r.body.total === 'number' ? r.body.total : -1;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/audit-events-srv.log', 'w');
  const srv = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET },
    stdio: ['ignore', log, log],
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {}
      await sleep(150);
    }
    const pw = (fs.readFileSync('/tmp/audit-events-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: pw });
    const token = login.body && login.body.token;
    const adminId = login.body && login.body.user && login.body.user.id;
    ok('Login als admin', !!token && !!adminId);

    ok('login_success protokolliert', (await auditCount(token, 'login_success')) >= 1);

    // Manueller Logout (Token bleibt bei stateless JWT gueltig)
    const lo = await req('POST', '/api/auth/logout', token);
    ok('POST /api/auth/logout ok', lo.status === 200 && lo.body.success === true);
    ok('logout protokolliert', (await auditCount(token, 'logout')) >= 1);

    // Abgelaufenes Token → 401 + session_expired
    const expired = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '-10s' });
    const me = await req('GET', '/api/auth/me', expired);
    ok('Abgelaufenes Token → 401', me.status === 401, String(me.status));
    await sleep(50);
    ok('session_expired protokolliert', (await auditCount(token, 'session_expired')) >= 1);

    // Dedup: zweiter Request mit abgelaufenem Token erzeugt KEINEN zweiten Eintrag (5-Min-Sperre)
    const before = await auditCount(token, 'session_expired');
    await req('GET', '/api/auth/me', expired);
    await sleep(50);
    const after = await auditCount(token, 'session_expired');
    ok('session_expired dedupliziert (kein Spam)', after === before, `${before} → ${after}`);

    // Einstellungen ändern → settings_update
    const up = await req('PUT', '/api/settings', token, { company_name: 'Test GmbH ' + Date.now() });
    ok('PUT /api/settings ok', up.status === 200);
    ok('settings_update protokolliert', (await auditCount(token, 'settings_update')) >= 1);

    // Unveraenderter PUT erzeugt KEINEN settings_update (kein Diff)
    const same = await req('GET', '/api/settings', token);
    const curName = same.body && same.body.settings && same.body.settings.company_name;
    const c1 = await auditCount(token, 'settings_update');
    await req('PUT', '/api/settings', token, { company_name: curName });
    const c2 = await auditCount(token, 'settings_update');
    ok('settings_update nur bei echter Änderung', c2 === c1, `${c1} → ${c2}`);

  } finally {
    srv.kill('SIGTERM');
  }
  console.log(`\nAudit-Events: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
