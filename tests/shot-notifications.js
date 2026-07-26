// Einmal-Screenshot der Benachrichtigungen-Seite — ein Werkzeug, kein Test.
// Voraussetzung: laufender Server auf BASE (Default :3096) und SHOT_PASS gesetzt, z. B.
//   BASE=http://localhost:3000 SHOT_PASS=test node tests/shot-notifications.js
// Fehlt beides, ueberspringt sich das Skript — sonst faerbt es jeden Suite-Durchlauf rot.
const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');

const BASE = process.env.BASE || 'http://localhost:3096';
const USER = process.env.SHOT_USER || 'admin';
const PASS = process.env.SHOT_PASS;
const OUT = process.env.OUT || '/tmp/notifications.png';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const erreichbar = await new Promise(res => {
    const r = require('http').get(BASE + '/health', x => { x.resume(); res(x.statusCode === 200); });
    r.on('error', () => res(false));
    r.setTimeout(2000, () => { r.destroy(); res(false); });
  });
  if (!erreichbar || !PASS) {
    console.log('Uebersprungen: ' + (!erreichbar ? 'kein Server auf ' + BASE : 'SHOT_PASS nicht gesetzt') + '.');
    console.log('  Beispiel: BASE=http://localhost:3000 SHOT_PASS=test node tests/shot-notifications.js');
    process.exit(0);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  // Benachrichtigungs-Erlaubnis erteilen, damit nicht „blockiert" angezeigt wird.
  await browser.defaultBrowserContext().overridePermissions(BASE, ['notifications']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-user', { timeout: 8000 });
  await page.type('#login-user', USER);
  await page.type('#login-pass', PASS);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/notifications"]', { timeout: 8000 });

  async function shotCard(out) {
    await page.waitForFunction(() => {
      const c = document.getElementById('push-card');
      return c && !c.querySelector('.spinner');
    }, { timeout: 8000 });
    await sleep(400);
    await page.screenshot({ path: out });
    console.log('Screenshot:', out);
  }

  await page.evaluate(() => { window.location.hash = '#/notifications'; });
  await page.waitForFunction(() => !!document.getElementById('push-card'), { timeout: 8000 });

  // headless-shell meldet Notification.permission='denied' — für die Aufnahme auf 'granted' setzen,
  // damit der echte UI-Zustand sichtbar wird (in echten Browsern ist das die normale Erlaubnis).
  // 1. Erst-Zustand: „Aus" mit Aktivieren-Button
  await page.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
    initPushCard();
  });
  await shotCard(OUT.replace('.png', '-aus.png'));

  // 2. Aktiver Zustand mit den 4 Kategorie-Schaltern (echtes Abonnieren braucht einen echten
  //    Push-Dienst; hier wird der Aktiv-Zweig nur fürs Bild erzwungen).
  await page.evaluate(() => {
    window.getPushSubscription = async () => ({ endpoint: 'demo' });
    initPushCard();
  });
  await shotCard(OUT.replace('.png', '-aktiv.png'));

  // 3. Seitenleiste offen — zeigt den neuen Menüpunkt „Benachrichtigungen"
  await page.evaluate(() => {
    document.getElementById('sidebar').classList.add('open');
    const ov = document.getElementById('sidebar-overlay'); if (ov) ov.classList.add('open');
  });
  await sleep(400);
  await page.screenshot({ path: OUT.replace('.png', '-sidebar.png') });
  console.log('Screenshot:', OUT.replace('.png', '-sidebar.png'));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
