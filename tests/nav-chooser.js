// Navigations-Auswahl-Test (Puppeteer, headless). Prüft Plattform-Optionen, URL-Builder, Auswahl-Dialog,
// „merken" (direkt öffnen) und „ändern" (Dialog erzwingen). Start: node tests/nav-chooser.js
// Voraussetzung: läuft gegen einen frisch gestarteten Server (wird hier als Kind-Prozess gestartet).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3093;
const DB = '/tmp/nav-chooser-test.db';
const BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: p }, res => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>resolve({status:res.statusCode,body:s})); }).on('error', reject);
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/nav-chooser-srv.log', 'w');
  const srv = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', log, log],
  });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await httpGet('/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/nav-chooser-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 8000 });
    await page.type('#login-user', 'admin');
    await page.type('#login-pass', pw);
    await page.click('#login-form button[type="submit"]');
    // Wartet nur darauf, dass die Anmeldung durch ist. Frueher stand hier der Menuepunkt
    // „Benachrichtigungen" — den gibt es seit dem 22.08.2026 nicht mehr, die Karte sitzt auf
    // „Mein Konto". Jetzt wird auf einen Menuepunkt gewartet, den es sicher gibt.
    await page.waitForSelector('a[href="#/statistics"]', { timeout: 8000 });

    // window.open stubben + localStorage leeren
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; localStorage.removeItem('navApp'); });

    // A) Reine Logik
    const logic = await page.evaluate(() => ({
      android: navOptionsFor('android'), ios: navOptionsFor('ios'), desktop: navOptionsFor('desktop'),
      google: NAV_SERVICES.google.url('A%20B'), device: NAV_SERVICES.device.url('X'), deviceScheme: !!NAV_SERVICES.device.scheme,
      waze: NAV_SERVICES.waze.url('X'),
    }));
    ok('Optionen Android', JSON.stringify(logic.android) === JSON.stringify(['device','google','waze']), JSON.stringify(logic.android));
    ok('Optionen iOS', JSON.stringify(logic.ios) === JSON.stringify(['apple','google','waze']), JSON.stringify(logic.ios));
    ok('Optionen Desktop', JSON.stringify(logic.desktop) === JSON.stringify(['google','osm','apple','bing']), JSON.stringify(logic.desktop));
    ok('Google-URL', logic.google === 'https://www.google.com/maps/dir/?api=1&destination=A%20B', logic.google);
    ok('Geräte-Auswahl = geo:-Scheme', logic.device === 'geo:0,0?q=X' && logic.deviceScheme, logic.device);
    ok('Waze-URL', logic.waze === 'https://waze.com/ul?q=X&navigate=yes', logic.waze);

    // B) Dialog-Flow im Eintragsformular (Desktop)
    await page.evaluate(() => { location.hash = '#/entry/new'; });
    await page.waitForSelector('#ef-nav', { timeout: 8000 });
    await page.type('#ef-address', 'Musterstraße 1, 12345 Berlin');
    await page.click('#ef-nav');
    await page.waitForSelector('.dialog-modal .nav-choose-btn', { timeout: 4000 });
    const labels = await page.$$eval('.dialog-modal .nav-choose-btn', els => els.map(e => e.dataset.nav));
    ok('Dialog zeigt Desktop-Optionen', JSON.stringify(labels) === JSON.stringify(['google','osm','apple','bing']), JSON.stringify(labels));
    ok('Erst-Aufruf ohne gemerkte Wahl zeigt Dialog (kein direktes Öffnen)', (await page.evaluate(() => window.__opened.length)) === 0);

    // „merken" anhaken + Google wählen
    await page.click('#nav-remember');
    await page.click('.dialog-modal .nav-choose-btn[data-nav="google"]');
    await sleep(150);
    const afterPick = await page.evaluate(() => ({ opened: window.__opened.slice(), pref: localStorage.getItem('navApp'), modal: !!document.querySelector('.dialog-modal') }));
    ok('Wahl öffnet Google-URL', afterPick.opened.length === 1 && afterPick.opened[0].includes('google.com/maps') && afterPick.opened[0].includes(encodeURIComponent('Musterstraße 1, 12345 Berlin')), JSON.stringify(afterPick.opened));
    ok('„merken" speichert Pref', afterPick.pref === 'google', String(afterPick.pref));
    ok('Dialog nach Wahl geschlossen', afterPick.modal === false);

    // Erneuter Klick → direkt öffnen, KEIN Dialog
    await page.click('#ef-nav');
    await sleep(150);
    const direct = await page.evaluate(() => ({ opened: window.__opened.length, modal: !!document.querySelector('.dialog-modal') }));
    ok('Gemerkte Wahl öffnet direkt (kein Dialog)', direct.opened === 2 && direct.modal === false, JSON.stringify(direct));

    // C) „Ändern" erzwingt Dialog trotz gemerkter Wahl (Formular neu rendern, damit Link erscheint)
    await page.evaluate(() => { location.hash = '#/'; });
    await sleep(200);
    await page.evaluate(() => { location.hash = '#/entry/new'; });
    await page.waitForSelector('#ef-nav-change', { timeout: 8000 });
    await page.type('#ef-address', 'Teststraße 5');
    await page.click('#ef-nav-change');
    await page.waitForSelector('.dialog-modal .nav-choose-btn', { timeout: 4000 });
    ok('„Navigations-App ändern" erzwingt Dialog', true);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM');
  }
  console.log(`\nNav-Chooser: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
