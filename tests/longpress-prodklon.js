// Prod-Klon-Pruefung fuer B7 (langer Druck zeigt Details).
// NUR LESEND gegen eine KOPIE der Produktivdaten unter /tmp/prodklon.db.
// Fehlt die Kopie, ueberspringt sich der Test.
// Start: node tests/longpress-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3135, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

const mitte = (p, sel) => p.evaluate(s => {
  const el = document.querySelector(s); if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}, sel);
const blase = p => p.evaluate(() => { const t = document.querySelector('.entry-tooltip'); return (t && t.style.display !== 'none') ? t.textContent : ''; });

(async () => {
  if (!fs.existsSync(DB)) {
    console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.');
    console.log('  Holen mit: scp <server>:/pfad/arbeitsdoku/data/arbeitsdoku.db ' + DB);
    process.exit(0);
  }
  const lg = fs.openSync('/tmp/lp-prod-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    const TAG = db.exec("SELECT date FROM entries WHERE deleted_at IS NULL AND client IS NOT NULL AND client<>'' ORDER BY date DESC LIMIT 1")[0].values[0][0];
    const KUNDE = db.exec("SELECT client FROM entries WHERE deleted_at IS NULL AND date=? AND client IS NOT NULL AND client<>'' LIMIT 1", [TAG])[0].values[0][0];
    console.log(`  echte Daten: ${db.exec('SELECT COUNT(*) FROM entries')[0].values[0][0]} Eintraege — pruefe ${TAG}, Kunde „${KUNDE}"`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    await p.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(2500);
    ok('mit echten Daten angemeldet', await p.evaluate(() => !!document.querySelector('a[href="#/planning"]')));

    await p.evaluate(d => { S.currentDate = new Date(d + 'T12:00:00'); renderDashboardContent(); }, TAG);
    await sleep(3000);
    await p.evaluate(() => hideTooltip());
    const pt = await mitte(p, '.tl-entry[data-entry-id]');
    ok('echter Eintrag in der Zeitleiste', !!pt, JSON.stringify(pt));
    await sleep(300); await p.evaluate(() => hideTooltip());

    await p.touchscreen.touchStart(pt.x, pt.y); await sleep(800); await p.touchscreen.touchEnd(); await sleep(500);
    const txt = await blase(p);
    ok('langer Druck zeigt Details echter Eintraege', txt.length > 20 && /Zeit:/.test(txt), JSON.stringify(txt.slice(0, 100)));
    ok('… ohne das Bearbeiten-Formular zu oeffnen', !/#\/entry\//.test(await p.evaluate(() => location.hash)), await p.evaluate(() => location.hash));

    await p.evaluate(() => hideTooltip()); await sleep(1200);
    const pt2 = await mitte(p, '.tl-entry[data-entry-id]'); await sleep(300);
    await p.touchscreen.touchStart(pt2.x, pt2.y); await sleep(80); await p.touchscreen.touchEnd(); await sleep(1000);
    ok('kurzer Tipp oeffnet weiterhin das Bearbeiten', /#\/entry\//.test(await p.evaluate(() => location.hash)), await p.evaluate(() => location.hash));
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLanger Druck am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
