// Anmeldemaske: Ist ein Konto gebremst, sagt die Maske, wie lange — und danach kommt der Richtige hinein.
//
// Seit dem 11.11.2026 bremst der Server viele Fehlversuche auf EIN Konto (kontobremse.js; die
// Regeln selbst prüft tests/anmeldung-eingang.js). Den echten Nutzer trifft das, wenn gerade jemand
// sein Konto durchprobiert: Er tippt das RICHTIGE Passwort und wird trotzdem abgewiesen. Dann muss
// die Maske ihm sagen, dass er warten soll und wie lange — „Ungültige Anmeldedaten" würde ihn an
// seinem Passwort zweifeln lassen.
//
// Die Fehlversuche des „Angreifers" kommen per API von fremden Adressen, der Nutzer tippt im Browser.
//   node tests/anmelde-bremse-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const CHROME = require('./hilfen/chrome');
const PORT = 3399, DB = '/tmp/anmelde-bremse-ui.db', LOG = '/tmp/anmelde-bremse-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let adresse = 0;
function req(m, p, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      'X-Forwarded-For': `198.51.100.${++adresse}`, ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/max\s+->\s+(\S+)/) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => fehler.push(String(e && e.message || e)));
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');

    const meldung = () => page.evaluate(() => { const el = document.getElementById('login-error');
      return el && el.checkVisibility() ? el.textContent.trim() : ''; });
    const absenden = async (passwort) => {
      await page.evaluate(() => { document.getElementById('login-user').value = ''; document.getElementById('login-pass').value = '';
        const el = document.getElementById('login-error'); el.textContent = ''; el.style.display = 'none'; });
      await page.type('#login-user', 'max'); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
    };
    const angemeldet = () => page.evaluate(() => !!localStorage.getItem('token') && !document.getElementById('login-user'));

    console.log('── Jemand probiert das Konto durch (per API, jede Anfrage von einer anderen Adresse) ──');
    // 5 Versuche frei, dann 1 s, 2 s, 4 s Pause — nach dem achten Versuch sind es 8 s: genug Zeit zum Tippen.
    const stati = [];
    for (let i = 1; i <= 5; i++) stati.push((await req('POST', '/api/auth/login', { username: 'max', password: 'geraten' + i })).status);
    for (const warten of [1100, 2100, 4100]) { await sleep(warten); stati.push((await req('POST', '/api/auth/login', { username: 'max', password: 'geraten' })).status); }
    ok('acht geprüfte Fehlversuche (je 401)', stati.length === 8 && stati.every(s => s === 401), stati.join(','));

    console.log('── Der echte Nutzer tippt sein richtiges Passwort ──');
    await absenden(pw);
    await page.waitForFunction(() => { const el = document.getElementById('login-error'); return el && el.textContent.trim() !== ''; });
    let text = await meldung();
    ok('die Maske sagt „Zu viele Fehlversuche für dieses Konto"', /Zu viele Fehlversuche für dieses Konto/.test(text), text);
    const sek = Number((text.match(/in (\d+) Sekunden/) || [])[1]);
    ok('… und nennt die Wartezeit in Sekunden (höchstens 8)', sek >= 1 && sek <= 8, text);
    ok('nicht „Ungültige Anmeldedaten" — sein Passwort war ja richtig', !/Ungültige/.test(text), text);
    ok('er steht weiter in der Anmeldemaske, kein Token gespeichert', !(await angemeldet()) && !(await page.evaluate(() => localStorage.getItem('token'))));
    ok('das Passwortfeld ist noch da (kein leerer Bildschirm)', !!(await page.$('#login-pass')));

    console.log('── Nach der genannten Wartezeit ──');
    await sleep(sek * 1000 + 300);
    await absenden(pw);
    await page.waitForFunction(() => !document.getElementById('login-user'), { timeout: 15000 }).catch(() => {});
    ok('dasselbe Passwort führt jetzt hinein', await angemeldet(), await meldung());
    ok('keine Skriptfehler auf der Seite', fehler.length === 0, fehler.slice(0, 2).join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAnmeldebremse im Browser: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
