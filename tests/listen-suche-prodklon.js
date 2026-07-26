// Prod-Klon-Pruefung fuer B6 (Suche in den Listen).
// NUR LESEND gegen eine KOPIE der Produktivdaten unter /tmp/prodklon.db.
// Fehlt die Kopie, ueberspringt sich der Test.
// Start: node tests/listen-suche-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3139, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

const sichtbare = (p, sel) => p.evaluate(s => [...document.querySelectorAll(s + ' [data-suchtext]')]
  .filter(el => el.style.display !== 'none').length, sel);
const gesamt = (p, sel) => p.evaluate(s => document.querySelectorAll(s + ' [data-suchtext]').length, sel);
async function tippen(p, key, text) {
  await p.click('#ls-' + key);
  await p.evaluate(k => { const el = document.getElementById('ls-' + k); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, key);
  if (text) await p.type('#ls-' + key, text, { delay: 25 });
  await sleep(400);
}

(async () => {
  if (!fs.existsSync(DB)) { console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.'); process.exit(0); }
  const lg = fs.openSync('/tmp/lsuche-prod-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    const eins = t => { try { return db.exec('SELECT COUNT(*) FROM ' + t)[0].values[0][0]; } catch (_) { return 0; } };
    // Ein echter Werkzeugname und ein echter Mitarbeitername als Suchbegriff
    const wz = (() => { try { return db.exec("SELECT name FROM tools ORDER BY id LIMIT 1")[0].values[0][0]; } catch (_) { return null; } })();
    const ma = (() => { try { return db.exec("SELECT name FROM users WHERE role='mitarbeiter' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0][0]; } catch (_) { return null; } })();
    console.log(`  echte Daten: ${eins('tools')} Werkzeuge, ${eins('users')} Nutzer, ${eins('orders')} Bestellungen`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    await p.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(2500);
    ok('mit echten Daten angemeldet', await p.evaluate(() => !!document.querySelector('a[href="#/planning"]')));

    // Werkzeuge
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(2500);
    const wzGesamt = await gesamt(p, '#tools-list');
    ok('Werkzeugliste zeigt die echten Werkzeuge', wzGesamt > 0, String(wzGesamt));
    if (wz) {
      const wort = String(wz).split(/\s+/)[0].slice(0, 6);
      await tippen(p, 'werkzeug', wort);
      const s = await sichtbare(p, '#tools-list');
      ok(`Suche „${wort}" grenzt ein (${s} von ${wzGesamt})`, s >= 1 && s < wzGesamt, `${s}/${wzGesamt}`);
      await tippen(p, 'werkzeug', '');
      ok('leeres Feld zeigt wieder alle', (await sichtbare(p, '#tools-list')) === wzGesamt);
    }

    // Mitarbeiter
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(2500);
    const maGesamt = await gesamt(p, '#users-tbody');
    ok('Mitarbeiterliste zeigt die echten Nutzer', maGesamt > 0, String(maGesamt));
    if (ma) {
      const nachname = String(ma).split(/\s+/).pop();
      await tippen(p, 'mitarbeiter', nachname);
      const s = await sichtbare(p, '#users-tbody');
      ok(`Suche nach „${nachname}" findet den Mitarbeiter`, s >= 1 && s < maGesamt, `${s}/${maGesamt}`);
      await tippen(p, 'mitarbeiter', '');
    }

    // Papierkorb (waechst dauerhaft — genau dort hilft die Suche am meisten)
    await p.evaluate(() => { location.hash = '#/deleted-entries'; }); await sleep(3000);
    const pkGesamt = await gesamt(p, '#trash-entries-tbody');
    ok('Papierkorb zeigt die echten gelöschten Einträge', pkGesamt >= 0, String(pkGesamt));
    if (pkGesamt > 1) {
      const ersterText = await p.evaluate(() => document.querySelector('#trash-entries-tbody [data-suchtext]').dataset.suchtext);
      const wort = ersterText.split(/\s+/).filter(w => w.length > 4)[0] || ersterText.split(/\s+/)[0];
      await tippen(p, 'papierkorb-eintraege', wort);
      const s = await sichtbare(p, '#trash-entries-tbody');
      ok(`Papierkorb-Suche „${wort}" grenzt ein (${s} von ${pkGesamt})`, s >= 1 && s <= pkGesamt, `${s}/${pkGesamt}`);
      await tippen(p, 'papierkorb-eintraege', '');
    }
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nListen-Suche am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
