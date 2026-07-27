// Abrechnungs-Abschluss in der Oberfläche.
//
// Geprüft wird, was der Nutzer wirklich sieht und anfassen kann: die Karte auf der Export-Seite,
// der Sammel-Abschluss, der Sperr-Hinweis im Zeitnachweis, der Begründungs-Dialog des Admins,
// die Abweichungs-Anzeige und die Mitarbeiter-Sicht.
//
// Die Sperre selbst wird serverseitig geprüft (tests/abschluss.js) — hier geht es darum, dass die
// Oberfläche sie verständlich macht und niemanden ins Leere laufen lässt.
//   node tests/abschluss-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

// Chromium wird bewusst NICHT per npm install geholt (.puppeteerrc.cjs skipDownload) — sonst
// laege ein Browser auch auf dem Produktivserver. Pfad wie in den uebrigen Browser-Tests.
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

const PORT = 3160, DB = '/tmp/abschluss-ui.db';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JAHR = new Date().getFullYear() - 1;
const IM_JANUAR = `${JAHR}-01-15`;

// Ueber das echte Login-Formular anmelden — wie die uebrigen Browser-Tests. Ein direkt in den
// Speicher geschriebenes Token trifft die internen Schluessel nicht zuverlaessig.
async function anmelden(page, name, passwort) {
  await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-user', { timeout: 15000 });
  await page.type('#login-user', name);
  await page.type('#login-pass', passwort);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 });
  await sleep(500);
}
const sichtbar = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!(el && el.checkVisibility && el.checkVisibility());
}, sel);
const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.innerText : '';
}, sel);

// Ein Wechsel, der nur den Hash aendert, laedt die Seite NICHT neu — das Formular des vorigen
// Eintrags steht dann noch da. Deshalb wird auf das erwartete Datum gewartet, nicht nur auf
// das Formular.
async function oeffneEintrag(page, id, datum) {
  // Erst weg vom Eintrag: Steht dieselbe Adresse schon in der Zeile, aendert sich der Hash nicht
  // und goto laedt NICHT neu — das alte Formular bliebe samt gesperrtem Absenden-Knopf stehen.
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' });
  await page.goto(BASIS + `/#/entry/${id}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    (d) => document.getElementById('ef-date')?.value === d, { timeout: 15000 }, datum);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/abschluss-ui-srv.log', 'utf8');
    const pw = (n) => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmeldung = async (n) => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await anmeldung('admin'), chefA = await anmeldung('chef'), maxA = await anmeldung('max');
    const maxId = maxA.user.id;

    await req('POST', `/api/statistics/targets/${maxId}`, chefA.token,
      { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });
    const e1 = (await req('POST', '/api/entries', maxA.token,
      { date: IM_JANUAR, time_from: '07:00', time_to: '15:30', break_minutes: 30 })).body.entry;
    ok('Vorbereitung steht', !!e1);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // ── Export-Seite als Chef: Karte da, offener Monat gemeldet ───────────────────────────
    await anmelden(page, 'chef', pw('chef'));
    await page.goto(BASIS + '/#/pdf', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#abschluss-karte', { timeout: 10000 });
    ok('Karte „Abrechnungs-Abschluss" ist da', await sichtbar(page, '#abschluss-karte'));
    ok('Hinweis auf offene Monate erscheint', await sichtbar(page, '#abschluss-offen'),
      await text(page, '#abschluss-karte'));
    ok('noch nichts abgeschlossen wird deutlich gesagt',
      /kein Monat abgeschlossen/i.test(await text(page, '#abschluss-karte')));

    // ── Sammel-Abschluss ───────────────────────────────────────────────────────────────────
    const bisMonat = `${JAHR}-03`;
    await page.evaluate((m) => { document.getElementById('abschluss-monat').value = m; }, bisMonat);
    // Bestätigungsdialog automatisch annehmen
    await page.evaluate(() => { window.confirmModal = async () => true; });
    await page.click('#abschluss-btn');
    await page.waitForFunction(
      () => /Abgerechnet bis/.test(document.getElementById('abschluss-karte')?.innerText || ''),
      { timeout: 20000 });
    const karte = await text(page, '#abschluss-karte');
    ok('nach dem Sammel-Abschluss steht der Stichtag da', /Abgerechnet bis 31\.03\./.test(karte), karte.slice(0, 200));
    ok('die abgeschlossenen Zeiträume werden gelistet', /Abgeschlossene Zeiträume/.test(karte));
    const anzahl = (await req('GET', '/api/closure', chefA.token)).body.perioden.length;
    ok('drei Monate wurden abgeschlossen (Januar–März)', anzahl === 3, String(anzahl));

    // ── Zeitnachweis als Mitarbeiter: Hinweis statt stiller Ablehnung ─────────────────────
    await anmelden(page, 'max', pw('max'));
    await oeffneEintrag(page, e1.id, IM_JANUAR);
    ok('Mitarbeiter sieht den Sperr-Hinweis', await sichtbar(page, '#abgerechnet-hinweis'));
    const hinweis = await text(page, '#abgerechnet-hinweis');
    ok('der Hinweis nennt den Stichtag', /31\.03\./.test(hinweis), hinweis);
    ok('der Hinweis verweist an den Administrator', /Administrator/.test(hinweis), hinweis);

    // Gegenprobe: ein Eintrag NACH dem Stichtag zeigt keinen Hinweis
    const e2 = (await req('POST', '/api/entries', maxA.token,
      { date: `${JAHR}-06-15`, time_from: '07:00', time_to: '15:30', break_minutes: 30 })).body.entry;
    await oeffneEintrag(page, e2.id, `${JAHR}-06-15`);
    ok('Gegenprobe: offener Zeitraum zeigt KEINEN Hinweis', !(await sichtbar(page, '#abgerechnet-hinweis')));

    // ── Statistik-Seite: Mitarbeiter sieht seine abgerechneten Zahlen ─────────────────────
    await page.goto(BASIS + '/#/statistics', { waitUntil: 'networkidle0' });
    try {
      await page.waitForFunction(() => /Abgerechnet bis/.test(document.querySelector('.main')?.innerText || ''), { timeout: 15000 });
    } catch (_) { /* Aussage macht die Pruefung unten — mit dem echten Text als Beleg */ }
    const stat = await text(page, '.main');
    ok('Mitarbeiter sieht den Stichtag in der Statistik', /Abgerechnet bis 31\.03\./.test(stat));
    ok('Mitarbeiter sieht seine eigenen abgerechneten Zahlen',
      /Für Sie abgerechnet/.test(stat) && /Überstunden gesamt/.test(stat), stat.slice(0, 300));

    // ── Admin: Begründung ist Pflicht, dann geht es durch ─────────────────────────────────
    await anmelden(page, 'admin', pw('admin'));
    await oeffneEintrag(page, e1.id, IM_JANUAR);
    const adminHinweis = await text(page, '#abgerechnet-hinweis');
    ok('Admin wird auf die Begründungspflicht hingewiesen', /Begründung/.test(adminHinweis), adminHinweis);

    // Abbruch im Begründungsdialog darf NICHT speichern.
    await page.evaluate(() => { window.promptModal = async () => null; });
    await page.evaluate(() => { document.getElementById('ef-to').value = '17:45'; });
    await page.click('#entry-form button[type="submit"]');
    await sleep(1200);
    const unveraendert = (await req('GET', '/api/entries/' + e1.id, adminA.token)).body.entry;
    ok('Abbruch im Begründungsdialog speichert nicht', unveraendert.time_to === '15:30', unveraendert.time_to);

    // Mit Begründung geht es durch. FRISCH laden: der Doppel-Submit-Schutz haelt den Knopf nach
    // dem abgebrochenen Versuch gesperrt — ohne Neuladen liefe der zweite Klick ins Leere und der
    // Test wuerde einen Fehler melden, den es gar nicht gibt.
    await oeffneEintrag(page, e1.id, IM_JANUAR);
    await page.evaluate(() => { window.promptModal = async () => 'Nachgereichte Krankmeldung'; });
    await page.evaluate(() => { document.getElementById('ef-to').value = '16:00'; });
    await page.click('#entry-form button[type="submit"]');
    let geaendert = null;
    for (let i = 0; i < 25; i++) {
      geaendert = (await req('GET', '/api/entries/' + e1.id, adminA.token)).body.entry;
      if (geaendert.time_to === '16:00') break;
      await sleep(400);
    }
    ok('Admin ändert mit Begründung erfolgreich', geaendert.time_to === '16:00',
      `${geaendert.time_to} — Meldung: ${(await text(page, '.toast')) || '(keine)'}`);

    // ── Abweichung wird ausgewiesen ───────────────────────────────────────────────────────
    await anmelden(page, 'chef', pw('chef'));
    await page.goto(BASIS + '/#/pdf', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.abschluss-abweichung', { timeout: 10000 });
    // ALLE Zeiträume prüfen: geändert wurde im Januar, gelistet ist der neueste (März) zuerst —
    // ein Klick auf nur den obersten würde „keine Abweichung" melden und nichts beweisen.
    const knoepfe = await page.$$('.abschluss-abweichung');
    ok('es gibt für jeden Zeitraum eine Prüfung', knoepfe.length === 3, String(knoepfe.length));
    for (const k of knoepfe) await k.click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('.abschluss-abw-box')]
        .filter(e => /bezahlt|Keine Abweichung/.test(e.innerText)).length >= 3,
      { timeout: 20000 });
    const abwText = await page.evaluate(() =>
      [...document.querySelectorAll('.abschluss-abw-box')].map(e => e.innerText).join(' '));
    ok('die Abweichung wird angezeigt', /bezahlt/.test(abwText), abwText.slice(0, 200));
    ok('die Anzeige erklärt, warum der Gesamtstand stehen bleibt',
      /bezahlten Wert/.test(abwText), abwText.slice(0, 300));

    // ── Wieder öffnen nur für den Admin ───────────────────────────────────────────────────
    ok('Chef sieht keinen „Wieder öffnen"-Knopf', !(await sichtbar(page, '#abschluss-oeffnen')));
    await anmelden(page, 'admin', pw('admin'));
    await page.goto(BASIS + '/#/pdf', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#abschluss-karte', { timeout: 10000 });
    ok('Admin sieht den „Wieder öffnen"-Knopf', await sichtbar(page, '#abschluss-oeffnen'));

    await page.evaluate(() => {
      window.confirmModal = async () => true;
      window.promptModal = async () => 'Korrektur der März-Abrechnung';
    });
    await page.click('#abschluss-oeffnen');
    await page.waitForFunction(
      () => /Abgerechnet bis 28\.02\.|Abgerechnet bis 29\.02\./.test(document.getElementById('abschluss-karte')?.innerText || ''),
      { timeout: 15000 });
    ok('nach dem Wiederöffnen steht der Stichtag einen Monat früher', true);
    const rest = (await req('GET', '/api/closure', adminA.token)).body.perioden.length;
    ok('nur der letzte Zeitraum wurde geöffnet', rest === 2, String(rest));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAbschluss-Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
