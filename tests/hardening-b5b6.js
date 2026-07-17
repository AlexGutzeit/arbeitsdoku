// API-Test (B5 + B6):
//  B5a: Admin darf Einträge nur für existierende, aktive Nicht-Admins anlegen (ungültige user_id → 400).
//  B5b: start_overtime muss eine Zahl sein (negativ erlaubt); "abc" → 400.
//  B6:  Beim Anlegen wird "heute" in Europe/Berlin bestimmt (valid_from der Soll-Stunden = Berlin-heute).
//   node tests/hardening-b5b6.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3221, DB = '/tmp/hardening-b5b6.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/hardening-b5b6-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/hardening-b5b6-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const adminId = (await login('admin', apw)).body.user.id;

    // ── B6: Anstellungs-/Soll-„heute" = Berlin-heute ──
    console.log('B6 — Zeitzone (Berlin) beim Anlegen:');
    const ma = (await req('POST', '/api/users', admin, { username: 'b6ma', password: 'Test1234!', name: 'B6 MA', role: 'mitarbeiter' })).body.user;
    const targets = (await req('GET', `/api/statistics/targets/${ma.id}`, admin)).body;
    const firstValidFrom = (targets.targets || targets || [])[0] && ((targets.targets || targets)[0].valid_from);
    ok('Soll-Stunden valid_from == Berlin-heute', firstValidFrom === today, `ist ${firstValidFrom}, erwartet ${today}`);

    // ── B5a: Admin-Eintrag nur für gültige MA ──
    console.log('B5a — Eintrag-user_id-Prüfung (Admin):');
    ok('gültiger MA → 201', (await req('POST', '/api/entries', admin, { user_id: ma.id, date: today, time_from: '08:00', time_to: '12:00' })).status === 201);
    ok('nicht existierende user_id → 400', (await req('POST', '/api/entries', admin, { user_id: 999999, date: today, time_from: '08:00', time_to: '12:00' })).status === 400);
    ok('user_id = Admin selbst → 400 (kein MA)', (await req('POST', '/api/entries', admin, { user_id: adminId, date: today, time_from: '08:00', time_to: '12:00' })).status === 400);
    // Ausgestellten MA ablehnen
    await req('POST', `/api/users/${ma.id}/deactivate`, admin, {});
    ok('ausgestellter MA → 400', (await req('POST', '/api/entries', admin, { user_id: ma.id, date: today, time_from: '08:00', time_to: '12:00' })).status === 400);

    // ── B5b: start_overtime-Zahlcheck ──
    console.log('B5b — start_overtime-Validierung:');
    const u2 = (await req('POST', '/api/users', admin, { username: 'b5u', password: 'Test1234!', name: 'B5 U', role: 'mitarbeiter', start_overtime: -3 })).body.user;
    ok('Anlegen mit negativem start_overtime (-3) → erlaubt', !!u2);
    ok('PUT start_overtime = "abc" → 400', (await req('PUT', `/api/users/${u2.id}`, admin, { start_overtime: 'abc' })).status === 400);
    ok('PUT start_overtime = -7.5 → 200 (negativ erlaubt)', (await req('PUT', `/api/users/${u2.id}`, admin, { start_overtime: -7.5 })).status === 200);
    ok('POST Anlegen mit start_overtime = "xyz" → 400', (await req('POST', '/api/users', admin, { username: 'b5bad', password: 'Test1234!', name: 'Bad', role: 'mitarbeiter', start_overtime: 'xyz' })).status === 400);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nHardening-B5B6: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
