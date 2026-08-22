// „Auf allen Geräten abmelden" und die Datenauskunft (Art. 15 DSGVO).
//
// Anmelde-Token waren bis hierher überhaupt nicht widerrufbar — sie liefen einfach nach 24 Stunden
// ab. Bei einem verlorenen Handy ist das genau die falsche Antwort. Gelöst über einen Zähler je
// Nutzer, der im Token mitfährt: Ein Klick erhöht ihn, und jedes Token mit kleinerem Stand ist in
// derselben Sekunde wertlos.
//
// Der heikle Teil daran ist die Abwärtskompatibilität: Token aus der Zeit VOR dieser Änderung
// tragen den Anspruch gar nicht. Sie müssen weiter gelten, solange niemand den Knopf gedrückt hat
// — sonst hätte das Update alle abgemeldet. Genau das wird hier geprüft.
//
//   node tests/konto-sitzung-daten.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');

const PORT = 3260, DB = '/tmp/konto-sitzung.db', GEHEIM = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s, kopf: x.headers }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/konto-sitzung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: GEHEIM }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/konto-sitzung-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = (u, p) => req('POST', '/api/auth/login', null, { username: u, password: p });

    console.log('── Abwärtskompatibilität: alte Token ohne Sitzungs-Anspruch ──');
    const maxUser = (await anmelden('max', pw('max'))).body.user;
    // Genau so sah ein Token vor dieser Aenderung aus — ohne `sitzung`.
    const altesToken = jwt.sign({ userId: maxUser.id, role: maxUser.role }, GEHEIM, { expiresIn: '24h' });
    ok('ein Token aus der Zeit davor gilt weiterhin',
      (await req('GET', '/api/entries', altesToken)).status === 200);

    console.log('\n── Drei Anmeldungen, wie auf drei Geräten ──');
    const handy = (await anmelden('max', pw('max'))).body.token;
    const tablet = (await anmelden('max', pw('max'))).body.token;
    const rechner = (await anmelden('max', pw('max'))).body.token;
    for (const [name, t] of [['Handy', handy], ['Tablet', tablet], ['Rechner', rechner]]) {
      ok(`${name} kommt in die App`, (await req('GET', '/api/entries', t)).status === 200);
    }

    console.log('\n── „Auf allen Geräten abmelden" vom Rechner aus ──');
    const antwort = await req('POST', '/api/auth/alle-abmelden', rechner);
    ok('klappt', antwort.status === 200, `${antwort.status} ${antwort.text.slice(0, 70)}`);
    ok('… und liefert sofort ein frisches Token', !!antwort.body.token,
      'ohne das wuerde man sich mit dem eigenen Klick hinauswerfen');
    ok('Handy ist ausgesperrt', (await req('GET', '/api/entries', handy)).status === 401);
    ok('Tablet ist ausgesperrt', (await req('GET', '/api/entries', tablet)).status === 401);
    ok('auch das alte Token ohne Anspruch ist jetzt weg',
      (await req('GET', '/api/entries', altesToken)).status === 401);
    ok('das Token, mit dem geklickt wurde, ebenfalls (es ist ja auch alt)',
      (await req('GET', '/api/entries', rechner)).status === 401);
    ok('… aber das frische funktioniert', (await req('GET', '/api/entries', antwort.body.token)).status === 200);

    console.log('\n── Eine neue Anmeldung geht danach normal ──');
    const neu = await anmelden('max', pw('max'));
    ok('Anmeldung klappt', neu.status === 200 && !!neu.body.token);
    ok('… und das Token gilt', (await req('GET', '/api/entries', neu.body.token)).status === 200);

    console.log('\n── Es trifft nur den eigenen Zugang ──');
    const chef = (await anmelden('chef', pw('chef'))).body.token;
    await req('POST', '/api/auth/alle-abmelden', neu.body.token);
    ok('der Chef bleibt angemeldet', (await req('GET', '/api/entries', chef)).status === 200);

    console.log('\n── Datenauskunft ──');
    const maxT = (await anmelden('max', pw('max'))).body.token;
    const auskunft = await req('GET', '/api/users/meine-daten', maxT);
    ok('wird ausgeliefert', auskunft.status === 200, String(auskunft.status));
    ok('… als Datei zum Herunterladen', /attachment/.test(auskunft.kopf['content-disposition'] || ''),
      String(auskunft.kopf['content-disposition']));
    const d = auskunft.body;
    ok('… enthält die Stammdaten', d && d.stammdaten && d.stammdaten.username === 'max', JSON.stringify(d && d.stammdaten && d.stammdaten.username));
    ok('… und die erwarteten Abschnitte',
      d && 'zeiteintraege' in d && 'abwesenheiten' in d && 'protokoll_eintraege' in d, Object.keys(d || {}).join(','));
    // Der wichtigste Punkt: Was NICHT drinstehen darf.
    ok('KEIN Passwort-Hash', !/password_hash/.test(auskunft.text), 'Passwort-Hash gehört nirgendwohin');
    ok('KEIN Zwei-Faktor-Geheimnis', !/secret_enc|pending_enc/.test(auskunft.text),
      'das waere ein Schluessel, kein Datum');
    ok('… wohl aber die Tatsache, dass 2FA eingerichtet ist', d && 'zwei_faktor' in d);
    ok('ohne Anmeldung gibt es keine Auskunft', (await req('GET', '/api/users/meine-daten', null)).status === 401);

    console.log('\n── Im Audit-Log ──');
    const admin = (await anmelden('admin', pw('admin'))).body.token;
    const eintraege = JSON.stringify((await req('GET', '/api/audit?limit=100', admin)).body);
    ok('Abmelden protokolliert', /alle_abgemeldet/.test(eintraege));
    ok('Auskunft protokolliert', /datenauskunft/.test(eintraege));

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nSitzungen und Datenauskunft: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
