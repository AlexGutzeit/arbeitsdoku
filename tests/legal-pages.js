// API-Test: Impressum/Datenschutz als admin/chef-konfigurierbare Settings + öffentlicher Endpunkt.
//   node tests/legal-pages.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3222, DB = '/tmp/legal-pages.db';
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
  const lg = fs.openSync('/tmp/legal-pages-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/legal-pages-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const chef = (await login('chef', cpw)).body.token;

    // 1) Frischer Stand: öffentlicher Endpunkt liefert leere Strings (kein Crash bei fehlenden Keys)
    let pub = await req('GET', '/api/legal', null);
    ok('GET /api/legal ohne Token → 200', pub.status === 200, 'status=' + pub.status);
    ok('leere Defaults (impressum="" / datenschutz="")', pub.body && pub.body.impressum === '' && pub.body.datenschutz === '');

    // 2) Chef darf Rechtstexte speichern
    const IMP = 'Musterfirma GmbH\nMusterstr. 1\n10115 Berlin\nGF: Max Mustermann';
    const DAT = 'Verantwortliche Stelle: Musterfirma GmbH …';
    let r = await req('PUT', '/api/settings', chef, { legal_impressum: IMP, legal_datenschutz: DAT });
    ok('Chef PUT Rechtstexte → 200', r.status === 200, 'status=' + r.status);
    ok('in GET /api/settings gespeichert', r.body.settings.legal_impressum === IMP && r.body.settings.legal_datenschutz === DAT);

    // 3) Öffentlich (ohne Token) abrufbar
    pub = await req('GET', '/api/legal', null);
    ok('öffentlich: Impressum-Text korrekt', pub.body.impressum === IMP);
    ok('öffentlich: Datenschutz-Text korrekt', pub.body.datenschutz === DAT);

    // 4) Admin darf ebenfalls (chef+admin)
    r = await req('PUT', '/api/settings', admin, { legal_impressum: IMP + ' (v2)' });
    ok('Admin PUT Rechtstext → 200', r.status === 200 && (await req('GET', '/api/legal', null)).body.impressum === IMP + ' (v2)');

    // 5) Längen-Cap
    r = await req('PUT', '/api/settings', chef, { legal_impressum: 'x'.repeat(50001) });
    ok('zu langer Text (>50000) → 400', r.status === 400, 'status=' + r.status);

    // 6) Mitarbeiter darf NICHT
    const ma = await req('POST', '/api/users', admin, { username: 'legalma', password: 'Test1234!', name: 'Legal MA', role: 'mitarbeiter' });
    const maTok = (await login('legalma', 'Test1234!')).body.token;
    r = await req('PUT', '/api/settings', maTok, { legal_impressum: 'hack' });
    ok('Mitarbeiter PUT Settings → 403', r.status === 403, 'status=' + r.status);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nLegal-Pages: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
