// Marken „neu" und „bearbeitet" in der Notizen-Übersicht (Alex, 02.10.2026: „wie bei den Meldungen").
//
// Geprüft in der echten App:
//   A  Seit Lenas letztem Besuch: eine Notiz NEU freigegeben → „neu"; eine bestehende von Olga geändert →
//      „bearbeitet"; eine neu freigegebene UND danach geänderte bleibt „neu"; unveränderte ohne Marke.
//   B  Die Liste frischt sich still auf (jemand ändert noch eine): Hervorhebung und Marken BLEIBEN stehen, die eben
//      geänderte kommt als „bearbeitet" dazu. Früher verschwand alles nach Sekunden.
//   C  Nächster Besuch: alles gesehen, keine Marke mehr.
//   D  Eigene Änderungen markieren nichts (Olga sieht an ihren Notizen keine Marke).
//
//   node tests/notizen-marken-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3367, DB = '/tmp/notizen-marken-ui.db', LOG = '/tmp/notizen-marken-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const t = {}, ids = {};
    for (const [u, n] of [['olga', 'Olga Owner'], ['lena', 'Lena Leserin']]) {
      ids[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter' })).body.user.id;
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const notiz = async (titel) => (await req('POST', '/api/notes', t.olga, { title: titel, body: 'Inhalt' })).body.note.id;
    const teilen = (id) => req('PUT', `/api/notes/${id}/shares`, t.olga, { shares: [{ user_id: ids.lena, permission: 'read' }] });
    const umbenennen = (id, titel) => req('PUT', `/api/notes/${id}`, t.olga, { title: titel });
    const alt = await notiz('Altbekannt'), geaendert = await notiz('Material'), still = await notiz('Telefonliste');
    for (const id of [alt, geaendert, still]) await teilen(id);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async () => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport({ width: 1280, height: 900 });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p, u) => {
      await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(700);
    };
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(800); };
    const marken = (p) => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.note-card')].map(k => [
      k.querySelector('.note-title').childNodes[0].textContent.trim(),
      { marke: (k.querySelector('.note-marke') || {}).textContent || null, hell: k.classList.contains('note-card--unread') }])));

    // Lena schaut einmal in die Notizen und geht wieder
    const L = await neueSeite();
    await anmelden(L, 'lena');
    await zu(L, '/notes'); await zu(L, '/welcome');
    await sleep(300);

    // Seitdem: eine neu freigegeben, eine geändert, eine neu freigegeben UND geändert
    const neu = await notiz('Urlaubsplan'); await teilen(neu);
    const neuUndGeaendert = await notiz('Bestellung'); await teilen(neuUndGeaendert); await umbenennen(neuUndGeaendert, 'Bestellung Holz');
    await umbenennen(geaendert, 'Material Halle 2');

    console.log('A · Marken seit dem letzten Besuch');
    await zu(L, '/notes'); await L.waitForSelector('.note-card');
    let m = await marken(L);
    ok('neu freigegeben → „neu", hervorgehoben', m['Urlaubsplan'] && m['Urlaubsplan'].marke === 'neu' && m['Urlaubsplan'].hell, JSON.stringify(m['Urlaubsplan']));
    ok('von Olga geändert → „bearbeitet", hervorgehoben', m['Material Halle 2'] && m['Material Halle 2'].marke === 'bearbeitet' && m['Material Halle 2'].hell, JSON.stringify(m['Material Halle 2']));
    ok('neu freigegeben UND geändert → „neu" (neu geht vor)', m['Bestellung Holz'] && m['Bestellung Holz'].marke === 'neu', JSON.stringify(m['Bestellung Holz']));
    ok('unverändert → keine Marke, nicht hervorgehoben', m['Altbekannt'] && !m['Altbekannt'].marke && !m['Altbekannt'].hell
      && m['Telefonliste'] && !m['Telefonliste'].marke, JSON.stringify([m['Altbekannt'], m['Telefonliste']]));

    console.log('B · Stilles Auffrischen');
    await umbenennen(still, 'Telefonliste neu');
    await L.waitForFunction(() => [...document.querySelectorAll('.note-card .note-title')].some(x => /Telefonliste neu/.test(x.textContent)), { timeout: 8000 }).catch(() => {});
    m = await marken(L);
    ok('die Liste hat sich still aufgefrischt (neuer Titel da)', !!m['Telefonliste neu'], Object.keys(m).join(', '));
    ok('… „neu" und „bearbeitet" BLEIBEN stehen', m['Urlaubsplan'] && m['Urlaubsplan'].marke === 'neu' && m['Material Halle 2'] && m['Material Halle 2'].marke === 'bearbeitet'
      && m['Bestellung Holz'] && m['Bestellung Holz'].marke === 'neu', JSON.stringify(m));
    ok('… und die eben geänderte kommt als „bearbeitet" dazu', m['Telefonliste neu'] && m['Telefonliste neu'].marke === 'bearbeitet', JSON.stringify(m['Telefonliste neu']));
    // Karte aufklappen zeichnet die Liste neu — auch dabei bleibt alles
    await L.evaluate(() => [...document.querySelectorAll('.note-card')].find(k => /Altbekannt/.test(k.textContent)).click()); await sleep(400);
    m = await marken(L);
    ok('… auch nach dem Aufklappen einer Karte', m['Urlaubsplan'] && m['Urlaubsplan'].marke === 'neu' && m['Material Halle 2'].marke === 'bearbeitet');

    console.log('C · Nächster Besuch');
    await zu(L, '/welcome'); await zu(L, '/notes'); await L.waitForSelector('.note-card');
    m = await marken(L);
    ok('alles gesehen: keine Marke, nichts hervorgehoben', Object.values(m).every(x => !x.marke && !x.hell), JSON.stringify(m));

    console.log('D · Eigene Änderungen');
    const O = await neueSeite();
    await anmelden(O, 'olga');
    await zu(O, '/notes'); await O.waitForSelector('.note-card');
    m = await marken(O);
    ok('Olga sieht an ihren eigenen (selbst geänderten) Notizen keine Marke', Object.values(m).every(x => !x.marke), JSON.stringify(m));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nMarken „neu" und „bearbeitet" in den Notizen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
