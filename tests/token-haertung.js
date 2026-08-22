// Sonder-Token dürfen keine Zugangs-Token sein — und was heute funktioniert, muss weiter gehen.
//
// Ausgangslage: `authenticate` prüfte nur die Unterschrift und las `userId`. Jedes mit demselben
// Geheimnis signierte Token kam damit überall durch. Das betraf schon vor der Zwei-Faktor-Arbeit
// das 60-Sekunden-SSE-Ticket: Es taugte eine Minute lang als vollwertiger Bearer-Token. Dazu
// kommt jetzt der Zwischen-Token der 2FA-Anmeldung, der sonst genau die Hürde umginge, die er
// aufstellt.
//
// Der zweite Teil ist genauso wichtig: **Abwärtskompatibilität.** Der lange Login-Token bleibt an
// `/api/events` gültig. Ihn zu sperren wäre sauberer, würde aber jeden alten offenen Tab und jede
// PWA mit älterem Zwischenspeicher von den Live-Aktualisierungen abschneiden. Dieser Test hält
// ausdrücklich fest, dass das weiterhin geht — damit es niemand aus Ordnungsliebe zumacht.
//
//   node tests/token-haertung.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');

const PORT = 3245, DB = '/tmp/token-haertung.db', GEHEIM = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// SSE liefert keinen Abschluss — nur den Statuscode abgreifen und die Verbindung wieder zumachen.
function sseStatus(pfad) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: pfad, method: 'GET' }, x => {
      res(x.statusCode); x.destroy();
    });
    r.on('error', rej); r.end();
    setTimeout(() => { try { r.destroy(); } catch (_) {} }, 4000);
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/token-haertung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: GEHEIM }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/token-haertung-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmeldung = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const token = anmeldung.token;
    const uid = anmeldung.user.id;

    console.log('── Was weiterhin funktionieren MUSS (Abwärtskompatibilität) ──');
    ok('der normale Login-Token gilt an der API', (await req('GET', '/api/entries', token)).status === 200);
    const ticket = (await req('GET', '/api/events/ticket', token)).body.ticket;
    ok('ein SSE-Ticket lässt sich weiterhin holen', !!ticket);
    ok('… und öffnet den Live-Draht', await sseStatus('/api/events?ticket=' + encodeURIComponent(ticket)) === 200);
    ok('der lange Login-Token öffnet den Live-Draht ebenfalls noch (alte Tabs, alter PWA-Zwischenspeicher)',
      await sseStatus('/api/events?token=' + encodeURIComponent(token)) === 200);

    console.log('\n── Was ab jetzt NICHT mehr geht ──');
    const alsBearer = await req('GET', '/api/entries', ticket);
    ok('ein SSE-Ticket taugt nicht mehr als Zugangs-Token', alsBearer.status === 401,
      `${alsBearer.status} — vorher war das eine Minute lang ein Vollzugang`);
    ok('… auch nicht an /api/auth/me', (await req('GET', '/api/auth/me', ticket)).status === 401);
    ok('… und nicht, um sich ein neues Ticket zu holen', (await req('GET', '/api/events/ticket', ticket)).status === 401);

    console.log('\n── Der Zwischen-Token der Zwei-Faktor-Anmeldung ──');
    // Selbst signiert, mit demselben Geheimnis — genau das, was ein Angreifer haette, wenn er den
    // Zwischen-Token aus der halben Anmeldung abfaengt.
    const zwischen = jwt.sign({ userId: uid, pending2fa: true }, GEHEIM, { expiresIn: '5m' });
    ok('gilt an keiner API', (await req('GET', '/api/entries', zwischen)).status === 401);
    ok('… nicht an /api/auth/me', (await req('GET', '/api/auth/me', zwischen)).status === 401);
    ok('… nicht am Ticket-Endpunkt', (await req('GET', '/api/events/ticket', zwischen)).status === 401);
    ok('… und öffnet auch keinen Live-Draht',
      await sseStatus('/api/events?token=' + encodeURIComponent(zwischen)) === 401);
    ok('… auch nicht als Ticket getarnt',
      await sseStatus('/api/events?ticket=' + encodeURIComponent(zwischen)) === 401);

    console.log('\n── Grundlagen bleiben unberührt ──');
    ok('ohne Token: 401', (await req('GET', '/api/entries', null)).status === 401);
    ok('mit fremd signiertem Token: 401',
      (await req('GET', '/api/entries', jwt.sign({ userId: uid }, 'ein-voellig-anderes-geheimnis-mit-32-z'))).status === 401);
    ok('mit abgelaufenem Token: 401',
      (await req('GET', '/api/entries', jwt.sign({ userId: uid }, GEHEIM, { expiresIn: '-1s' }))).status === 401);

  } finally {
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nToken-Härtung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
