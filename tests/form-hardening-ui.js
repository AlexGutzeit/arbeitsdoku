// Puppeteer-UI-Test (B3 + B4):
//  B3: Doppel-Submit im Mitarbeiter-Formular sendet nur EINEN POST /api/users.
//  B4: Ungültige Urlaubstage-Eingabe wird abgefangen (Toast, KEIN POST), gültige Eingabe geht durch.
// Start: node tests/form-hardening-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3121, DB = '/tmp/form-hardening.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, x => { let s = ''; x.on('data', d => s += d); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
const tok = async (u, pw = 'Test1234!') => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
const setVal = (page, sel, val) => page.evaluate((s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, val);
const toastText = (page) => page.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; });
const today = new Date().toLocaleDateString('sv-SE');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/form-hardening-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    // Auf die Passwortzeile WARTEN, nicht bloss einmal nachsehen: /health antwortet, bevor die
    // Startpasswoerter im Protokoll stehen. Wurde hier zu frueh gelesen, war `apw` undefiniert —
    // der Test lief dann bis in die Anmeldemaske und starb dort an `type(undefined)`, was wie ein
    // Oberflaechenfehler aussieht und keiner ist. Genau so ist er am 23.08.2026 umgefallen.
    let apw;
    for (let i = 0; i < 150; i++) {
      apw = (fs.readFileSync('/tmp/form-hardening-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
      if (apw) break;
      await sleep(200);
    }
    if (!apw) throw new Error('Startpasswort des Admins nicht im Serverprotokoll gefunden');
    const admin = await tok('admin', apw);
    const target = (await req('POST', '/api/users', admin, { username: 'b4target', password: 'Test1234!', name: 'B4 Target', role: 'mitarbeiter' })).body.user;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 900 });
    let userPosts = 0, vacPosts = 0;
    p.on('request', r => {
      if (r.method() === 'POST' && /\/api\/users$/.test(r.url())) userPosts++;
      if (r.method() === 'POST' && /\/api\/statistics\/vacation\//.test(r.url())) vacPosts++;
    });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(800);

    // ── B3: Doppel-Submit ──
    console.log('B3 — Doppel-Submit-Schutz:');
    await p.waitForSelector('#add-user-btn'); await p.click('#add-user-btn'); await sleep(500);
    await p.waitForSelector('#um-password');
    await setVal(p, '#um-name', 'Doppel Klick');
    await setVal(p, '#um-username', 'doppelklick');
    await setVal(p, '#um-password', 'Test1234!');
    await setVal(p, '#um-password-repeat', 'Test1234!');
    // Zwei Submits synchron auslösen → zweiter muss durch disabled-Guard blockiert werden
    await p.evaluate(() => { const f = document.getElementById('user-modal-form'); f.requestSubmit(); f.requestSubmit(); });
    await sleep(1500);
    ok('nur EIN POST /api/users trotz doppeltem Submit', userPosts === 1, 'posts=' + userPosts);
    ok('Nutzer genau einmal angelegt', (await req('GET', '/api/users', admin)).body.users.filter(u => u.username === 'doppelklick').length === 1);

    // ── B4: Urlaubstage-Validierung (Edit-Modus) ──
    console.log('B4 — Urlaubstage-Validierung:');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(600);
    await p.waitForSelector(`.edit-user[data-id="${target.id}"]`); await p.click(`.edit-user[data-id="${target.id}"]`); await sleep(700);
    await p.waitForSelector('#um-vac-add');
    await setVal(p, '#um-vac-from', today);
    // Ungültig → Toast, kein POST
    await setVal(p, '#um-vac-days', 'abc');
    await p.click('#um-vac-add'); await sleep(500);
    ok('ungültige Tage → Toast', /gültige Zahl/i.test(await toastText(p)), 'Toast: ' + (await toastText(p)));
    ok('ungültige Tage → KEIN POST', vacPosts === 0, 'vacPosts=' + vacPosts);
    // Gültig (Komma) → POST
    await setVal(p, '#um-vac-days', '12,5');
    await p.click('#um-vac-add'); await sleep(700);
    ok('gültige Komma-Zahl → genau ein POST', vacPosts === 1, 'vacPosts=' + vacPosts);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nForm-Hardening-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
