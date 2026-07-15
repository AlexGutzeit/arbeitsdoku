// UI-Test (Puppeteer): Urlaubstage/Start-Resturlaub akzeptieren Komma UND Punkt als Dezimaltrenner,
// locale-unabhängig (Browser hier auf en-US gezwungen, wo type=number ein Komma verwerfen würde).
// Prüft end-to-end: übers Formular getippt → korrekt als Dezimalzahl gespeichert.
//   node tests/vacation-comma-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3224, DB = '/tmp/vacation-comma-ui.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const daysFor = async (admin, uid, vf) => { const e = (await req('GET', `/api/statistics/vacation/${uid}`, admin)).body.entitlements.find(x => x.valid_from === vf); return e && e.days; };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/vacation-comma-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/vacation-comma-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const u = (await req('POST', '/api/users', admin, { username: 'komma', password: 'Test1234!', name: 'Komma', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US'] });
    const p = await browser.newPage(); await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en' });
    await p.setViewport({ width: 1000, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(800);
    await p.waitForSelector('.edit-user');
    await p.evaluate(id => document.querySelector(`.edit-user[data-id="${id}"]`).click(), u.id);
    await p.waitForSelector('#um-vac-days');
    await p.waitForFunction(() => { const s = document.getElementById('um-vac-stand'); return s && /Stand/.test(s.textContent); }, { timeout: 8000 });

    ok('Felder sind type=text inputmode=decimal (nicht number)', await p.evaluate(() => document.getElementById('um-vac-days').type === 'text' && document.getElementById('um-vac-days').inputMode === 'decimal'));

    // KOMMA übers Formular: 2,5 Tage ab 2025-01-01
    await p.evaluate(() => { document.getElementById('um-vac-days').value = ''; });
    await p.click('#um-vac-days'); await p.type('#um-vac-days', '2,5');
    ok('type=text behält Komma im Feld (en-Locale)', (await p.evaluate(() => document.getElementById('um-vac-days').value)) === '2,5');
    await p.evaluate(() => { document.getElementById('um-vac-from').value = '2025-01-01'; });
    await p.evaluate(() => document.getElementById('um-vac-add').click());
    await sleep(500);
    ok('Komma "2,5" → gespeichert als 2.5', (await daysFor(admin, u.id, '2025-01-01')) === 2.5, 'days=' + await daysFor(admin, u.id, '2025-01-01'));

    // PUNKT übers Formular: 3.5 Tage ab 2026-01-01
    await p.evaluate(() => { document.getElementById('um-vac-days').value = ''; });
    await p.click('#um-vac-days'); await p.type('#um-vac-days', '3.5');
    await p.evaluate(() => { document.getElementById('um-vac-from').value = '2026-01-01'; });
    await p.evaluate(() => document.getElementById('um-vac-add').click());
    await sleep(500);
    ok('Punkt "3.5" → gespeichert als 3.5', (await daysFor(admin, u.id, '2026-01-01')) === 3.5, 'days=' + await daysFor(admin, u.id, '2026-01-01'));

    // Start-Resturlaub mit Komma: 1,5
    await p.evaluate(() => { document.getElementById('um-vac-startcarry').value = ''; });
    await p.click('#um-vac-startcarry'); await p.type('#um-vac-startcarry', '1,5');
    await p.evaluate(() => document.getElementById('um-vac-startcarry-save').click());
    await sleep(500);
    ok('Start-Resturlaub Komma "1,5" → gespeichert als 1.5', (await req('GET', `/api/statistics/vacation/${u.id}`, admin)).body.start_carry === 1.5);

    // Zeilen-Edit zeigt Komma + speichert Komma: 2,5 → auf 4,25 ändern
    const row25 = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#um-vac-list tr[data-vac-id]')].find(t => t.querySelector('.vac-from').value === '2025-01-01');
      return tr.querySelector('.vac-days').value;
    });
    ok('Zeilen-Feld zeigt gespeicherten Wert mit Komma (2,5)', row25 === '2,5', 'value=' + row25);
    await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#um-vac-list tr[data-vac-id]')].find(t => t.querySelector('.vac-from').value === '2025-01-01');
      tr.querySelector('.vac-days').value = '4,25';
      tr.querySelector('.save-vac').click();
    });
    await sleep(500);
    ok('Zeilen-Edit Komma "4,25" → gespeichert als 4.25', (await daysFor(admin, u.id, '2025-01-01')) === 4.25, 'days=' + await daysFor(admin, u.id, '2025-01-01'));

  } catch (e) { fail++; fails.push('EXCEPTION: ' + e.message); console.log('  ✗ EXCEPTION: ' + e.message); }
  finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nVacation-Comma-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
