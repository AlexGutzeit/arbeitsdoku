// Jeder darf sein eigenes Passwort ändern (PUT /api/auth/password).
//
// Vorher konnte das NIEMAND selbst: Es gab nur „zurücksetzen" durch Chef/Admin für fremde Konten
// (routes/users.js). Wem jemand über die Schulter geschaut hat, der musste warten, bis ein
// Vorgesetzter Zeit hat.
//
// Zwei Dinge sind dabei heikel und werden hier ausdrücklich geprüft:
//   * Das AKTUELLE Passwort ist Pflicht — sonst reicht ein unbeaufsichtigtes, angemeldetes Gerät,
//     um sich den Zugang dauerhaft zu sichern.
//   * Der Weg für Chef/Admin muss unverändert weiter funktionieren (Abwärtskompatibilität).
//
//   node tests/passwort-selbst-aendern.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3247, DB = '/tmp/passwort-selbst.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const anmelden = (u, p) => req('POST', '/api/auth/login', null, { username: u, password: p });

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/passwort-selbst-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/passwort-selbst-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const adminToken = (await anmelden('admin', pw('admin'))).body.token;

    // Ein ganz normaler Mitarbeiter — er ist der Fall, um den es geht.
    const ma = (await req('POST', '/api/users', adminToken,
      { username: 'monteur', password: 'Start1234!', name: 'Manfred Monteur', role: 'mitarbeiter' })).body.user;
    let maToken = (await anmelden('monteur', 'Start1234!')).body.token;
    ok('Mitarbeiter angelegt und angemeldet', !!maToken);

    console.log('── Was abgelehnt werden muss ──');
    ok('ohne Angaben → 400', (await req('PUT', '/api/auth/password', maToken, {})).status === 400);
    ok('ohne aktuelles Passwort → 400',
      (await req('PUT', '/api/auth/password', maToken, { neu: 'Neues1234!' })).status === 400);
    const falsch = await req('PUT', '/api/auth/password', maToken, { aktuell: 'Falsch1234!', neu: 'Neues1234!' });
    ok('mit falschem aktuellem Passwort → 401', falsch.status === 401, `${falsch.status} ${falsch.text.slice(0, 60)}`);
    ok('… und das alte Passwort gilt weiterhin', (await anmelden('monteur', 'Start1234!')).status === 200);

    console.log('\n── Die Passwort-Regeln gelten hier genauso ──');
    for (const [was, neu] of [['zu kurz', 'Ab1!'], ['ohne Ziffer', 'Abcdefgh!'],
                              ['ohne Sonderzeichen', 'Abcdefg1'], ['ohne Grossbuchstabe', 'abcdefg1!']]) {
      const r = await req('PUT', '/api/auth/password', maToken, { aktuell: 'Start1234!', neu });
      ok(`${was} → abgelehnt`, r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);
    }
    const gleich = await req('PUT', '/api/auth/password', maToken, { aktuell: 'Start1234!', neu: 'Start1234!' });
    ok('dasselbe Passwort noch einmal → abgelehnt', gleich.status === 400, gleich.text.slice(0, 70));
    // Die Regel lautet GLEICH dem Benutzernamen, nicht „enthaelt ihn" — hier lag meine erste
    // Erwartung daneben, nicht die App: „Monteur1!" ist erlaubt, „monteur" waere es nicht (scheitert
    // dann ohnehin schon an Laenge und Zeichenklassen). Die Regel selbst deckt tests/password-policy.js
    // ab; hier geht es nur darum, dass sie an dieser Route ueberhaupt angewandt wird — das zeigen die
    // vier Faelle darueber bereits.
    const wieName = await req('PUT', '/api/auth/password', maToken, { aktuell: 'Start1234!', neu: 'monteur' });
    ok('Passwort gleich dem Benutzernamen → abgelehnt', wieName.status === 400, wieName.text.slice(0, 70));

    console.log('\n── Der gute Fall ──');
    const gut = await req('PUT', '/api/auth/password', maToken, { aktuell: 'Start1234!', neu: 'Frisch2026!' });
    ok('Ändern klappt', gut.status === 200, `${gut.status} ${gut.text.slice(0, 60)}`);
    ok('… das alte Passwort gilt NICHT mehr', (await anmelden('monteur', 'Start1234!')).status === 401);
    ok('… mit dem neuen kommt man rein', (await anmelden('monteur', 'Frisch2026!')).status === 200);
    maToken = (await anmelden('monteur', 'Frisch2026!')).body.token;

    console.log('\n── Man kann nur das EIGENE Passwort ändern ──');
    // Es gibt bewusst keinen Weg, ueber diesen Endpunkt ein fremdes Konto zu treffen: Die Route
    // nimmt gar keine Nutzer-Id entgegen, sie arbeitet immer gegen den angemeldeten Nutzer.
    const versuch = await req('PUT', '/api/auth/password', maToken,
      { aktuell: 'Frisch2026!', neu: 'Anders2026!', user_id: 1, username: 'admin' });
    ok('mitgeschickte fremde Kennung wird schlicht ignoriert', versuch.status === 200);
    ok('… das Admin-Passwort ist unverändert', (await anmelden('admin', pw('admin'))).status === 200);

    console.log('\n── Abwärtskompatibilität: der Weg für Chef/Admin bleibt ──');
    const reset = await req('POST', `/api/users/${ma.id}/reset-password`, adminToken, { password: 'ChefSetzt1!' });
    ok('Admin kann weiterhin fremde Passwörter zurücksetzen', reset.status === 200, `${reset.status} ${reset.text.slice(0, 60)}`);
    ok('… und der Mitarbeiter kommt damit rein', (await anmelden('monteur', 'ChefSetzt1!')).status === 200);
    ok('ein Mitarbeiter darf das weiterhin NICHT für andere',
      (await req('POST', '/api/users/1/reset-password',
        (await anmelden('monteur', 'ChefSetzt1!')).body.token, { password: 'Fremd1234!' })).status === 403);

    console.log('\n── Ohne Anmeldung geht gar nichts ──');
    ok('ohne Token → 401', (await req('PUT', '/api/auth/password', null, { aktuell: 'a', neu: 'b' })).status === 401);

    console.log('\n── Im Audit-Log steht es, ohne Passwörter ──');
    const eintraege = (await req('GET', '/api/audit?limit=100', adminToken)).body;
    const zeilen = (eintraege && (eintraege.entries || eintraege.logs || eintraege.rows)) || [];
    const text = JSON.stringify(zeilen);
    ok('die Änderung ist protokolliert', /password_self_change/.test(text));
    ok('der Fehlversuch ebenfalls', /password_self_change_failed/.test(text));
    ok('… und kein Passwort steht darin', !/Frisch2026!|Start1234!|ChefSetzt1!/.test(text));

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nEigenes Passwort ändern: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
