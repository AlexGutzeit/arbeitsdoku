// Headless-Browser-Smoke-Test (Puppeteer) — klickt echte UI-Abläufe durch.
//
// Voraussetzung: lokaler Server auf :3000 mit anonymisiertem Prod-Clone (Login admin/test).
// Chromium: chrome-headless-shell wird per CHROME_BIN bzw. Standardpfad gefunden.
// Ausfuehren: node tests/browser-smoke.js
//
// Deckt ab: Login → Dokumente öffnen → Ordner anlegen → Datei hochladen → umbenennen →
// löschen → Ordner löschen, jeweils mit DOM-Pruefung. Reines Dev-Werkzeug (devDependency).
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://localhost:3000';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wartet bis .main den Text enthaelt (oder Timeout)
async function waitForText(page, text, timeout = 8000) {
  try {
    await page.waitForFunction(
      (t) => document.querySelector('.main') && document.querySelector('.main').innerText.includes(t),
      { timeout }, text);
    return true;
  } catch { return false; }
}
async function mainText(page) {
  return page.evaluate(() => document.querySelector('.main') ? document.querySelector('.main').innerText : '');
}

(async () => {
  // Test-PDF erzeugen
  const pdfPath = path.join(os.tmpdir(), 'smoke.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4 Browser-Smoke-Test Inhalt');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 }); // Desktop → Sidebar sichtbar

  // Dialog-Handling: prompt nimmt naechsten Wert aus der Queue, confirm/alert wird akzeptiert
  const promptQueue = [];
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept(promptQueue.shift() ?? '');
    else await d.accept();
  });

  try {
    // 1. Login
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#login-user', { timeout: 8000 });
    await page.type('#login-user', 'admin');
    await page.type('#login-pass', 'test');
    await page.click('#login-form button[type="submit"]');
    const loggedIn = await page.waitForSelector('a[href="#/documents"]', { timeout: 8000 }).then(() => true).catch(() => false);
    check('Login erfolgreich (Sidebar sichtbar)', loggedIn);

    // 2. Dokumente öffnen (per Hash navigieren — robuster als Sidebar-Klick)
    await page.evaluate(() => { window.location.hash = '#/documents'; });
    const docsLoaded = await page.waitForSelector('#doc-new-folder', { timeout: 8000 }).then(() => true).catch(() => false);
    check('Dokumente-Seite geladen (Admin-Toolbar)', docsLoaded);
    check('Belegungsanzeige sichtbar', (await mainText(page)).includes('belegt'));

    // 3. Ordner anlegen
    promptQueue.push('Browser-Test-Ordner');
    await page.click('#doc-new-folder');
    check('Ordner "Browser-Test-Ordner" erscheint', await waitForText(page, 'Browser-Test-Ordner'));

    // 4. Datei hochladen (in die Wurzel)
    const input = await page.$('#doc-file-input');
    await input.uploadFile(pdfPath);
    check('Datei "smoke.pdf" erscheint nach Upload', await waitForText(page, 'smoke.pdf'));

    // 5. Datei umbenennen
    promptQueue.push('Umbenannte-Datei');
    await page.click('.doc-rename');
    check('Datei heißt jetzt "Umbenannte-Datei.pdf"', await waitForText(page, 'Umbenannte-Datei.pdf'));

    // 6. Datei löschen (confirm wird akzeptiert)
    await page.click('.doc-delete');
    await sleep(1200);
    check('Datei nach Löschen verschwunden', !(await mainText(page)).includes('Umbenannte-Datei.pdf'));

    // 7. Ordner löschen
    await page.click('.doc-folder-delete');
    await sleep(1200);
    check('Ordner nach Löschen verschwunden', !(await mainText(page)).includes('Browser-Test-Ordner'));

  } catch (e) {
    fail++; fails.push('EXCEPTION: ' + e.message);
    console.log('  ❌ Ausnahme: ' + e.message);
  } finally {
    await browser.close();
  }

  console.log('\n========================================');
  console.log(`BROWSER-SMOKE: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) console.log('Fehlgeschlagen: ' + fails.join(' | '));
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
