// Puppeteer-UI-Test: Impressum/Datenschutz — Admin füllt in Einstellungen, Links auf Login-Seite (pre-login)
// + im Menü, Rechtstext wird sicher (escaped) gerendert, Leer-Zustand blendet Links aus.
// Start: node tests/legal-pages-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3122, DB = '/tmp/legal-pages-ui.db', BASE = 'http://localhost:' + PORT;
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
const setVal = (page, sel, val) => page.evaluate((s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, val);
async function freshCtx(browser) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage(); await p.setViewport({ width: 1200, height: 900 });
  return p;
}
const IMP = 'Musterfirma GmbH\nMusterstr. 1, 10115 Berlin\n<img src=x onerror="window.__xss=true">';
const DAT = 'Verantwortliche Stelle: Musterfirma GmbH. Zwecke: Arbeitszeiterfassung.';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/legal-pages-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/legal-pages-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // ── Leer-Zustand: Login-Seite zeigt KEINE Rechtslinks ──
    console.log('Leer-Zustand:');
    let pe = await freshCtx(browser);
    await pe.goto(BASE, { waitUntil: 'networkidle2' }); await sleep(800);
    ok('frisch: keine Login-Rechtslinks', (await pe.$('.login-legal a')) === null);

    // ── Admin füllt Impressum + Datenschutz in Einstellungen ──
    console.log('Admin füllt Einstellungen:');
    const pa = await freshCtx(browser);
    await pa.goto(BASE, { waitUntil: 'networkidle2' });
    await pa.waitForSelector('#login-user'); await pa.type('#login-user', 'admin'); await pa.type('#login-pass', apw);
    await pa.click('#login-form button[type="submit"]'); await pa.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await pa.evaluate(() => { location.hash = '#/settings'; }); await sleep(1000);
    await pa.waitForSelector('#s-legal-impressum');
    await setVal(pa, '#s-legal-impressum', IMP);
    await setVal(pa, '#s-legal-datenschutz', DAT);
    await pa.click('#legal-form button[type="submit"]'); await sleep(800);
    ok('gespeichert (API bestätigt)', (await req('GET', '/api/legal', null)).body.impressum === IMP);

    // Nav zeigt jetzt die Einträge (nach Navigation → render)
    await pa.evaluate(() => { location.hash = '#/'; }); await sleep(800);
    ok('Menü zeigt Impressum-Eintrag', (await pa.$('.sidebar nav a[href="#/impressum"]')) !== null);
    ok('Menü zeigt Datenschutz-Eintrag', (await pa.$('.sidebar nav a[href="#/datenschutz"]')) !== null);

    // "Zurück" kehrt zur VORHERIGEN Seite zurück (nicht fix zum Zeitnachweis)
    await pa.evaluate(() => { location.hash = '#/statistics'; }); await sleep(700);
    await pa.evaluate(() => { location.hash = '#/impressum'; }); await sleep(700);
    await pa.waitForSelector('.legal-back a');
    await pa.click('.legal-back a'); await sleep(700);
    ok('Zurück kehrt zur vorherigen Seite (statistics)', (await pa.evaluate(() => location.hash)) === '#/statistics');

    // ── Ausgeloggt: Login-Seite zeigt Links, Rechtsseite pre-login, XSS-sicher ──
    console.log('Pre-Login + XSS-Sicherheit:');
    const pp = await freshCtx(browser);
    await pp.goto(BASE, { waitUntil: 'networkidle2' });
    await pp.waitForSelector('.login-legal a', { timeout: 6000 });
    ok('Login-Seite zeigt Rechtslinks', (await pp.$('.login-legal a[href="#/impressum"]')) !== null);
    // Impressum pre-login öffnen
    await pp.evaluate(() => { window.__xss = false; location.hash = '#/impressum'; }); await sleep(900);
    await pp.waitForSelector('.legal-body');
    const r = await pp.evaluate(() => {
      const b = document.querySelector('.legal-body');
      return { text: b ? b.textContent : '', img: b ? !!b.querySelector('img') : false, xss: window.__xss === true, loggedOut: !!document.querySelector('.legal-standalone') };
    });
    ok('Rechtsseite ohne Login erreichbar (standalone)', r.loggedOut);
    ok('Text sichtbar (Musterfirma)', /Musterfirma GmbH/.test(r.text));
    ok('KEIN <img> im Text (escaped)', r.img === false);
    ok('KEIN onerror-Script ausgeführt', r.xss === false);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLegal-Pages-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
