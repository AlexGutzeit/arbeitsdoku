// Puppeteer-UI-Test:
//  #1  Dashboard-Zeitliste aktualisiert sich LIVE (SSE 'entries') ohne Neuladen, wenn ein Eintrag entsteht.
//  #9  Mitarbeiter-Formular blendet den Einzelrechte-Block für Chef/Admin aus (Hinweis statt Checkboxen).
// Start: node tests/live-dashboard-and-rights-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3119, DB = '/tmp/live-dash-rights.db', BASE = 'http://localhost:' + PORT;
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
async function waitFor(page, fn, arg, timeout = 7000) { const s = Date.now(); while (Date.now() - s < timeout) { if (await page.evaluate(fn, arg)) return true; await sleep(250); } return false; }
async function loginPage(browser, u, pw, hash) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage(); await p.setViewport({ width: 1200, height: 800 });
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
  await p.evaluate(h => { location.hash = h; }, hash); await sleep(1200); // Route + SSE
  return p;
}
const visible = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? getComputedStyle(el).display !== 'none' : null; }, sel);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/live-dash-rights-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/live-dash-rights-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = await tok('admin', apw);
    const ma = (await req('POST', '/api/users', admin, { username: 'malive', password: 'Test1234!', name: 'MA Live', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    ok('Setup: admin + MA', !!(admin && ma));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // ── #1: Dashboard live ──────────────────────────────────────────────────────
    console.log('#1 — Dashboard-Zeitliste live:');
    const pMa = await loginPage(browser, 'malive', 'Test1234!', '#/dashboard');
    const before = await pMa.evaluate(() => document.querySelectorAll('[data-entry-id]').length);
    // Eintrag für HEUTE über einen ANDEREN Client (kein Tab → Broadcast rendert die MA-Seite neu)
    const maTok = await tok('malive');
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (lokal)
    const created = await req('POST', '/api/entries', maTok, { date: today, time_from: '08:00', time_to: '12:00', project_text: 'Live-Dashboard-Test', description: 'x' });
    ok('Eintrag angelegt (201)', created.status === 201, 'status=' + created.status);
    const grew = await waitFor(pMa, (b) => document.querySelectorAll('[data-entry-id]').length > b, before);
    ok('Dashboard zeigt neuen Eintrag LIVE ohne Reload', grew, `vorher ${before}`);

    // ── #9: Formular blendet Rechte für Chef/Admin aus ──────────────────────────
    console.log('#9 — Rechte-Block je Rolle:');
    const pAdm = await loginPage(browser, 'admin', apw, '#/users');
    await pAdm.waitForSelector('#add-user-btn'); await pAdm.click('#add-user-btn'); await sleep(500);
    await pAdm.waitForSelector('#um-role');
    ok('MA (Default): Rechte-Block sichtbar', (await visible(pAdm, '#um-rights-group')) === true);
    ok('MA (Default): Hinweis versteckt', (await visible(pAdm, '#um-rights-role-hint')) === false);
    await pAdm.select('#um-role', 'chef'); await sleep(200);
    ok('Chef: Rechte-Block versteckt', (await visible(pAdm, '#um-rights-group')) === false);
    ok('Chef: Hinweis sichtbar', (await visible(pAdm, '#um-rights-role-hint')) === true);
    await pAdm.select('#um-role', 'admin'); await sleep(200);
    ok('Admin: Rechte-Block versteckt', (await visible(pAdm, '#um-rights-group')) === false);
    await pAdm.select('#um-role', 'mitarbeiter'); await sleep(200);
    ok('Zurück zu MA: Rechte-Block wieder sichtbar', (await visible(pAdm, '#um-rights-group')) === true);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLive-Dashboard-&-Rights-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
