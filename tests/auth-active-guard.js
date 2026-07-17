// API-Test (B1): Ein bereits ausgestelltes JWT wird sofort abgelehnt (401), sobald der Nutzer ausgestellt ist —
// auch wenn das Token noch nicht abgelaufen ist. Wiedereinstellen lässt DASSELBE Token wieder greifen.
//   node tests/auth-active-guard.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3220, DB = '/tmp/auth-active-guard.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/auth-active-guard-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/auth-active-guard-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;

    // MA anlegen und als DIESER MA einloggen → sein eigenes Token merken
    const ma = (await req('POST', '/api/users', admin, { username: 'aguard', password: 'Test1234!', name: 'A Guard', role: 'mitarbeiter' })).body.user;
    const maTok = (await login('aguard', 'Test1234!')).body.token;
    ok('Setup: MA angelegt + eingeloggt', !!(ma && maTok));

    // 1) Token funktioniert vor dem Ausstellen
    ok('vor Ausstellen: geschützter Endpunkt 200', (await req('GET', '/api/entries', maTok)).status === 200);

    // 2) MA ausstellen → dasselbe Token muss jetzt 401 liefern
    const deac = await req('POST', `/api/users/${ma.id}/deactivate`, admin, {});
    ok('Ausstellen: 200', deac.status === 200, 'status=' + deac.status);
    const after = await req('GET', '/api/entries', maTok);
    ok('nach Ausstellen: gleiches Token → 401', after.status === 401, 'status=' + after.status);
    ok('401-Meldung nennt Ausstellung', /ausgestellt/i.test((after.body && after.body.error) || ''), JSON.stringify(after.body));

    // 3) Login des Ausgestellten ist ebenfalls gesperrt (bestehendes Verhalten, Gegenprobe)
    ok('Login des Ausgestellten: 403', (await login('aguard', 'Test1234!')).status === 403);

    // 4) Wiedereinstellen → DASSELBE (noch gültige) Token greift wieder.
    //    Wiedereintritt muss NACH dem Austritt (heute) liegen → morgen wählen.
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE');
    const reac = await req('POST', `/api/users/${ma.id}/reactivate`, admin, { start_date: tomorrow });
    ok('Wiedereinstellen: 200', reac.status === 200, 'status=' + reac.status);
    ok('nach Wiedereinstellen: gleiches Token → wieder 200', (await req('GET', '/api/entries', maTok)).status === 200);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nAuth-Active-Guard: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
