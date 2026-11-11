// Härtung des Servers selbst: wo er lauscht, was er über sich verrät, was er auf unbekannte Adressen antwortet.
//
// Sicherheitsprüfung vom 10.11.2026, P4, P8, P9 und ein Punkt aus P10:
//   * P4  Der Server lauschte auf allen Schnittstellen. Wer direkt am Port ankam (am Proxy vorbei), durfte sich
//         seine Adresse per X-Forwarded-For selbst aussuchen — die Anmeldebremse je Adresse griff dann nicht.
//         Jetzt: Vorgabe 127.0.0.1, alles andere nur auf ausdrücklichen Wunsch (LISTEN_HOST).
//   * P8  „Strict-Transport-Security" fehlte. Jetzt gesetzt — aber nur, wenn die Anfrage über https kam.
//   * P9  GET /api/gibtsnicht lieferte die Startseite mit 200. Jetzt 404 als JSON, für jede Methode.
//   * P10 „X-Powered-By: Express" wird nicht mehr ausgeliefert.
//
// „Nicht von außen erreichbar" wird ohne Netz geprüft: 127.0.0.2 ist unter Linux eine eigene Adresse desselben
// Rechners. Ein Server auf 127.0.0.1 antwortet dort NICHT, einer auf allen Schnittstellen schon.
//   node tests/server-haertung.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');

const WURZEL = path.join(__dirname, '..');
const PORT_VORGABE = 3401, PORT_ALLE4 = 3402, PORT_ALLE6 = 3403, PORT_LEER = 3404, PORT_FALSCH = 3405;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(host, port, method, p, kopf = {}, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host, port, path: p, method, timeout: 5000, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...kopf,
    } }, (res) => {
      let s = ''; res.on('data', d => s += d);
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, text: s, kopf: res.headers }); });
    });
    r.on('timeout', () => r.destroy(new Error('ZEIT')));
    r.on('error', (e) => resolve({ status: 0, grund: e.code || e.message }));
    if (data) r.write(data); r.end();
  });
}

// Umgebung für den Prüfling. LISTEN_HOST und HOST der eigenen Sitzung dürfen nicht hineinwirken.
function umgebung(port, mehr) {
  const env = { ...process.env, PORT: String(port), DB_PATH: `/tmp/server-haertung-${port}.db`, JWT_SECRET: SECRET };
  delete env.LISTEN_HOST; delete env.HOST;
  return { ...env, ...mehr };
}
const aufraeumen = (port) => { for (const e of ['', '.tmp', '.bak']) { try { fs.unlinkSync(`/tmp/server-haertung-${port}.db${e}`); } catch (_) {} } };

async function starten(port, mehr, hostZumWarten = '127.0.0.1') {
  aufraeumen(port);
  let ausgabe = '';
  const srv = spawn('node', ['server.js'], { cwd: WURZEL, env: umgebung(port, mehr) });
  srv.stdout.on('data', d => ausgabe += d); srv.stderr.on('data', d => ausgabe += d);
  for (let i = 0; i < 100; i++) {
    if ((await req(hostZumWarten, port, 'GET', '/health')).status === 200) break;
    await sleep(150);
  }
  await sleep(200);   // die zweite Startzeile abwarten
  return { ausgabe: () => ausgabe, beenden: async () => { srv.kill(); await sleep(300); aufraeumen(port); } };
}

const hatIPv6 = Object.values(os.networkInterfaces()).flat().some(a => a && a.address === '::1');

(async () => {
  console.log('── P4: Vorgabe — nur dieser Rechner ──');
  let srv = await starten(PORT_VORGABE);
  try {
    let r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/health');
    ok('auf 127.0.0.1 erreichbar', r.status === 200, `${r.status} ${r.grund || ''}`);
    r = await req('localhost', PORT_VORGABE, 'GET', '/health');
    ok('über den Namen „localhost" erreichbar (so sprechen ihn Proxy, Tests und Werkzeuge an)', r.status === 200, `${r.status} ${r.grund || ''}`);
    r = await req('127.0.0.2', PORT_VORGABE, 'GET', '/health');
    ok('auf einer anderen Adresse des Rechners (127.0.0.2) NICHT erreichbar', r.status === 0 && r.grund === 'ECONNREFUSED', `${r.status} ${r.grund || ''}`);
    if (hatIPv6) {
      r = await req('::1', PORT_VORGABE, 'GET', '/health');
      ok('über IPv6 (::1) NICHT erreichbar', r.status === 0 && r.grund === 'ECONNREFUSED', `${r.status} ${r.grund || ''}`);
    } else ok('IPv6 auf diesem Rechner vorhanden (sonst bleibt die IPv6-Probe ungeprüft)', false, 'kein ::1');
    ok('Startzeile wie bisher', /Arbeitsdoku-Server läuft auf http:\/\/localhost:3401/.test(srv.ausgabe()), srv.ausgabe().slice(-200));
    ok('… dazu der Hinweis, dass er nur von diesem Rechner erreichbar ist', /Erreichbar nur von diesem Rechner \(127\.0\.0\.1\)/.test(srv.ausgabe()), srv.ausgabe().slice(-200));
    ok('… samt dem Weg heraus (LISTEN_HOST=0.0.0.0)', /LISTEN_HOST=0\.0\.0\.0/.test(srv.ausgabe()));

    console.log('── P9: unbekannte Adressen unter /api ──');
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      r = await req('127.0.0.1', PORT_VORGABE, m, '/api/gibtsnicht', {}, m === 'GET' || m === 'DELETE' ? undefined : { a: 1 });
      ok(`${m} /api/gibtsnicht → 404 als JSON mit Code`, r.status === 404 && r.body && r.body.code === 'UNBEKANNTE_ADRESSE' && /json/.test(r.kopf['content-type'] || ''),
        `${r.status} ${r.kopf && r.kopf['content-type']} ${(r.text || '').slice(0, 60)}`);
    }
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/api/gibtsnicht');
    ok('… mit einer Meldung für Menschen', typeof r.body?.error === 'string' && r.body.error.length > 5, JSON.stringify(r.body));
    ok('… und ohne Zwischenspeichern (no-store)', r.kopf['cache-control'] === 'no-store', r.kopf['cache-control']);
    ok('… nicht die Startseite', !/<html/i.test(r.text));
    for (const p of ['/api', '/api/', '/api/auth/gibtsnicht', '/api/gibts/nicht/tief?x=1', '/api/events/gibtsnicht']) {
      r = await req('127.0.0.1', PORT_VORGABE, 'GET', p);
      ok(`GET ${p} → 404 als JSON`, r.status === 404 && r.body?.code === 'UNBEKANNTE_ADRESSE', `${r.status} ${(r.text || '').slice(0, 60)}`);
    }
    r = await req('127.0.0.1', PORT_VORGABE, 'HEAD', '/api/gibtsnicht');
    ok('HEAD /api/gibtsnicht → 404', r.status === 404, String(r.status));

    console.log('── P9: was es gibt, bleibt ──');
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/api/legal');
    ok('GET /api/legal (öffentlich) → 200 JSON', r.status === 200 && r.body !== null, `${r.status} ${(r.text || '').slice(0, 60)}`);
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/api/entries');
    ok('GET /api/entries ohne Anmeldung → 401 (nicht 404)', r.status === 401, String(r.status));
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/api/events');
    ok('GET /api/events ohne Ticket → 401 (nicht 404)', r.status === 401, String(r.status));
    r = await req('127.0.0.1', PORT_VORGABE, 'POST', '/api/auth/login', {}, { username: 'niemand', password: 'falsch' });
    ok('POST /api/auth/login mit falschen Daten → 401', r.status === 401, String(r.status));
    for (const p of ['/', '/zeitnachweis', '/irgendwo/tief/drin', '/apix', '/apis/gibtsnicht']) {
      r = await req('127.0.0.1', PORT_VORGABE, 'GET', p);
      ok(`GET ${p} → weiter die App (200, HTML)`, r.status === 200 && /<html/i.test(r.text), `${r.status} ${(r.text || '').slice(0, 40)}`);
    }
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/gast');
    ok('GET /gast → weiter die Gastseite', r.status === 200 && /<html/i.test(r.text), String(r.status));

    console.log('── P10: kein „X-Powered-By" ──');
    const wege = [['GET', '/'], ['GET', '/health'], ['GET', '/api/gibtsnicht'], ['GET', '/api/legal'], ['GET', '/js/app-1-core.js'],
      ['GET', '/manifest.json'], ['POST', '/api/auth/login'], ['GET', '/gast'], ['GET', '/api/entries']];
    for (const [m, p] of wege) {
      r = await req('127.0.0.1', PORT_VORGABE, m, p, {}, m === 'POST' ? { username: 5 } : undefined);
      ok(`${m} ${p} (${r.status}) nennt Express nicht`, r.status > 0 && r.kopf['x-powered-by'] === undefined, r.kopf && r.kopf['x-powered-by']);
    }

    console.log('── P8: Strict-Transport-Security nur über https ──');
    const https = { 'X-Forwarded-Proto': 'https' };
    for (const [m, p] of wege) {
      const mit = await req('127.0.0.1', PORT_VORGABE, m, p, https, m === 'POST' ? { username: 5 } : undefined);
      const ohne = await req('127.0.0.1', PORT_VORGABE, m, p, {}, m === 'POST' ? { username: 5 } : undefined);
      ok(`${m} ${p}: über https gesetzt, über http nicht`, mit.kopf['strict-transport-security'] === 'max-age=31536000' && ohne.kopf['strict-transport-security'] === undefined,
        `https: ${mit.kopf['strict-transport-security']} · http: ${ohne.kopf['strict-transport-security']}`);
    }
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/', https);
    ok('ein Jahr, ohne includeSubDomains und ohne preload', /^max-age=31536000$/.test(r.kopf['strict-transport-security'] || ''), r.kopf['strict-transport-security']);
    r = await req('127.0.0.1', PORT_VORGABE, 'GET', '/', { 'X-Forwarded-Proto': 'http' });
    ok('Proxy meldet ausdrücklich http → nicht gesetzt', r.kopf['strict-transport-security'] === undefined, r.kopf['strict-transport-security']);
    ok('die übrigen Sicherheits-Kopfzeilen sind weiter da', !!r.kopf['content-security-policy'] && r.kopf['x-frame-options'] === 'DENY' && r.kopf['x-content-type-options'] === 'nosniff');
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  await srv.beenden();

  console.log('── P4: LISTEN_HOST=0.0.0.0 — der ausdrückliche Wunsch ──');
  srv = await starten(PORT_ALLE4, { LISTEN_HOST: '0.0.0.0' });
  try {
    let r = await req('127.0.0.1', PORT_ALLE4, 'GET', '/health');
    ok('auf 127.0.0.1 erreichbar', r.status === 200, `${r.status} ${r.grund || ''}`);
    r = await req('127.0.0.2', PORT_ALLE4, 'GET', '/health');
    ok('auf der anderen Adresse (127.0.0.2) jetzt AUCH — die Probe von oben kann also unterscheiden', r.status === 200, `${r.status} ${r.grund || ''}`);
    ok('Hinweis: direkt aus dem Netz erreichbar', /Lauscht auf 0\.0\.0\.0 — direkt aus dem Netz erreichbar/.test(srv.ausgabe()), srv.ausgabe().slice(-200));
    ok('… und NICHT „nur von diesem Rechner"', !/nur von diesem Rechner/.test(srv.ausgabe()));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  await srv.beenden();

  console.log('── P4: LISTEN_HOST=:: — wie früher, IPv4 und IPv6 ──');
  if (hatIPv6) {
    srv = await starten(PORT_ALLE6, { LISTEN_HOST: '::' });
    try {
      let r = await req('::1', PORT_ALLE6, 'GET', '/health');
      ok('über IPv6 (::1) erreichbar', r.status === 200, `${r.status} ${r.grund || ''}`);
      r = await req('127.0.0.2', PORT_ALLE6, 'GET', '/health');
      ok('über IPv4 (127.0.0.2) erreichbar', r.status === 200, `${r.status} ${r.grund || ''}`);
    } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
    await srv.beenden();
  } else ok('IPv6 auf diesem Rechner vorhanden', false, 'kein ::1');

  console.log('── P4: leerer Wert und ein fremdes HOST ändern nichts ──');
  // „HOST" setzen manche Umgebungen von sich aus (tcsh, conda). Der Server darf darauf nicht hören.
  srv = await starten(PORT_LEER, { LISTEN_HOST: '   ', HOST: '0.0.0.0' });
  try {
    let r = await req('127.0.0.1', PORT_LEER, 'GET', '/health');
    ok('LISTEN_HOST nur aus Leerzeichen → startet mit der Vorgabe', r.status === 200, `${r.status} ${r.grund || ''}`);
    r = await req('127.0.0.2', PORT_LEER, 'GET', '/health');
    ok('… und HOST=0.0.0.0 öffnet ihn NICHT', r.status === 0 && r.grund === 'ECONNREFUSED', `${r.status} ${r.grund || ''}`);
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  await srv.beenden();

  console.log('── P4: eine Adresse, die dieser Rechner nicht hat ──');
  // 192.0.2.1 liegt in einem Netz, das für Beispiele reserviert ist — kein Rechner trägt sie.
  aufraeumen(PORT_FALSCH);
  const falsch = spawnSync('node', ['server.js'], { cwd: WURZEL, timeout: 20000, encoding: 'utf8', env: umgebung(PORT_FALSCH, { LISTEN_HOST: '192.0.2.1' }) });
  aufraeumen(PORT_FALSCH);
  const ausgabe = (falsch.stdout || '') + (falsch.stderr || '');
  ok('der Server beendet sich mit Code 1', falsch.status === 1 && falsch.signal === null, `status ${falsch.status}, signal ${falsch.signal}`);
  ok('… meldet NICHT „läuft"', !/Server läuft auf/.test(ausgabe));
  ok('… sondern Adresse und Grund', /Adresse 192\.0\.2\.1, Port 3405\): EADDRNOTAVAIL/.test(ausgabe), ausgabe.split('\n').filter(z => /Port|EADDR/.test(z)).join(' | '));

  console.log(`\nServer-Härtung: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
