// UI-Test (Puppeteer): Passwort-Policy im Anlege-Formular — Live-Checkliste (✓/✗), Feld-Einfärbung (rot/grün),
// Blockade bei schwachem Passwort, Anlegen mit starkem Passwort. + Screenshot des Mischzustands.
//   node tests/password-policy-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3221, DB = '/tmp/password-policy-ui.db', BASE = 'http://localhost:' + PORT;
const OUT = '/tmp/claude-1000/-home-alex-zeug-arbeitsdoku/84cc3a6c-bbc9-43b1-ae98-766adee26b4e/scratchpad';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.mkdirSync(OUT, { recursive: true });
  const lg = fs.openSync('/tmp/password-policy-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/password-policy-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(800);
    await p.waitForSelector('#add-user-btn');
    await p.evaluate(() => document.getElementById('add-user-btn').click());
    await p.waitForSelector('#um-password'); await p.waitForSelector('#um-pw-reqs');

    // 5 Bedingungen gelistet
    ok('Checkliste zeigt 5 Bedingungen', await p.$$eval('#um-pw-reqs li', els => els.length) === 5);

    // Schwaches Passwort → nur teilweise erfüllt, Feld rot
    await p.type('#um-password', 'Test12');  // 6 Zeichen: Länge ✗, Sonderzeichen ✗; Groß/Klein/Ziffer ✓
    await sleep(150);
    let st = await p.evaluate(() => ({
      ok: document.querySelectorAll('#um-pw-reqs li.ok').length,
      bad: document.querySelectorAll('#um-pw-reqs li.bad').length,
      invalid: document.getElementById('um-password').classList.contains('pw-invalid'),
    }));
    ok('Mischzustand: 3 erfüllt (✓), 2 offen (✗)', st.ok === 3 && st.bad === 2, JSON.stringify(st));
    ok('Feld rot (pw-invalid) bei unvollständigem Passwort', st.invalid, JSON.stringify(st));
    // Screenshot des Mischzustands
    await (await p.$('.modal') || p).screenshot({ path: path.join(OUT, '12-pw-policy.png') });

    // Anlegen mit schwachem Passwort → blockiert (kein Nutzer angelegt)
    await p.type('#um-username', 'neuling'); await p.type('#um-name', 'Neuling');
    await p.type('#um-password-repeat', 'Test12');
    await p.evaluate(() => document.querySelector('#user-modal-form button[type="submit"]').click());
    await sleep(400);
    ok('Anlegen mit schwachem Passwort blockiert (kein Nutzer)', !(await req('GET', '/api/users', admin)).body.users.some(u => u.username === 'neuling'));

    // Starkes Passwort → alle grün, Feld grün, Anlegen klappt
    await p.evaluate(() => { document.getElementById('um-password').value = ''; document.getElementById('um-password-repeat').value = ''; });
    await p.type('#um-password', 'Test1234!');
    await sleep(150);
    st = await p.evaluate(() => ({ ok: document.querySelectorAll('#um-pw-reqs li.ok').length, valid: document.getElementById('um-password').classList.contains('pw-valid') }));
    ok('Starkes Passwort: alle 5 ✓ und Feld grün (pw-valid)', st.ok === 5 && st.valid, JSON.stringify(st));
    await p.type('#um-password-repeat', 'Test1234!');
    await p.evaluate(() => document.querySelector('#user-modal-form button[type="submit"]').click());
    await sleep(600);
    ok('Anlegen mit starkem Passwort erfolgreich', (await req('GET', '/api/users', admin)).body.users.some(u => u.username === 'neuling'));

  } catch (e) { fail++; fails.push('EXCEPTION: ' + e.message); console.log('  ✗ EXCEPTION: ' + e.message); }
  finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPassword-Policy-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
