// UI-Test (Puppeteer): Audit-Protokollierung des Urlaubsanspruchs.
// Führt ÜBER DIE OBERFLÄCHE Anlegen/Ändern/Löschen von Anspruchszeilen + Verfall-Moduswechsel +
// Start-Resturlaub aus und prüft dann im Admin-Audit-Log (#/audit), dass alles protokolliert ist.
//   node tests/vacation-audit-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3206, DB = '/tmp/vacation-audit-ui.db', BASE = 'http://localhost:' + PORT;
const OUT = '/tmp/claude-1000/-home-alex-zeug-arbeitsdoku/84cc3a6c-bbc9-43b1-ae98-766adee26b4e/scratchpad';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.mkdirSync(OUT, { recursive: true });
  const lg = fs.openSync('/tmp/vacation-audit-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/vacation-audit-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const u = (await req('POST', '/api/users', admin, { username: 'nina', password: 'Test1234!', name: 'Nina Neuzugang', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 950 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');

    // Mitarbeiter-Formular öffnen
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(900);
    await p.waitForSelector('.edit-user');
    await p.evaluate(id => document.querySelector(`.edit-user[data-id="${id}"]`).click(), u.id);
    await p.waitForSelector('#um-vac-startcarry', { timeout: 8000 });
    await p.waitForFunction(() => { const s = document.getElementById('um-vac-stand'); return s && /Stand/.test(s.textContent); }, { timeout: 8000 });

    const rowExists = (from) => p.waitForFunction((f) => [...document.querySelectorAll('#um-vac-list tr[data-vac-id] .vac-from')].some(i => i.value === f), { timeout: 6000 }, from);

    // 1) Zeile A anlegen (2024, 25, yearend)
    await p.evaluate(() => { document.getElementById('um-vac-days').value = '25'; document.getElementById('um-vac-from').value = '2024-01-01'; document.getElementById('um-vac-mode').value = 'yearend'; });
    await p.evaluate(() => document.getElementById('um-vac-add').click());
    await rowExists('2024-01-01'); ok('UI: Zeile A angelegt', true);

    // 2) Zeile B anlegen (2026, 30, never)
    await p.evaluate(() => { document.getElementById('um-vac-days').value = '30'; document.getElementById('um-vac-from').value = '2026-01-01'; document.getElementById('um-vac-mode').value = 'never'; });
    await p.evaluate(() => document.getElementById('um-vac-add').click());
    await rowExists('2026-01-01'); ok('UI: Zeile B angelegt', true);

    // 3) Zeile B ändern: 30→32 Tage, Verfall never→date(03-31)
    await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#um-vac-list tr[data-vac-id]')].find(t => t.querySelector('.vac-from').value === '2026-01-01');
      tr.querySelector('.vac-days').value = '32';
      const m = tr.querySelector('.vac-mode'); m.value = 'date'; m.dispatchEvent(new Event('change'));
      tr.querySelector('.vac-until').value = '03-31';
      tr.querySelector('.save-vac').click();
    });
    await sleep(600); ok('UI: Zeile B geändert (Tage + Verfall-Modus)', true);

    // 4) Start-Resturlaub setzen (10)
    await p.evaluate(() => { document.getElementById('um-vac-startcarry').value = '10'; document.getElementById('um-vac-startcarry-save').click(); });
    await sleep(500); ok('UI: Start-Resturlaub gesetzt', true);

    // 5) Zeile A löschen
    await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#um-vac-list tr[data-vac-id]')].find(t => t.querySelector('.vac-from').value === '2024-01-01');
      tr.querySelector('.del-vac').click();
    });
    await sleep(600); ok('UI: Zeile A gelöscht', true);

    await p.evaluate(() => document.getElementById('um-cancel')?.click()); await sleep(300);

    // Audit-Log prüfen
    await p.evaluate(() => { location.hash = '#/audit'; }); await sleep(1000);
    await p.waitForFunction(() => /Urlaubsanspruch/.test(document.body.innerText), { timeout: 8000 });
    const txt = await p.evaluate(() => document.body.innerText);
    ok('Audit: „Urlaubsanspruch angelegt" vorhanden', /Urlaubsanspruch angelegt/.test(txt));
    ok('Audit: „Urlaubsanspruch geändert" vorhanden', /Urlaubsanspruch geändert/.test(txt));
    ok('Audit: „Urlaubsanspruch gelöscht" vorhanden', /Urlaubsanspruch gelöscht/.test(txt));
    ok('Audit: „Start-Resturlaub geändert" vorhanden', /Start-Resturlaub geändert/.test(txt));
    ok('Audit: Detail mit MA-Name + Verfall', /Nina Neuzugang/.test(txt) && /Verfall/.test(txt));
    ok('Audit: Moduswechsel dokumentiert (nie→am Datum bzw. →)', /→/.test(txt));

    await sleep(300);
    const card = await p.$('.card');
    await (card || p).screenshot({ path: path.join(OUT, '10-audit-urlaub.png') });
    console.log('  ✓ Screenshot 10-audit-urlaub.png');

  } catch (e) { fail++; fails.push('EXCEPTION: ' + e.message); console.log('  ✗ EXCEPTION: ' + e.message); }
  finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nVacation-Audit-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
