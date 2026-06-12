// Headless-Browser-Smoke-Test (Puppeteer) — klickt echte UI-Abläufe durch, rollenbasiert.
//
// Voraussetzung: lokaler Server auf :3000 mit anonymisiertem Prod-Clone (alle Passwörter 'test').
// Chromium: chrome-headless-shell, gefunden via CHROME_BIN oder Standard-Cache-Pfad.
// Ausfuehren: node tests/browser-smoke.js
//
// Deckt ab:
//  ADMIN — Speicherlimit in den Einstellungen per Klick (Dropdown MB/GB, Komma), Dokumente:
//          Ordner/Unterordner anlegen, Upload, Datei verschieben, Ordner verschieben, umbenennen, löschen.
//  CHEF  — darf Dokumente verwalten, aber die Speicher-Einstellung ist NICHT sichtbar.
//  MA    — sieht nur Ordner/Dateien + Herunterladen; keine Verwalten-Buttons; kein Settings-Zugriff.
// Reines Dev-Werkzeug (devDependency).
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

function attachDialogs(page) {
  const promptQueue = [];
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept(promptQueue.shift() ?? '');
    else await d.accept();
  });
  return promptQueue;
}
async function mainText(page) {
  return page.evaluate(() => document.querySelector('.main') ? document.querySelector('.main').innerText : '');
}
async function waitForText(page, text, timeout = 8000) {
  try {
    await page.waitForFunction(
      (t) => document.querySelector('.main') && document.querySelector('.main').innerText.includes(t),
      { timeout }, text);
    return true;
  } catch { return false; }
}
async function waitForGone(page, text, timeout = 8000) {
  try {
    await page.waitForFunction(
      (t) => document.querySelector('.main') && !document.querySelector('.main').innerText.includes(t),
      { timeout }, text);
    return true;
  } catch { return false; }
}
// Ordner per sichtbarem Namen öffnen (Klick auf den Ordner-Link)
async function openFolder(page, name) {
  await page.evaluate((n) => {
    const a = [...document.querySelectorAll('a.doc-link')].find(x => x.textContent.includes(n));
    if (a) a.click();
  }, name);
  await sleep(700);
}
// Im Verschieben-Dialog ein Ziel per Namen wählen ('' = Wurzel)
async function pickInModal(page, name) {
  await page.waitForSelector('.modal .doc-picker-item', { timeout: 5000 });
  await page.evaluate((n) => {
    const items = [...document.querySelectorAll('.modal .doc-picker-item')];
    const it = n ? items.find(x => x.textContent.includes(n)) : items.find(x => x.textContent.includes('Wurzel'));
    if (it) it.click();
  }, name);
  await sleep(900);
}
async function newContextPage(browser, user, pass_) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const promptQueue = attachDialogs(page);
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-user', { timeout: 8000 });
  await page.type('#login-user', user);
  await page.type('#login-pass', pass_);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/documents"]', { timeout: 8000 });
  return { ctx, page, promptQueue };
}
async function gotoHash(page, hash) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await sleep(700);
}
async function page_storageText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.doc-storage-text');
    return el ? el.textContent : '(keine .doc-storage-text)';
  });
}
// Limit setzen: Feldwert deterministisch ersetzen (vermeidet Tipp-Akkumulation), Einheit waehlen, speichern
async function setLimit(page, value, unit) {
  await page.waitForSelector('#doc-limit-value', { timeout: 8000 });
  await page.evaluate((v) => { const el = document.querySelector('#doc-limit-value'); el.value = v; }, value);
  await page.select('#doc-limit-unit', unit);
  await page.click('#doc-limit-save');
  await sleep(1200);
}
// Button (Verschieben/Löschen) der Ordnerzeile mit passendem Namen klicken
async function clickFolderBtn(page, name, btnClass) {
  await page.evaluate((n, cls) => {
    const row = [...document.querySelectorAll('.doc-row')].find(r => r.textContent.includes(n) && r.querySelector('.' + cls));
    if (row) row.querySelector('.' + cls).click();
  }, name, btnClass);
  await sleep(400);
}

(async () => {
  const pdfPath = path.join(os.tmpdir(), 'smoke.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4 Browser-Smoke-Test Inhalt');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // ===================== ADMIN =====================
    console.log('\n--- ADMIN: Speicherlimit (Einstellungen, echte Klicks) ---');
    const a = await newContextPage(browser, 'admin', 'test');
    const ap = a.page;

    await gotoHash(ap, '#/settings');
    await ap.waitForSelector('#doc-limit-value', { timeout: 8000 });
    check('Admin sieht "Dokumenten-Speicher"-Einstellung', !!(await ap.$('#doc-limit-value')));

    // Limit auf 2 GB (Dropdown) setzen
    await setLimit(ap, '2', 'GB');
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('.doc-storage', { timeout: 8000 });
    const bar2gb = await page_storageText(ap);
    check('Limit-Änderung auf 2 GB wirkt (Anzeige 2048 MB)', bar2gb.includes('2048'));
    if (!bar2gb.includes('2048')) console.log('     [debug] Anzeige war: "' + bar2gb + '"');

    // Komma-Eingabe: 300,5 MB
    await gotoHash(ap, '#/settings');
    await setLimit(ap, '300,5', 'MB');
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('.doc-storage', { timeout: 8000 });
    check('Komma-Eingabe "300,5" MB wirkt (Anzeige 300.5 MB)', (await mainText(ap)).includes('300.5'));

    // Zurück auf 500 MB
    await gotoHash(ap, '#/settings');
    await setLimit(ap, '500', 'MB');

    console.log('--- ADMIN: Dokumente (anlegen/upload/verschieben/umbenennen/löschen) ---');
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('#doc-new-folder', { timeout: 8000 });

    // Geteilten Ordner für Chef/MA anlegen + Datei darin
    a.promptQueue.push('BT-Shared');
    await ap.click('#doc-new-folder');
    check('Ordner "BT-Shared" angelegt', await waitForText(ap, 'BT-Shared'));
    await openFolder(ap, 'BT-Shared');
    await (await ap.$('#doc-file-input')).uploadFile(pdfPath);
    check('Upload in Unterordner sichtbar', await waitForText(ap, 'smoke.pdf'));

    // Zurück zur Wurzel, zwei Ordner für Verschieben-Tests
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('#doc-new-folder', { timeout: 8000 });
    a.promptQueue.push('MoveZiel');
    await ap.click('#doc-new-folder');
    await waitForText(ap, 'MoveZiel');
    a.promptQueue.push('MoveQuelle');
    await ap.click('#doc-new-folder');
    check('Ordner "MoveZiel" + "MoveQuelle" angelegt', await waitForText(ap, 'MoveQuelle'));

    // Datei in Wurzel hochladen und nach MoveZiel verschieben
    await (await ap.$('#doc-file-input')).uploadFile(pdfPath);
    await waitForText(ap, 'smoke.pdf');
    await ap.click('.doc-move');               // Verschieben-Dialog der Datei
    await pickInModal(ap, 'MoveZiel');
    check('Datei aus Wurzel verschwunden (verschoben)', await waitForGone(ap, 'smoke.pdf'));
    await openFolder(ap, 'MoveZiel');
    check('Datei liegt jetzt in MoveZiel', await waitForText(ap, 'smoke.pdf'));

    // Datei umbenennen
    a.promptQueue.push('Handbuch');
    await ap.click('.doc-rename');
    check('Datei umbenannt zu "Handbuch.pdf"', await waitForText(ap, 'Handbuch.pdf'));

    // Ordner verschieben: MoveQuelle -> in MoveZiel
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('#doc-new-folder', { timeout: 8000 });
    await clickFolderBtn(ap, 'MoveQuelle', 'doc-folder-move');
    await pickInModal(ap, 'MoveZiel');
    check('Ordner "MoveQuelle" aus Wurzel verschoben', await waitForGone(ap, 'MoveQuelle'));
    await openFolder(ap, 'MoveZiel');
    check('"MoveQuelle" liegt jetzt in MoveZiel', await waitForText(ap, 'MoveQuelle'));

    // Aufräumen: MoveZiel rekursiv löschen (enthält Datei + MoveQuelle)
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('#doc-new-folder', { timeout: 8000 });
    await clickFolderBtn(ap, 'MoveZiel', 'doc-folder-delete');
    await sleep(1200);
    check('MoveZiel rekursiv gelöscht', await waitForGone(ap, 'MoveZiel'));

    // ===================== CHEF =====================
    console.log('\n--- CHEF: darf verwalten, aber KEINE Speicher-Einstellung ---');
    const c = await newContextPage(browser, 'Daniel', 'test');
    const cp = c.page;
    await gotoHash(cp, '#/settings');
    await sleep(800);
    check('Chef sieht KEINE Speicher-Einstellung', !(await cp.$('#doc-limit-value')));
    await gotoHash(cp, '#/documents');
    await sleep(800);
    check('Chef hat Verwalten-Buttons (Neuer Ordner)', !!(await cp.$('#doc-new-folder')));
    check('Chef sieht den geteilten Ordner "BT-Shared"', (await mainText(cp)).includes('BT-Shared'));
    await c.ctx.close();

    // ===================== MITARBEITER =====================
    console.log('\n--- MITARBEITER: nur lesen/laden, keine Verwaltung ---');
    const m = await newContextPage(browser, 'alex', 'test');
    const mp = m.page;
    await gotoHash(mp, '#/documents');
    await sleep(800);
    check('MA hat KEINE Verwalten-Toolbar (kein Upload/Neuer Ordner)', !(await mp.$('#doc-new-folder')));
    check('MA sieht den Ordner "BT-Shared"', (await mainText(mp)).includes('BT-Shared'));
    await openFolder(mp, 'BT-Shared');
    await waitForText(mp, 'smoke.pdf');
    check('MA hat "Herunterladen"-Button', !!(await mp.$('.doc-download')));
    check('MA hat KEINEN Löschen-Button', !(await mp.$('.doc-delete')));
    check('MA hat KEINEN Umbenennen-Button', !(await mp.$('.doc-rename')));
    check('MA hat KEINEN Verschieben-Button', !(await mp.$('.doc-move')));
    // MA hat keinen Settings-Zugriff
    await gotoHash(mp, '#/settings');
    await sleep(800);
    check('MA kann Einstellungen nicht öffnen (kein settings-form)', !(await mp.$('#settings-form')));
    await m.ctx.close();

    // ===================== CLEANUP (Admin) =====================
    await gotoHash(ap, '#/documents');
    await ap.waitForSelector('#doc-new-folder', { timeout: 8000 });
    await clickFolderBtn(ap, 'BT-Shared', 'doc-folder-delete');
    await sleep(1200);
    check('Aufräumen: BT-Shared gelöscht', await waitForGone(ap, 'BT-Shared'));
    await a.ctx.close();

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
