// Anmelde-Schleife durch den Browser-Zwischenspeicher (Alex, 01.10.2026).
//
// Alex' PWA warf ihn nach JEDER Anmeldung sofort wieder heraus: „Deine Sitzung ist abgelaufen". Website-Daten
// löschen half nicht, Vivaldi ging. Ursache: Chrome hob API-Antworten mit ETag auf und lieferte bei „304 —
// unverändert" die GESPEICHERTE Antwort samt ihrer alten Kopfzeilen aus, auch ein altes `X-Neues-Token` der
// gleitenden Sitzung. Die App übernahm es; dessen Anmeldung lag schon über der Höchstdauer (bei Alex 7 Tage,
// Zwei-Faktor wöchentlich) → 401 → abgemeldet. Zwei Sicherungen seitdem, beide hier einzeln geprüft:
//   A  Server: API-Antworten ohne ETag und mit `Cache-Control: no-store` — also nie ein 304.
//   B  App: tokenUebernehmen (und der Abgleich zwischen Tabs) nimmt nur ein NEUERES, noch gültiges Token.
//   C  Der ganze Ablauf in der echten App: Sitzung kurz vor der Höchstdauer, Antworten mit X-Neues-Token
//      landen im Zwischenspeicher, die Sitzung läuft ab, Neuanmeldung → man BLEIBT angemeldet.
//
//   node tests/sitzung-zwischenspeicher-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');

const PORT = 3365, DB = '/tmp/sitzung-zwischenspeicher-ui.db', LOG = '/tmp/sitzung-zwischenspeicher-ui.log';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, extra) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}), ...(extra || {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, headers: x.headers }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null, headers: {} }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const jetztS = () => Math.floor(Date.now() / 1000);
const token = (userId, { iat, anmeldung, exp }) => jwt.sign({ userId, role: 'mitarbeiter', sitzung: 0, anmeldung, iat, exp }, SECRET);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const tim = (await req('POST', '/api/users', admin, { username: 'tim', password: 'Test1234!', name: 'Tim Tester', role: 'mitarbeiter' })).body.user;

    console.log('A · Server: API-Antworten werden nicht zwischengespeichert');
    const t1 = (await req('POST', '/api/auth/login', null, { username: 'tim', password: 'Test1234!' })).body.token;
    const me = await req('GET', '/api/auth/me', t1);
    ok('GET /api/auth/me: Cache-Control no-store, kein ETag', me.status === 200 && /no-store/.test(me.headers['cache-control'] || '') && !me.headers.etag,
      JSON.stringify({ cc: me.headers['cache-control'], etag: me.headers.etag }));
    const bedingt = await req('GET', '/api/badges', t1, null, { 'If-None-Match': 'W/"irgendwas"' });
    ok('mit If-None-Match gibt es trotzdem kein 304', bedingt.status === 200, String(bedingt.status));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    p.on('pageerror', e => jsFehler.push(e.message));
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    p.setDefaultTimeout(15000);
    const antworten = []; let phase = 'alt';
    p.on('response', r => { if (r.url().includes('/api/')) antworten.push({ phase, s: r.status(), u: r.url().replace(BASIS, '').split('?')[0], neu: !!r.headers()['x-neues-token'] }); });

    console.log('B · App: nur ein NEUERES, gültiges Token übernehmen');
    await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'tim'); await p.type('#login-pass', 'Test1234!');
    await p.click('#login-form button[type="submit"]');
    await p.waitForFunction(() => document.querySelector('.main')); await sleep(800);
    const jetzt = jetztS();
    const aelter = token(tim.id, { iat: jetzt - 3 * 86400, anmeldung: jetzt - 3 * 86400, exp: jetzt + 86400 });
    const neuer = token(tim.id, { iat: jetzt + 5, anmeldung: jetzt, exp: jetzt + 86400 });
    const neuerAbgelaufen = token(tim.id, { iat: jetzt + 6, anmeldung: jetzt, exp: jetzt - 10 });
    const probe = (t, art) => p.evaluate((t, art) => {
      const vorher = S.token;
      if (art === 'kopf') tokenUebernehmen(t);
      else window.dispatchEvent(new StorageEvent('storage', { key: 'token', newValue: t }));
      const uebernommen = S.token === t;
      S.token = vorher;
      return uebernommen;
    }, t, art);
    ok('X-Neues-Token: ein ÄLTERES wird nicht übernommen', !(await probe(aelter, 'kopf')));
    ok('… ein abgelaufenes auch nicht, selbst wenn es neuer ist', !(await probe(neuerAbgelaufen, 'kopf')));
    ok('… ein neueres, gültiges schon', await probe(neuer, 'kopf'));
    ok('anderer Tab (storage): ein älteres nicht, ein neueres schon', !(await probe(aelter, 'tab')) && await probe(neuer, 'tab'));

    console.log('C · Der ganze Ablauf: Sitzung läuft ab, Neuanmeldung bleibt bestehen');
    // Angemeldet vor 30 Tagen minus 40 s (Höchstdauer ohne Zwei-Faktor: 30 Tage), Token 2 Stunden alt →
    // der Server legt jeder Antwort ein frisches Token bei, dessen Anmeldung ebenso bald abläuft.
    const jetzt2 = jetztS();
    const alt = token(tim.id, { iat: jetzt2 - 7200, anmeldung: jetzt2 - 30 * 86400 + 40, exp: jetzt2 + 86400 });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u)); },
      alt, { id: tim.id, username: 'tim', name: 'Tim Tester', role: 'mitarbeiter' });
    await p.evaluate(() => { location.hash = '/welcome'; }); await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3500);
    for (const h of ['/meldungen', '/welcome']) { await p.evaluate(x => { location.hash = x; }, h); await sleep(1800); }
    ok('Vorbereitung: der Server hat erneuerte Tokens mitgeschickt', antworten.some(a => a.phase === 'alt' && a.neu),
      antworten.filter(a => a.phase === 'alt').map(a => a.s + (a.neu ? '+Token' : '') + ' ' + a.u).join(' | ').slice(0, 300));
    const warten = (jetzt2 + 46 - jetztS()) * 1000;
    if (warten > 0) await sleep(warten);
    phase = 'ablauf';
    await p.evaluate(() => { location.hash = '/meldungen'; }); await sleep(2500);
    ok('Sitzung abgelaufen → Anmeldeseite', !!(await p.$('#login-user')));
    phase = 'neu';
    await p.type('#login-user', 'tim'); await p.type('#login-pass', 'Test1234!');
    await p.click('#login-form button[type="submit"]');
    await sleep(6000);
    const wo = await p.evaluate(() => ({ hash: location.hash, anmeldeseite: !!document.querySelector('#login-user') }));
    const neu = antworten.filter(a => a.phase === 'neu');
    ok('nach der Neuanmeldung bleibt man angemeldet (keine Schleife)', !wo.anmeldeseite && wo.hash !== '#/login',
      JSON.stringify(wo) + ' · ' + neu.map(a => a.s + ' ' + a.u).join(' | ').slice(0, 400));
    ok('… kein 304 und kein 401 auf /api nach der Neuanmeldung', neu.length > 3 && !neu.some(a => a.s === 304 || a.s === 401),
      neu.map(a => a.s + ' ' + a.u).join(' | ').slice(0, 400));

    console.log('Protokoll');
    const logs = ((await req('GET', '/api/audit?limit=200', admin)).body || {}).logs || [];
    const abgelaufen = logs.find(l => l.action === 'session_expired' && l.username === 'tim');
    ok('„Sitzung abgelaufen" nennt Anfrage und Alter des Tokens', !!abgelaufen && /· (GET|POST) \/api\/\S+ · Token .+ alt, angemeldet vor 30 Tage/.test(abgelaufen.details || ''),
      abgelaufen && abgelaufen.details);

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nAnmelde-Schleife durch den Zwischenspeicher: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
