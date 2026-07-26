// Prod-Klon-Pruefung fuer B8b (Tastatur/Screenreader).
// NUR LESEND gegen eine KOPIE der Produktivdaten unter /tmp/prodklon.db.
// Fehlt die Kopie, ueberspringt sich der Test.
// Start: node tests/barrierefrei-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3141, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

const imDialog = p => p.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return !!(d && document.activeElement && d.contains(document.activeElement));
});
const namenlose = p => p.evaluate(() => [...document.querySelectorAll('button')].filter(b => {
  if (!b.checkVisibility()) return false;
  const text = (b.textContent || '').replace(/[\s‹›×✕✖✎⋮+🗺🧭]/gu, '').trim();
  const name = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
  return !text && !name;
}).map(b => b.id || b.className || b.outerHTML.slice(0, 70)));

(async () => {
  if (!fs.existsSync(DB)) { console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.'); process.exit(0); }
  const lg = fs.openSync('/tmp/bf-prod-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    console.log(`  echte Daten: ${db.exec('SELECT COUNT(*) FROM entries')[0].values[0][0]} Einträge, angemeldet als ${name}`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    await p.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(2500);
    ok('mit echten Daten angemeldet', await p.evaluate(() => !!document.querySelector('a[href="#/planning"]')));

    // Jede Seite mit echten Daten: kein Symbol-Knopf ohne Namen
    for (const [hash, label] of [['#/', 'Zeitnachweis'], ['#/planning', 'Planung'], ['#/projects', 'Aufträge'],
                                 ['#/tools', 'Werkzeuge'], ['#/orders', 'Bestellungen'], ['#/absences', 'Abwesenheiten'],
                                 ['#/deleted-entries', 'Papierkorb']]) {
      await p.evaluate(h => { location.hash = h; }, hash);
      await sleep(2800);
      const offen = await namenlose(p);
      ok(`${label}: kein Knopf ohne lesbaren Namen`, offen.length === 0, JSON.stringify(offen).slice(0, 200));
    }

    // Fokusfalle an einem ECHTEN Datensatz
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2800);
    const hatLoeschen = await p.evaluate(() => !!document.querySelector('.tool-delete'));
    if (hatLoeschen) {
      await p.evaluate(() => document.querySelector('.tool-delete').focus());
      const vorher = await p.evaluate(() => document.activeElement.className);
      await p.evaluate(() => document.querySelector('.tool-delete').click()); await sleep(700);
      ok('Dialog an echten Daten ist gekennzeichnet', await p.evaluate(() => !!document.querySelector('[role="dialog"][aria-modal="true"]')));
      let raus = null;
      for (let i = 0; i < 12; i++) {
        await p.keyboard.press('Tab');
        if (!(await imDialog(p))) { raus = await p.evaluate(() => document.activeElement.className || document.activeElement.tagName); break; }
      }
      ok('Tab bleibt im Dialog', raus === null, 'gelandet bei: ' + raus);
      await p.keyboard.press('Escape'); await sleep(500);
      ok('Escape schließt, Fokus kehrt zurück',
        (await p.evaluate(() => document.activeElement.className)) === vorher);
      ok('nichts wurde gelöscht (Escape = Abbruch)', await p.evaluate(() => !!document.querySelector('.tool-delete')));
    } else ok('Werkzeug zum Testen vorhanden', false, 'kein .tool-delete');
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBarrierefreiheit am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
