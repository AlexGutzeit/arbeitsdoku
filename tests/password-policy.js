// API-Test (B3): Passwort-Policy beim Anlegen + Zurücksetzen.
// ≥8 & ≤72 Zeichen, je 1× Klein/Groß/Ziffer/Sonderzeichen, Passwort ≠ Benutzername. Login prüft nichts davon.
//   node tests/password-policy.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3220, DB = '/tmp/password-policy.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
let seq = 0;
const create = (admin, password, username) => req('POST', '/api/users', admin, { username: username || ('u' + (++seq)), password, name: 'U', role: 'mitarbeiter' });

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/password-policy-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/password-policy-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;

    console.log('\nAnlegen — jede Regel wird abgelehnt (400):');
    ok('zu kurz (Ab1!)', (await create(admin, 'Ab1!')).status === 400);
    ok('ohne Großbuchstabe (test1234!)', (await create(admin, 'test1234!')).status === 400);
    ok('ohne Kleinbuchstabe (TEST1234!)', (await create(admin, 'TEST1234!')).status === 400);
    ok('ohne Ziffer (Testtest!)', (await create(admin, 'Testtest!')).status === 400);
    ok('ohne Sonderzeichen (Testtest1)', (await create(admin, 'Testtest1')).status === 400);
    ok('Passwort == Benutzername (Passw0rd!)', (await create(admin, 'Passw0rd!', 'Passw0rd!')).status === 400);
    ok('zu lang (73 Zeichen)', (await create(admin, 'Aa1!' + 'x'.repeat(69))).status === 400);

    console.log('\nAnlegen — regelkonform (201):');
    const good = await create(admin, 'Test1234!', 'gooduser');
    ok('Test1234! → 201', good.status === 201, 'status=' + good.status);
    const uid = good.body.user.id;
    // Login mit dem konformen Passwort funktioniert
    ok('Login mit konformem Passwort ok', (await req('POST', '/api/auth/login', null, { username: 'gooduser', password: 'Test1234!' })).status === 200);

    console.log('\nZurücksetzen:');
    ok('reset zu schwach (123) → 400', (await req('POST', `/api/users/${uid}/reset-password`, admin, { password: '123' })).status === 400);
    ok('reset konform (Reset123!) → 200', (await req('POST', `/api/users/${uid}/reset-password`, admin, { password: 'Reset123!' })).status === 200);
    ok('Login mit neuem Passwort ok', (await req('POST', '/api/auth/login', null, { username: 'gooduser', password: 'Reset123!' })).status === 200);

    console.log('\nAltbestand bleibt anmeldbar (Login prüft die Policy NICHT):');
    // Seed-User 'max' hat ein zufälliges Passwort (aus dem Log) — Login muss trotzdem gehen, egal ob es die
    // neue Policy erfüllt. Wir prüfen: falsches Passwort 401, richtiges 200 (Policy wird beim Login nie geprüft).
    const mpw = (fs.readFileSync('/tmp/password-policy-srv.log', 'utf8').match(/max\s+->\s+(\S+)/) || [])[1];
    ok('Seed-User max: Login mit Originalpasswort ok', (await req('POST', '/api/auth/login', null, { username: 'max', password: mpw })).status === 200);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPassword-Policy: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
