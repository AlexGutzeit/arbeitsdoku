// Geburtstags-Freigabe: Der Mitarbeiter sieht sein hinterlegtes Datum und entscheidet selbst,
// was das Team davon erfährt.
//
// Der Kern ist eine Einwilligungsfrage. Bis hierher sahen nur Chef/Admin/Buchhalter, wer
// Geburtstag hat — eine Anzeige für die ganze Belegschaft wäre einwilligungspflichtig gewesen.
// Legt die betroffene Person den Schalter selbst um, ist genau diese Einwilligung da.
//
// Zwei Stufen, weil „das Team darf gratulieren" nicht dasselbe ist wie „das Team darf mein Alter
// kennen". Genau das wird hier geprüft — samt der Vorgabe, dass nach dem Update erst einmal
// NIEMAND freigegeben ist.
//
//   node tests/geburtstag-freigabe.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3259, DB = '/tmp/geb-freigabe.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const heuteMD = new Date().toLocaleDateString('sv-SE').slice(5);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/geb-freigabe-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/geb-freigabe-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;

    // Zwei Mitarbeiter, beide heute Geburtstag.
    const anlegen = async (u, name, jahr) => (await req('POST', '/api/users', admin,
      { username: u, password: 'Test1234!', name, role: 'mitarbeiter', birth_date: `${jahr}-${heuteMD}` })).body.user;
    const anton = await anlegen('anton', 'Anton Offen', 1990);
    const berta = await anlegen('berta', 'Berta Still', 1985);
    const tok = async (u) => (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    const antonT = await tok('anton'), bertaT = await tok('berta');
    const maxT = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;
    const chefT = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;

    console.log('── Der Mitarbeiter sieht sein hinterlegtes Datum ──');
    const eigen = (await req('GET', '/api/users/geburtstag-freigabe', antonT)).body;
    ok('das Geburtsdatum wird mitgeliefert', eigen.geburtsdatum === `1990-${heuteMD}`, String(eigen.geburtsdatum));
    ok('… und ist zunächst NICHT freigegeben', eigen.zeigen === false && eigen.alter_auch === false, JSON.stringify(eigen));

    console.log('\n── Vorgabe nach dem Update: Kollegen sehen nichts ──');
    const kollegeVorher = (await req('GET', '/api/users/geburtstage', maxT)).body.geburtstage;
    ok('ein Mitarbeiter sieht keine fremden Geburtstage', kollegeVorher.length === 0, JSON.stringify(kollegeVorher));
    const chefVorher = (await req('GET', '/api/users/geburtstage', chefT)).body.geburtstage;
    ok('der Chef sieht sie wie bisher', chefVorher.length >= 2, String(chefVorher.length));
    ok('… mit Alter', chefVorher.every(g => typeof g.alter === 'number'), JSON.stringify(chefVorher[0]));

    console.log('\n── Anton gibt seinen Geburtstag frei, ohne Alter ──');
    ok('speichern klappt', (await req('PUT', '/api/users/geburtstag-freigabe', antonT, { zeigen: true })).status === 200);
    let sicht = (await req('GET', '/api/users/geburtstage', maxT)).body.geburtstage;
    ok('der Kollege sieht jetzt genau einen', sicht.length === 1 && sicht[0].name === 'Anton Offen', JSON.stringify(sicht));
    ok('… OHNE Alter — das ist der Kern der zweiten Stufe', sicht[0].alter === undefined, JSON.stringify(sicht[0]));
    ok('Berta bleibt unsichtbar', !sicht.some(g => g.name === 'Berta Still'));
    ok('der Chef sieht weiterhin beide MIT Alter',
      (await req('GET', '/api/users/geburtstage', chefT)).body.geburtstage.every(g => typeof g.alter === 'number'));

    console.log('\n── Anton gibt zusätzlich sein Alter frei ──');
    await req('PUT', '/api/users/geburtstag-freigabe', antonT, { zeigen: true, alter_auch: true });
    sicht = (await req('GET', '/api/users/geburtstage', maxT)).body.geburtstage;
    ok('jetzt steht das Alter dabei', sicht[0].alter === new Date().getFullYear() - 1990, JSON.stringify(sicht[0]));

    console.log('\n── „Alter" allein ergibt keinen Sinn und wird geradegerückt ──');
    const widerspruch = await req('PUT', '/api/users/geburtstag-freigabe', antonT, { zeigen: false, alter_auch: true });
    ok('der Server nimmt „Alter" mit zurück', widerspruch.body.zeigen === false && widerspruch.body.alter_auch === false,
      JSON.stringify(widerspruch.body));
    ok('… und der Kollege sieht wieder nichts',
      (await req('GET', '/api/users/geburtstage', maxT)).body.geburtstage.length === 0);

    console.log('\n── Man kann nur die EIGENE Freigabe ändern ──');
    // Die Route nimmt keine Nutzer-Kennung entgegen; mitgeschickte werden ignoriert.
    await req('PUT', '/api/users/geburtstag-freigabe', bertaT, { zeigen: true, user_id: anton.id });
    const nachBerta = (await req('GET', '/api/users/geburtstage', maxT)).body.geburtstage;
    ok('Bertas Freigabe wirkt auf Berta', nachBerta.some(g => g.name === 'Berta Still'), JSON.stringify(nachBerta));
    ok('… und NICHT auf Anton', !nachBerta.some(g => g.name === 'Anton Offen'), JSON.stringify(nachBerta));
    ok('Antons eigene Einstellung ist unverändert aus',
      (await req('GET', '/api/users/geburtstag-freigabe', antonT)).body.zeigen === false);

    console.log('\n── Der eigene Geburtstag taucht in der eigenen Liste nicht auf ──');
    ok('Berta sieht sich selbst nicht',
      !(await req('GET', '/api/users/geburtstage', bertaT)).body.geburtstage.some(g => g.name === 'Berta Still'));

    console.log('\n── Ohne Anmeldung geht nichts ──');
    ok('lesen: 401', (await req('GET', '/api/users/geburtstag-freigabe', null)).status === 401);
    ok('setzen: 401', (await req('PUT', '/api/users/geburtstag-freigabe', null, { zeigen: true })).status === 401);
    ok('Liste: 401', (await req('GET', '/api/users/geburtstage', null)).status === 401);

    console.log('\n── Im Audit-Log steht die Entscheidung ──');
    const eintraege = JSON.stringify((await req('GET', '/api/audit?limit=100', admin)).body);
    ok('protokolliert', /geburtstag_freigabe/.test(eintraege));

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nGeburtstags-Freigabe: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
