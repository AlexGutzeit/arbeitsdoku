// Der Menüpunkt hinter #/pdf heißt je nach Rolle anders.
//
// Mitarbeiter finden dort nur den PDF-Download ihrer eigenen Zeiten → „PDF-Nachweis".
// Chef/Admin/Buchhalter zusätzlich Lohn-Export und Abrechnungs-Abschluss → „Abrechnung".
//
// Der heikle Fall ist der **Buchhalter**: Er ist weder Chef noch Admin, sieht aber beide
// Zusatzblöcke. Wird die Beschriftung versehentlich an die Einstellungen-Rolle gehängt, bekäme
// gerade er den falschen Namen — deshalb wird jede Rolle einzeln geprüft, samt der Blöcke auf der
// Seite: Beschriftung und Inhalt dürfen nicht auseinanderlaufen.
//
//   node tests/menue-abrechnung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3213, DB = '/tmp/menue-abrechnung.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/menue-abrechnung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/menue-abrechnung-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const b = await req('POST', '/api/users', admin.token,
      { username: 'buchi', password: 'Start!2345', name: 'Bea Buch', role: 'buchhalter', target_hours_per_week: 40 });
    if (b.status >= 300) throw new Error('Buchhalter: ' + b.text);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 950 });
    page.setDefaultTimeout(45000);

    async function alsRolle(name, passwort) {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', name); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
      const beschriftung = await page.evaluate(() => {
        const a = document.querySelector('a[href="#/pdf"]');
        return a ? a.textContent.replace(/\s+/g, ' ').trim() : '(kein Menüpunkt)';
      });
      await page.goto(BASIS + '/#/pdf', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pdf-form'); await sleep(700);
      const seite = await page.evaluate(() => document.querySelector('.main').innerText);
      return { beschriftung, seite };
    }

    for (const [nutzer, passwort, erwartet, mitAbrechnung] of [
      // Erwartet wird der volle Text INKLUSIVE Symbol — so ist gleich mitgeprüft, dass auch das
      // Symbol wechselt (Blatt fuer den Nachweis, Beleg fuer die Abrechnung).
      ['max',   pw('max'),     '📄 PDF-Nachweis', false],
      ['chef',  pw('chef'),    '🧾 Abrechnung',   true],
      ['admin', pw('admin'),   '🧾 Abrechnung',   true],
      ['buchi', 'Start!2345',  '🧾 Abrechnung',   true],
    ]) {
      const r = await alsRolle(nutzer, passwort);
      ok(`${nutzer.padEnd(6)} sieht „${erwartet}"`, r.beschriftung === erwartet, `steht da: „${r.beschriftung}"`);
      ok(`   … und der PDF-Block ist da`, /PDF-Export/.test(r.seite));
      ok(`   … Lohn-Export ${mitAbrechnung ? 'sichtbar' : 'NICHT sichtbar'}`,
        /Lohn-Export/.test(r.seite) === mitAbrechnung);
      ok(`   … Abrechnungs-Abschluss ${mitAbrechnung ? 'sichtbar' : 'NICHT sichtbar'}`,
        /Abrechnungs-Abschluss/.test(r.seite) === mitAbrechnung);
    }

    ok('Das alte Wort „Export" steht nirgends mehr im Menü',
      !(await page.evaluate(() => {
        const a = document.querySelector('a[href="#/pdf"]');
        return a ? /(^|\s)Export(\s|$)/.test(a.textContent) : false;
      })));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nMenü „Abrechnung": ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
