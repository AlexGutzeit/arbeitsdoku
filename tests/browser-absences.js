// Headless-Browser-Test (Puppeteer) für die Abwesenheits-Logik — echte UI-Klicks.
//
// Voraussetzung: Server mit frischer DB, in der 'max' das Passwort 'test' hat und 8h Mo-Fr
// hinterlegt sind (siehe /tmp/abs-repro/setup-browser-abs.js). BASE per ENV setzbar.
// Ausführen (Beispiel):
//   DB_PATH=/tmp/abs-repro/bro.db JWT_SECRET=... PORT=3475 node server.js &
//   BASE=http://localhost:3475 node tests/browser-absences.js
//
// Szenario (vom Nutzer vorgegeben + erweitert):
//   FZA an einem Tag (Soll bleibt 8) -> Urlaub am selben Tag = Fehlermeldung (Doppelbuchung)
//   FZA löschen, Urlaub buchen -> 1 Urlaubstag, Soll 0
//   Krank am selben Tag -> Soll 0, 0 Urlaub (verdrängt); Krank+Krank = Fehler;
//   Berufsschule+Innung am selben Tag = Fehler.
const puppeteer = require('puppeteer');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

const MON = '2026-06-22'; // Montag
const TUE = '2026-06-23';
const WEEK_FROM = '2026-06-22', WEEK_TO = '2026-06-26';

let pass = 0, fail = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiGet(page, p) {
  return page.evaluate(async (pp) => {
    const tok = localStorage.getItem('token');
    const r = await fetch(pp, { headers: { Authorization: 'Bearer ' + tok } });
    return r.json();
  }, p);
}
async function weekSoll(page, uid) {
  const d = await apiGet(page, `/api/statistics?period=week&date=${MON}&user_ids=${uid}`);
  const u = d.users ? d.users[0] : (d.userStats ? d.userStats[0] : d);
  return u ? u.soll : null;
}
async function urlaubJahr(page) {
  const d = await apiGet(page, `/api/absences/summary?from=2026-01-01&to=2026-12-31`);
  return d.urlaubTageJahr || 0;
}
async function weekUrlaub(page) {
  const d = await apiGet(page, `/api/absences/summary?from=${WEEK_FROM}&to=${WEEK_TO}`);
  return (d.summary && d.summary.urlaub) || 0;
}
async function readToast(page) {
  return page.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; });
}
// Login per API (im Browser-Kontext) -> Token (z.B. für Admin-Genehmigung)
async function apiLogin(page, user, pw) {
  return page.evaluate(async (u, p) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }) });
    return (await r.json()).token;
  }, user, pw);
}
async function approveAbsence(page, id, token) {
  return page.evaluate(async (i, t) => {
    const r = await fetch('/api/absences/' + i + '/approve', {
      method: 'POST', headers: { Authorization: 'Bearer ' + t } });
    return r.status;
  }, id, token);
}
// ID der ersten eigenen Abwesenheit eines Typs (optional Status) finden
async function findAbsenceId(page, type, status) {
  const d = await apiGet(page, '/api/absences');
  const a = (d.absences || []).find(x => x.type === type && (!status || x.status === status));
  return a ? a.id : null;
}
// Legt eine Abwesenheit über das Formular an; gibt den Toast-Text zurück.
async function createAbsence(page, type, from, to) {
  await page.evaluate(() => {
    document.querySelectorAll('.dialog-modal').forEach(e => e.remove());
    document.getElementById('absence-form-overlay')?.remove();
    const t = document.querySelector('.toast'); if (t) t.remove();
  });
  await page.click('#absence-new-btn');
  await page.waitForSelector('#abs-type', { timeout: 6000 });
  await page.evaluate((t, f, tt) => {
    const sel = document.getElementById('abs-type');
    sel.value = t; sel.dispatchEvent(new Event('change'));
    document.getElementById('abs-from').value = f;
    document.getElementById('abs-to').value = tt;
  }, type, from, to);
  await page.click('#abs-save');
  // Das Cross-Tier-Modal erscheint erst nach dem Overlap-Netzwerk-Check → bis zu ~3s warten,
  // entweder bis das Modal da ist, das Formular zu ist (Erfolg) oder ein Toast erschien.
  for (let i = 0; i < 20; i++) {
    if (await hasModal(page)) { await page.click('.dialog-modal [data-act="ok"]'); await sleep(600); break; }
    if (!(await page.$('#absence-form-overlay'))) break; // Erfolg ohne Modal → Formular geschlossen
    if (await readToast(page)) break;                    // Toast (z. B. Same-Tier-Block) erschienen
    await sleep(150);
  }
  await sleep(300);
  const msg = await readToast(page);
  if (await page.$('#absence-form-overlay')) {
    await page.evaluate(() => document.getElementById('absence-form-overlay')?.remove());
  }
  await sleep(250);
  return msg;
}
async function deleteAbsenceByLabel(page, label) {
  await page.evaluate((lbl) => {
    const card = [...document.querySelectorAll('.absence-card')].find(c => c.innerText.includes(lbl));
    if (card) card.querySelector('.absence-delete')?.click();
  }, label);
  await modalAccept(page);       // 1) Bestätigung "Abwesenheit löschen?"
  await modalAccept(page, '');   // 2) Begründungs-Modal (eigene Abwesenheit -> leer ok)
  await sleep(900);              // DELETE + rerender
}
async function cardCount(page, label) {
  return page.evaluate((lbl) =>
    [...document.querySelectorAll('.absence-card')].filter(c => c.innerText.includes(lbl)).length, label);
}
// Gestyltes Dialog-Modal bestätigen (statt nativem confirm/prompt). text = Eingabe für promptModal.
async function modalAccept(page, text) {
  await page.waitForSelector('.dialog-modal [data-act="ok"]', { timeout: 4000 });
  if (text !== undefined) {
    await page.evaluate((t) => { const i = document.querySelector('.dialog-modal #pm-input'); if (i) i.value = t; }, text);
  }
  await page.click('.dialog-modal [data-act="ok"]');
  await sleep(350);
}
const hasModal = (page) => page.$('.dialog-modal').then(el => !!el);
async function modalCancel(page) {
  await page.waitForSelector('.dialog-modal [data-act="cancel"]', { timeout: 4000 });
  await page.click('.dialog-modal [data-act="cancel"]');
  await sleep(350);
}
// Löschen-Button einer Karte klicken + Bestätigungs-Modal akzeptieren (Begründungs-Modal bleibt offen)
async function startAbsenceDelete(page, label) {
  await page.evaluate((lbl) => {
    const card = [...document.querySelectorAll('.absence-card')].find(c => c.innerText.includes(lbl));
    if (card) card.querySelector('.absence-delete')?.click();
  }, label);
  await modalAccept(page); // "Abwesenheit wirklich löschen?" → OK
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 950 });
  const promptQueue = [];
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') await d.accept(promptQueue.shift() ?? '');
    else await d.accept(); // confirm "Trotzdem speichern?" -> ja (Backend entscheidet dann hart)
  });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-user', { timeout: 8000 });
  await page.type('#login-user', 'max');
  await page.type('#login-pass', 'test');
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/absences"]', { timeout: 8000 });
  await page.evaluate(() => { window.location.hash = '#/absences'; });
  await page.waitForSelector('#absence-new-btn', { timeout: 8000 });
  const uid = await page.evaluate(() => S.user.id);

  console.log('\n--- Ausgangslage ---');
  check('Soll Woche = 40h (5×8)', (await weekSoll(page, uid)) === 40, 'ist ' + await weekSoll(page, uid));
  check('Urlaubstage/Jahr = 0', (await urlaubJahr(page)) === 0);

  console.log('\n--- FZA am Montag ---');
  let m = await createAbsence(page, 'freizeitausgleich', MON, MON);
  check('FZA eingetragen (Toast)', /eingetragen/i.test(m), m);
  check('Soll Woche bleibt 40h (FZA setzt Soll NICHT auf 0)', (await weekSoll(page, uid)) === 40, 'ist ' + await weekSoll(page, uid));

  console.log('\n--- Urlaub am selben Montag → Doppelbuchung ---');
  m = await createAbsence(page, 'urlaub', MON, MON);
  check('Fehlermeldung „Überschneidung" erscheint', /Überschneidung|nur eine Abwesenheit/i.test(m), m);
  check('kein Urlaub gebucht (Urlaubstage/Jahr = 0)', (await urlaubJahr(page)) === 0);

  console.log('\n--- FZA löschen, dann Urlaub buchen + genehmigen ---');
  await deleteAbsenceByLabel(page, 'Freizeitausgleich');
  check('keine FZA-Karte mehr', (await cardCount(page, 'Freizeitausgleich')) === 0);
  m = await createAbsence(page, 'urlaub', MON, MON);
  check('Urlaub eingetragen (Toast)', /eingetragen/i.test(m), m);
  // Selbst gebuchter Urlaub ist pending -> zählt erst nach Genehmigung
  check('pending-Urlaub zählt noch nicht (Soll 40)', (await weekSoll(page, uid)) === 40, 'ist ' + await weekSoll(page, uid));
  const adminToken = await apiLogin(page, 'admin', 'test');
  const urlaubId = await findAbsenceId(page, 'urlaub', 'pending');
  check('Admin genehmigt Urlaub (HTTP 200)', (await approveAbsence(page, urlaubId, adminToken)) === 200);
  check('1 Urlaubstag/Jahr (nach Genehmigung)', (await urlaubJahr(page)) === 1, 'ist ' + await urlaubJahr(page));
  check('Soll Woche = 32h (Montag durch Urlaub auf 0)', (await weekSoll(page, uid)) === 32, 'ist ' + await weekSoll(page, uid));

  console.log('\n--- Krank am selben Montag (stufenübergreifend erlaubt, verdrängt Urlaub) ---');
  m = await createAbsence(page, 'krank', MON, MON);
  check('Krank eingetragen (Toast)', /eingetragen/i.test(m), m);
  check('Soll Woche bleibt 32h (Montag weiter 0)', (await weekSoll(page, uid)) === 32, 'ist ' + await weekSoll(page, uid));
  check('0 Urlaub in der Woche (Krank verdrängt)', (await weekUrlaub(page)) === 0, 'ist ' + await weekUrlaub(page));
  check('0 Urlaubstage/Jahr (Krank verdrängt)', (await urlaubJahr(page)) === 0, 'ist ' + await urlaubJahr(page));

  console.log('\n--- Krank + Krank am selben Tag → Fehler ---');
  m = await createAbsence(page, 'krank', MON, MON);
  check('Krank gegen Krank blockiert', /Überschneidung|nur eine Abwesenheit/i.test(m), m);

  console.log('\n--- Berufsschule + Innung am selben Tag (Di) → Fehler ---');
  m = await createAbsence(page, 'berufsschule', TUE, TUE);
  check('Berufsschule eingetragen', /eingetragen/i.test(m), m);
  m = await createAbsence(page, 'innung', TUE, TUE);
  check('Innung gegen Berufsschule blockiert', /Überschneidung|nur eine Abwesenheit/i.test(m), m);

  // --- Löschen: Abbrechen im Begründungs-Modal lässt die Abwesenheit stehen, OK löscht ---
  console.log('\n--- Löschen-Flow: Abbrechen lässt stehen, OK löscht (eigene, optionaler Grund) ---');
  m = await createAbsence(page, 'sonderurlaub', '2026-06-26', '2026-06-26'); // freier Tag, eindeutiger Typ
  check('Sonderurlaub für Lösch-Test angelegt', /eingetragen/i.test(m), m);
  check('Sonderurlaub-Karte vorhanden', (await cardCount(page, 'Sonderurlaub')) === 1);
  // 1) Löschen → Bestätigung OK → Begründungs-Modal → ABBRECHEN → bleibt erhalten
  await startAbsenceDelete(page, 'Sonderurlaub');
  await modalCancel(page);
  await sleep(700);
  check('Abbrechen im Grund-Modal → Abwesenheit bleibt', (await cardCount(page, 'Sonderurlaub')) === 1, 'Karten: ' + await cardCount(page, 'Sonderurlaub'));
  // 2) Löschen → Bestätigung OK → Begründungs-Modal → OK mit LEEREM Text → gelöscht (Grund optional)
  await startAbsenceDelete(page, 'Sonderurlaub');
  await modalAccept(page, '');
  await sleep(900);
  check('OK (leerer Grund) → eigene Abwesenheit gelöscht', (await cardCount(page, 'Sonderurlaub')) === 0, 'Karten: ' + await cardCount(page, 'Sonderurlaub'));

  console.log(`\nErgebnis: ${pass} ok, ${fail} fehlgeschlagen`);
  if (fail > 0) console.log('Fehlgeschlagen: ' + fails.join(', '));
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
