// Anmelde-Bremsen: nach 10 Fehlversuchen kommt 429 mit deutscher Meldung — Login je Adresse, Code-Bestätigung je Konto.
//
// Hängt an express-rate-limit. Bis 24.10.2026 prüfte kein Test, ob die Bremse überhaupt greift; aufgefallen beim
// Update 8.5.1 → 8.7.1 (8.6.0 führt die eingebauten Selbstprüfungen anders aus — die würden ihre Warnungen
// „ERR_ERL_…" ins Server-Protokoll schreiben, etwa zu den eigenen keyGenerator-Funktionen).
//   node tests/anmelde-bremse.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3379, DB = '/tmp/anmelde-bremse.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const LOG = '/tmp/anmelde-bremse-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// `vonAdresse` setzt X-Forwarded-For — der Server vertraut genau einem Proxy (trust proxy 1), so wie hinter Caddy.
function req(method, p, { token, body, vonAdresse } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(vonAdresse ? { 'X-Forwarded-For': vonAdresse } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, kopf: res.headers }); }); });
    r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const pw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];

    console.log('── Login: 10 Fehlversuche je Adresse, dann 429 ──');
    const A = '203.0.113.7', B = '2001:db8::42';
    let r;
    for (let i = 1; i <= 10; i++) r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'falsch' + i }, vonAdresse: A });
    ok('10. Fehlversuch → noch 401', r.status === 401, String(r.status));
    r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'falsch' }, vonAdresse: A });
    ok('11. Versuch → 429', r.status === 429, String(r.status));
    ok('Meldung auf Deutsch', /Zu viele Login-Versuche/.test(r.body?.error || ''), JSON.stringify(r.body));
    ok('Kopfzeile RateLimit vorhanden, keine X-RateLimit-Altlast', !!(r.kopf['ratelimit'] || r.kopf['ratelimit-policy']) && !r.kopf['x-ratelimit-limit'],
      JSON.stringify(Object.keys(r.kopf).filter(k => /ratelimit/i.test(k))));
    r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: pw }, vonAdresse: A });
    ok('auch das richtige Passwort ist von dort gebremst', r.status === 429, String(r.status));
    r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: pw }, vonAdresse: B });
    ok('andere Adresse (IPv6) meldet sich normal an', r.status === 200 && !!r.body?.token, String(r.status));
    const token = r.body?.token;

    console.log('── Erfolgreiche Anmeldungen zählen nicht ──');
    const C = '198.51.100.9';
    let alle200 = true;
    for (let i = 0; i < 12; i++) { const x = await req('POST', '/api/auth/login', { body: { username: 'admin', password: pw }, vonAdresse: C }); if (x.status !== 200) alle200 = false; }
    ok('12 richtige Anmeldungen hintereinander → alle 200', alle200);

    console.log('── Code-Bestätigung (2FA einrichten): je Konto, nicht je Adresse ──');
    r = await req('POST', '/api/auth/2fa/setup', { token });
    ok('Einrichtung begonnen', r.status === 200, String(r.status));
    // Positiv prüfen (400 = falscher Code), nicht bloß „kein 429" — ein 404 wäre sonst auch grün.
    const stati = [];
    for (let i = 0; i < 10; i++) stati.push((await req('POST', '/api/auth/2fa/verify', { token, body: { code: '000000' }, vonAdresse: `192.0.2.${i + 1}` })).status);
    ok('10 falsche Codes von 10 Adressen → je 400', stati.every(s => s === 400), stati.join(','));
    r = await req('POST', '/api/auth/2fa/verify', { token, body: { code: '000000' }, vonAdresse: '192.0.2.99' });
    ok('11. Code von neuer Adresse → 429 (zählt je Konto)', r.status === 429, String(r.status));
    ok('Meldung auf Deutsch', /Zu viele Versuche/.test(r.body?.error || ''), JSON.stringify(r.body));

    await sleep(300);
    const protokoll = fs.readFileSync(LOG, 'utf8');
    const warnungen = protokoll.split('\n').filter(z => /ERR_ERL_|ValidationError/.test(z));
    ok('keine Selbstprüfungs-Warnung von express-rate-limit im Protokoll', warnungen.length === 0, warnungen.slice(0, 3).join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (_) {} }
  console.log(`\nAnmelde-Bremsen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
