// Test Bugliste v6, Runde 2 (API + UI):
//  A7a Mehrtages-Dedup greift nur bei WIRKLICH identischen Tagen ("Mo+Di" dann "Mo+Mi" → zwei Planungen).
//  A5  Zweimal Abwesenheits-Dialog öffnen → nur EIN Overlay.
//  A7b SSE-Neuaufbau zerstört kein offenes Formular (_editorBusy).
//  B5  Enter bestätigt destruktive Dialoge NICHT; Fokus liegt auf „Abbrechen".
// Start: node tests/bugliste-v6b-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3125, DB = '/tmp/v6b-ui.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
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
  const lg = fs.openSync('/tmp/v6b-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/v6b-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'v6bma', password: 'Test1234!', name: 'V6b MA', role: 'mitarbeiter' })).body.user;

    // ── A7a: Mehrtages-Dedup ──
    console.log('A7a — Mehrtages-Dedup nur bei gleichen Tagen:');
    const base = { address: '', client: 'Kunde X', assigned_user_ids: [ma.id] };
    const r1 = await req('POST', '/api/planning', admin, { ...base, days: [{ date: '2027-08-02', time_from: '07:00', time_to: '16:00' }, { date: '2027-08-03', time_from: '07:00', time_to: '16:00' }] });
    ok('erste Planung (Mo+Di) angelegt', r1.status === 201, 'status=' + r1.status);
    // sofort danach: gleicher erster Tag, ANDERER zweiter Tag → muss eine EIGENE Planung werden
    const r2 = await req('POST', '/api/planning', admin, { ...base, days: [{ date: '2027-08-02', time_from: '07:00', time_to: '16:00' }, { date: '2027-08-04', time_from: '07:00', time_to: '16:00' }] });
    ok('zweite Planung (Mo+Mi) NICHT als Dublette geschluckt', r2.status === 201 && !r2.body.deduped, JSON.stringify(r2.body));
    const mi = ((await req('GET', '/api/planning?date_from=2027-08-04&date_to=2027-08-04', admin)).body.entries || []).length;
    ok('Mittwoch existiert wirklich', mi === 1, 'anzahl=' + mi);
    // echte Dublette (identische Tage) wird weiterhin geschluckt
    const r3 = await req('POST', '/api/planning', admin, { ...base, days: [{ date: '2027-08-02', time_from: '07:00', time_to: '16:00' }, { date: '2027-08-03', time_from: '07:00', time_to: '16:00' }] });
    ok('echte Dublette wird weiterhin erkannt', r3.body && r3.body.deduped === true, JSON.stringify(r3.body));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ── A5: nur ein Abwesenheits-Overlay ──
    console.log('A5 — kein doppelter Abwesenheits-Dialog:');
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(1200);
    await p.evaluate(() => { showAbsenceForm(null, 'krank', null, null, null); showAbsenceForm(null, 'urlaub', null, null, null); });
    await sleep(400);
    const overlays = await p.evaluate(() => document.querySelectorAll('.absence-form-overlay').length);
    ok('nur EIN Overlay im DOM', overlays === 1, 'anzahl=' + overlays);
    const typ = await p.evaluate(() => document.getElementById('abs-type')?.value);
    ok('sichtbares Formular ist das zuletzt geöffnete (urlaub)', typ === 'urlaub', 'typ=' + typ);
    await p.evaluate(() => document.getElementById('abs-cancel')?.click()); await sleep(200);

    // ── A7b: SSE zerstört kein offenes Formular ──
    console.log('A7b — offenes Formular überlebt Live-Update:');
    const busy = await p.evaluate(() => {
      const area = document.createElement('div'); area.id = 'order-form-area'; area.innerHTML = '<input id="tmp-x">';
      document.querySelector('.main').appendChild(area);
      const r = _editorBusy('#order-form-area');
      area.remove(); return r;
    });
    ok('_editorBusy erkennt offenes Formular', busy === true);
    const idle = await p.evaluate(() => { document.activeElement?.blur?.(); return _editorBusy('#order-form-area'); });
    ok('ohne Formular/Fokus → kein Block', idle === false);

    // ── B5: destruktiver Dialog ──
    console.log('B5 — Enter bestätigt Löschen nicht:');
    const b5 = await p.evaluate(async () => {
      const promise = confirmModal('Wirklich löschen?', { title: 'Löschen', danger: true });
      await new Promise(r => setTimeout(r, 150));
      const focusCancel = document.activeElement?.dataset?.act === 'cancel';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      const stillOpen = !!document.querySelector('.dialog-modal');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const result = await promise;
      return { focusCancel, stillOpen, result };
    });
    ok('Fokus liegt auf „Abbrechen"', b5.focusCancel);
    ok('Enter schließt den Lösch-Dialog NICHT', b5.stillOpen);
    ok('Escape bricht ab (false)', b5.result === false);
    const b5ok = await p.evaluate(async () => {
      const promise = confirmModal('Fortfahren?', { title: 'Hinweis', danger: false });
      await new Promise(r => setTimeout(r, 150));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return await promise;
    });
    ok('bei harmlosen Dialogen bestätigt Enter weiterhin', b5ok === true);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBugliste-v6b-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
