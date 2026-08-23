// Der Schlüssel muss alle Umschaltungen überleben (Alex, 22.08.2026).
//
// Die Kette, die hier durchgespielt wird — genau in dieser Reihenfolge:
//   1. Nutzer richtet FREIWILLIG ein (Rolle steht auf „aus")
//   2. Admin macht 2FA zur Pflicht          → derselbe Code muss weiter gelten
//   3. Admin nimmt die Pflicht zurück       → derselbe Code muss weiter gelten
//   4. Nutzer schaltet selbst ab            → kein Code mehr nötig, Schlüssel bleibt aber liegen
//   5. Admin macht wieder zur Pflicht       → Nutzer muss NICHT neu einlernen, nur reaktivieren
//   6. Nutzer aktiviert mit dem ALTEN Code  → drin
//
// Der Punkt dahinter: Wer einmal seine Authenticator-App eingelernt hat, soll das nie wieder tun
// müssen, nur weil jemand einen Schalter umlegt. Neu einlernen nur, wenn man es ausdrücklich will
// (neuer Schlüssel) oder wenn Chef/Admin zurücksetzt (verlorenes Handy).
//
//   node tests/twofa-schluessel-bestand.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const totp = require('../totp');

const PORT = 3255, DB = '/tmp/twofa-bestand.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, cookie) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: {
      'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {}
        res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Auf ein frisches Zeitfenster warten — ein Code gilt nur EINMAL (Replay-Riegel).
async function frischerCode(geheim) {
  const start = totp.schrittFuer(Date.now());
  while (totp.schrittFuer(Date.now()) === start) await sleep(500);
  return totp.code(geheim);
}

// Seit dem 23.08.2026 verlangt das Scharfschalten einer Rolle (von „aus" auf eine Pflicht) einen
// gueltigen Code des Aufrufers — siehe tests/twofa-scharfschalten.js. Das erledigt hier ein
// EIGENER Admin: In diesem Test geht es um den Schluessel VON MAX, und ein Authenticator beim
// Haupt-Admin wuerde dessen Anmeldeverhalten nebenbei mitaendern.
//
// Der Wiederverwendungs-Riegel nimmt nur STEIGENDE Zeitschritte; der Helfer wartet notfalls auf
// ein frisches Fenster (hoechstens 30 Sekunden).
let _sTok = null, _sGeheim = null, _sSchritt = -1;
async function scharfSchalten(adminToken, werte) {
  if (!_sTok) {
    await req('POST', '/api/users', adminToken,
      { username: 'scharfschalter', password: 'Test1234!', name: 'Scharf Schalter', role: 'admin' });
    _sTok = (await req('POST', '/api/auth/login', null, { username: 'scharfschalter', password: 'Test1234!' })).body.token;
    _sGeheim = (await req('POST', '/api/auth/2fa/setup', _sTok, {})).body.geheim;
    await req('POST', '/api/auth/2fa/verify', _sTok, { code: totp.code(_sGeheim) });
    _sSchritt = Math.floor(Date.now() / 30000);
  }
  while (Math.floor(Date.now() / 30000) + 1 <= _sSchritt) await sleep(1000);
  _sSchritt = Math.floor(Date.now() / 30000) + 1;
  return req('PUT', '/api/settings', _sTok, { ...werte, twofa_code: totp.code(_sGeheim, Date.now() + 30000) });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/twofa-bestand-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/twofa-bestand-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = (u, p) => req('POST', '/api/auth/login', null, { username: u, password: p });
    const admin = (await anmelden('admin', pw('admin'))).body.token;
    const maPw = pw('max');
    let maToken = (await anmelden('max', maPw)).body.token;
    // Abschalten geht ohne Code, Scharfschalten nicht — der Helfer nimmt dafuer seinen eigenen
    // Admin mit eigenem Authenticator.
    const stellen = (wert) => (wert === 'aus')
      ? req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'aus' })
      : scharfSchalten(admin, { twofa_mitarbeiter: wert });
    const status = async (t) => (await req('GET', '/api/auth/2fa/status', t)).body.zwei_faktor;

    console.log('── 1. Freiwillig einrichten, Rolle steht auf „aus" ──');
    const setup = await req('POST', '/api/auth/2fa/setup', maToken);
    const SCHLUESSEL = setup.body.geheim;
    ok('Schlüssel erhalten', /^[A-Z2-7]{32}$/.test(SCHLUESSEL || ''), String(SCHLUESSEL));
    ok('bestätigt', (await req('POST', '/api/auth/2fa/verify', maToken, { code: totp.code(SCHLUESSEL) })).status === 200);
    ok('… und aktiv', (await status(maToken)).eingerichtet === true);

    console.log('\n── 2. Admin macht 2FA zur Pflicht — derselbe Schlüssel muss gelten ──');
    await stellen('immer');
    let a = await anmelden('max', maPw);
    ok('Code wird verlangt', a.body.zwei_faktor_erforderlich === true);
    let r = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(SCHLUESSEL) });
    ok('… und der ALTE Schlüssel öffnet die Tür', r.status === 200 && !!r.body.token, `${r.status} ${r.text.slice(0, 70)}`);
    maToken = r.body.token;

    console.log('\n── 3. Admin nimmt die Pflicht zurück — Schlüssel bleibt gültig ──');
    await stellen('aus');
    a = await anmelden('max', maPw);
    ok('es wird weiterhin ein Code verlangt (freiwillig eingerichtet zählt)', a.body.zwei_faktor_erforderlich === true);
    r = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(SCHLUESSEL) });
    ok('… derselbe Schlüssel wieder', r.status === 200 && !!r.body.token, `${r.status}`);
    maToken = r.body.token;

    console.log('\n── 4. Nutzer schaltet selbst ab ──');
    const aus = await req('POST', '/api/auth/2fa/aus', maToken, { code: await frischerCode(SCHLUESSEL) });
    ok('Abschalten klappt', aus.status === 200, `${aus.status} ${aus.text.slice(0, 70)}`);
    const nachAus = await status(maToken);
    ok('… gilt als nicht mehr eingerichtet', nachAus.eingerichtet === false);
    ok('… ist aber als STILLGELEGT erkennbar (Schlüssel liegt noch da)', nachAus.stillgelegt === true, JSON.stringify(nachAus));
    a = await anmelden('max', maPw);
    ok('… und die Anmeldung verlangt keinen Code mehr', !a.body.zwei_faktor_erforderlich && !!a.body.token);
    maToken = a.body.token;

    console.log('\n── 5. Admin macht wieder zur Pflicht ──');
    await stellen('woechentlich');
    a = await anmelden('max', maPw);
    ok('Anmeldung geht (Passwort reicht, es ist ja nichts aktiv)', !!a.body.token);
    maToken = a.body.token;
    const gesperrt = await req('GET', '/api/entries', maToken);
    ok('… aber die App ist gesperrt, bis er wieder aktiviert', gesperrt.status === 403, String(gesperrt.status));
    const z5 = await status(maToken);
    ok('… und die Oberfläche weiß, dass sie „wieder aktivieren" anbieten muss',
      z5.stillgelegt === true && z5.einrichtung_noetig === true, JSON.stringify(z5));

    console.log('\n── 6. Reaktivieren mit dem ALTEN Code — kein neues Einlernen ──');
    const wieder = await req('POST', '/api/auth/2fa/verify', maToken, { code: await frischerCode(SCHLUESSEL) });
    ok('der alte Code reicht', wieder.status === 200, `${wieder.status} ${wieder.text.slice(0, 70)}`);
    ok('… 2FA ist wieder aktiv', (await status(maToken)).eingerichtet === true);
    ok('… und die App ist frei', (await req('GET', '/api/entries', maToken)).status === 200);
    a = await anmelden('max', maPw);
    r = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(SCHLUESSEL) });
    ok('… auch beim Anmelden gilt weiterhin derselbe Schlüssel', r.status === 200 && !!r.body.token);
    maToken = r.body.token;

    console.log('\n── 7. Neuen Schlüssel würfeln — ohne sich dabei auszusperren ──');
    const neu = await req('POST', '/api/auth/2fa/setup', maToken, { neu: true });
    ok('ein neuer Schlüssel wird ausgegeben', neu.status === 200 && /^[A-Z2-7]{32}$/.test(neu.body.geheim || ''), `${neu.status}`);
    const NEUER = neu.body.geheim;
    ok('… und er ist ein anderer als der alte', NEUER !== SCHLUESSEL);
    ok('… solange er nicht bestätigt ist, gilt weiterhin der ALTE',
      (await req('POST', '/api/auth/2fa/verify', maToken, { code: '000000' })).status === 400);
    // Der Beweis: mit dem ALTEN Schluessel anmelden, obwohl der neue schon erzeugt ist.
    a = await anmelden('max', maPw);
    r = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(SCHLUESSEL) });
    ok('… der alte Schlüssel öffnet die Anmeldung weiterhin', r.status === 200 && !!r.body.token, `${r.status}`);
    maToken = r.body.token;

    const uebernahme = await req('POST', '/api/auth/2fa/verify', maToken, { code: await frischerCode(NEUER) });
    ok('nach Bestätigung des NEUEN Codes wird er übernommen', uebernahme.status === 200, `${uebernahme.status} ${uebernahme.text.slice(0, 70)}`);
    a = await anmelden('max', maPw);
    const mitAlt = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(SCHLUESSEL) });
    ok('… und der ALTE gilt ab jetzt NICHT mehr', mitAlt.status === 401, `${mitAlt.status} ${mitAlt.text.slice(0, 60)}`);
    a = await anmelden('max', maPw);
    const mitNeu = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: a.body.zwischen_token, code: await frischerCode(NEUER) });
    ok('… der neue dagegen schon', mitNeu.status === 200 && !!mitNeu.body.token, `${mitNeu.status}`);
    maToken = mitNeu.body.token;

    console.log('\n── 8. Admin-Reset dagegen LÖSCHT — das ist der Fall „Handy weg" ──');
    const maId = (await req('GET', '/api/auth/me', maToken)).body.user.id;
    ok('Reset klappt', (await req('POST', `/api/users/${maId}/twofa-reset`, admin)).status === 200);
    const nachReset = await status(maToken);
    ok('… nichts mehr eingerichtet', nachReset.eingerichtet === false);
    ok('… und auch NICHT stillgelegt — es ist wirklich weg',
      nachReset.stillgelegt === false, JSON.stringify(nachReset));
    const setupNachReset = await req('POST', '/api/auth/2fa/setup', maToken);
    ok('… eine ganz neue Einrichtung ist möglich', setupNachReset.status === 200);
    ok('… mit einem anderen Schlüssel', setupNachReset.body.geheim !== NEUER && setupNachReset.body.geheim !== SCHLUESSEL);

  } finally {
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Schlüsselbestand: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
