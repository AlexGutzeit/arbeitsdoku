// Prod-Klon-Pruefung fuer B4 (Entwurfs-Sicherung).
// NUR LESEND gegen eine KOPIE der Produktivdaten unter /tmp/prodklon.db — es wird NICHTS gespeichert,
// nur ein Formular ausgefuellt, in den Hintergrund geschickt und nach einem Neustart wiederhergestellt.
// Fehlt die Kopie, ueberspringt sich der Test.
// Start: node tests/entwurf-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3137, DB = '/tmp/prodklon.db', BASE = 'http://localhost:' + PORT;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const req = (m, p) => new Promise((res, rej) => { const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode })); }); r.on('error', rej); r.end(); });

(async () => {
  if (!fs.existsSync(DB)) {
    console.log('Prod-Klon ' + DB + ' fehlt — Test uebersprungen.');
    process.exit(0);
  }
  // Die App sichert die Datenbank alle 5 s komplett auf Platte — die Datei aendert sich also auch
  // ohne Zutun. Aussagekraeftig ist deshalb nicht der Zeitstempel, sondern der Datenbestand.
  const initSql0 = await initSqlJs();
  const zaehlen = () => {
    const d = new initSql0.Database(fs.readFileSync(DB));
    const z = t => { try { return d.exec('SELECT COUNT(*) FROM ' + t)[0].values[0][0]; } catch (_) { return -1; } };
    const r = ['entries', 'planning_entries', 'projects', 'absences', 'notes', 'orders', 'bulletin', 'audit_logs'].map(t => t + '=' + z(t)).join(' ');
    d.close(); return r;
  };
  const vorher = zaehlen();
  const lg = fs.openSync('/tmp/entwurf-prod-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    console.log(`  echte Daten: ${db.exec('SELECT COUNT(*) FROM entries')[0].values[0][0]} Eintraege, ${db.exec('SELECT COUNT(*) FROM projects')[0].values[0][0]} Auftraege`);
    db.close();
    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let p = await browser.newPage();
    const neu = async (hash) => {
      if (p) await p.close();
      p = await browser.newPage();
      await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
      await p.goto(BASE + '/' + (hash || ''), { waitUntil: 'networkidle2' });
      await sleep(2500);
    };
    await p.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    await neu('#/entry/new');
    ok('mit echten Daten angemeldet', await p.evaluate(() => !!document.querySelector('a[href="#/planning"]')));
    ok('Zeiteintrag-Formular offen', await p.evaluate(() => !!document.getElementById('entry-form')));

    // Ein echtes Projekt aus den Produktivdaten waehlen — dessen Automatik traegt Adresse/Kunde ein
    const projId = await p.evaluate(() => {
      const s = document.getElementById('ef-project');
      const o = [...s.options].find(x => x.value);
      return o ? o.value : null;
    });
    if (projId) {
      await p.evaluate(v => { const s = document.getElementById('ef-project'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, projId);
      await sleep(500);
    }
    await p.evaluate(() => {
      const set = (i, v) => { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('ef-address', 'Pruefadresse — nur Entwurf');
      set('ef-desc', 'Testeingabe der Entwurfspruefung, wird nicht gespeichert');
    });
    await sleep(900);
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(500);
    ok('Entwurf im Speicher abgelegt', (await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('entwurf:')).length)) === 1);

    await neu('#/entry/new');
    ok('nach dem Neustart wird der Entwurf angeboten', await p.evaluate(() => !!document.querySelector('.draft-bar')));
    await p.click('#entwurf-uebernehmen'); await sleep(700);
    ok('Adresse zurueck', (await p.evaluate(() => document.getElementById('ef-address').value)) === 'Pruefadresse — nur Entwurf');
    ok('Beschreibung zurueck', /Entwurfspruefung/.test(await p.evaluate(() => document.getElementById('ef-desc').value)));
    if (projId) ok('echtes Projekt wieder ausgewaehlt', (await p.evaluate(() => document.getElementById('ef-project').value)) === projId);

    // Aufraeumen wie ein Nutzer, der abbricht
    await p.evaluate(() => { Object.keys(localStorage).filter(k => k.startsWith('entwurf:')).forEach(k => localStorage.removeItem(k)); });
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); await sleep(1200); }
  const nachher = zaehlen();
  ok('kein einziger Datensatz dazugekommen', vorher === nachher, `${vorher}  ->  ${nachher}`);
  console.log(`\nEntwurfs-Sicherung am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
