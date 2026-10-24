// Express 5: Zahlen-Routen, Rückfall auf index.html, DELETE ohne Body, Startfehler und Absturz-Wächter verhalten sich wie vorher.
//
// Beim Umstieg von Express 4 auf 5 (24.10.2026) änderte sich, ohne dass ein Bestandstest es bemerkt hätte:
//   A  „/:id(\\d+)" gibt es nicht mehr. Ersatz: middleware/nur-zahl.js. Ohne ihn finge GET /api/meldungen/:id
//      auch /regeln ab und PUT /:id auch /themen-reihenfolge.
//   B  „*" heißt jetzt „/{*rest}" — tiefe Pfade müssen weiter die App (index.html) bekommen.
//   C  req.body ist ohne Body undefined statt {} — DELETE mit `!req.body.loesen` wäre ein 500.
//   D  app.listen gibt einen Startfehler (Port belegt) an den Rückruf, statt abzustürzen. Ohne Prüfung meldete der
//      Server „läuft" und endete mit Code 0 — Gegenprobe am 24.10.2026.
//   E  absturzschutz.asyncRoutenAbsichern() ist nur noch ein Wächter: unter Express < 5 bricht es laut ab.
//   node tests/express5-routen.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PORT = 3393, PORT_BELEGT = 3394, DB = '/tmp/express5-routen.db', LOG = '/tmp/express5-routen-srv.log';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const WURZEL = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// ohneBody: wirklich keinen Body und keinen Content-Type schicken (so ruft z. B. fetch ein DELETE auf).
function req(method, p, token, body, ohneBody) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      ...(ohneBody ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (x) => { let s = ''; x.on('data', d => s += d); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s, typ: x.headers['content-type'] || '' }); }); });
    r.on('error', () => res({ status: 0 })); if (data) r.write(data); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: WURZEL, env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 80; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const pw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const token = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body?.token;
    ok('Server startet, Admin-Anmeldung', !!token);

    console.log('── A: Zahlen-Routen lassen benannte Pfade durch ──');
    let r = await req('GET', '/api/meldungen/regeln', token);
    ok('GET /api/meldungen/regeln → Regel-Liste (nicht „Meldung gibt es nicht")', r.status === 200 && Array.isArray(r.body?.regeln), `${r.status} ${r.text.slice(0, 80)}`);
    r = await req('GET', '/api/meldungen/987654', token);
    ok('GET /api/meldungen/987654 → 404 „gibt es nicht mehr"', r.status === 404 && /gibt es nicht mehr/.test(r.body?.error || ''), `${r.status} ${r.text.slice(0, 80)}`);
    r = await req('PUT', '/api/meldungen/themen-reihenfolge', token, { ids: [] });
    ok('PUT /api/meldungen/themen-reihenfolge erreicht seine Route (nicht PUT /:id)', [200, 409].includes(r.status) && !/gibt es nicht mehr/.test(r.body?.error || ''), `${r.status} ${r.text.slice(0, 80)}`);
    r = await req('GET', '/api/meldungen/abc', token);
    ok('GET /api/meldungen/abc → keine Meldungs-Route (fällt auf die App zurück wie unter Express 4)', r.status === 200 && /text\/html/.test(r.typ), `${r.status} ${r.typ}`);
    r = await req('GET', '/api/notes/abc/erinnerungen', token);
    ok('GET /api/notes/abc/erinnerungen → keine Erinnerungs-Route', !(r.body && Array.isArray(r.body.erinnerungen)), `${r.status} ${r.text.slice(0, 60)}`);
    const neu = await req('POST', '/api/notes', token, { title: 'Probe', body: 'x' });
    const nid = neu.body?.note?.id || neu.body?.id;
    r = await req('GET', `/api/notes/${nid}/erinnerungen`, token);
    ok('GET /api/notes/<Zahl>/erinnerungen → 200', r.status === 200, `${neu.status} ${r.status} ${r.text.slice(0, 60)}`);
    r = await req('GET', '/api/meldungen/987654', null);
    ok('Zahl, aber ohne Anmeldung → 401 (Prüfung bleibt hinter nurZahl)', r.status === 401, String(r.status));

    console.log('── B: Rückfall auf die App ──');
    for (const p of ['/', '/irgendwo/tief/drin', '/zeitnachweis']) {
      r = await req('GET', p);
      // Platzhalter in public/index.html heißen {{themeColor}}, {{appName}} … — keiner darf übrig bleiben.
      ok(`GET ${p} → index.html mit eingesetztem Branding`, r.status === 200 && /<html/i.test(r.text) && !/\{\{[A-Za-z_]+\}\}/.test(r.text),
        `${r.status} ${r.typ} ${(r.text.match(/\{\{[A-Za-z_]+\}\}/) || [''])[0]}`);
    }

    console.log('── C: DELETE ohne Body ──');
    const kat = (await req('POST', '/api/projects/kategorien', token, { name: 'Probe-Kategorie' })).body?.kategorie;
    const proj = (await req('POST', '/api/projects', token, { name: 'Probe-Auftrag', category_ids: [kat?.id] })).body?.project;
    r = await req('DELETE', `/api/projects/kategorien/${kat?.id}`, token, null, true);
    ok('DELETE ohne Body, Kategorie mit Auftrag → 409 Rückfrage (kein 500)', r.status === 409 && /Bestätige/.test(r.body?.error || ''), `${!!proj} ${r.status} ${r.text.slice(0, 80)}`);
    r = await req('DELETE', `/api/projects/kategorien/${kat?.id}`, token, { loesen: true });
    ok('DELETE mit { loesen: true } → gelöscht', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    r = await req('POST', '/api/projects/kategorien', token, null, true);
    ok('POST ohne Body → 400 mit deutscher Meldung (kein 500)', r.status === 400 && /Namen/.test(r.body?.error || ''), `${r.status} ${r.text.slice(0, 80)}`);
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }

  console.log('── D: Port belegt ──');
  const besetzer = http.createServer((q, s) => s.end('besetzt')).listen(PORT_BELEGT);
  await new Promise(r => besetzer.once('listening', r));
  const zweit = spawnSync('node', ['server.js'], { cwd: WURZEL, timeout: 20000, encoding: 'utf8',
    env: { ...process.env, PORT: String(PORT_BELEGT), DB_PATH: '/tmp/express5-routen-2.db', JWT_SECRET: SECRET } });
  besetzer.close(); try { fs.unlinkSync('/tmp/express5-routen-2.db'); } catch (_) {}
  const ausgabe = (zweit.stdout || '') + (zweit.stderr || '');
  ok('zweiter Server auf belegtem Port beendet sich', zweit.status !== null && zweit.signal === null, `status ${zweit.status}, signal ${zweit.signal}`);
  ok('… mit Code 1', zweit.status === 1, String(zweit.status));
  ok('… und meldet NICHT „läuft"', !/Server läuft auf/.test(ausgabe));
  ok('… sondern den Grund (EADDRINUSE)', /EADDRINUSE/.test(ausgabe), ausgabe.split('\n').filter(z => /Port|EADDR/.test(z)).join(' | '));

  console.log('── E: Absturz-Wächter ──');
  const waechter = (version) => spawnSync('node', ['-e', `
    const p = require.resolve('express/package.json'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { version: '${version}' } };
    try { require('./absturzschutz').asyncRoutenAbsichern(); console.log('OK'); } catch (e) { console.log('ABBRUCH ' + e.message); }`],
    { cwd: WURZEL, encoding: 'utf8' }).stdout.trim();
  ok('unter Express 5 kein Einwand', waechter('5.3.0') === 'OK', waechter('5.3.0'));
  ok('unter Express 4 lauter Abbruch', /^ABBRUCH Express 4/.test(waechter('4.22.3')), waechter('4.22.3'));

  srv.kill(); try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nExpress 5: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
