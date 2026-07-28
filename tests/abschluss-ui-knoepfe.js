// Jeder Knopf und jeder Dialog des Abrechnungs-Abschlusses — im echten Browser bedient.
//
// Der vorhandene Oberflächen-Test prüft die Erfolgspfade und ERSETZT dabei die Dialoge
// (window.confirmModal = () => true). Hier werden sie stattdessen BEDIENT: geklickt, getippt,
// abgebrochen, leer gelassen. Denn die Abbruch- und Fehlerpfade sind die gefährlicheren — ein
// „Abbrechen", das trotzdem bucht, fällt niemandem auf, bis das Geld falsch ist.
//   node tests/abschluss-ui-knoepfe.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3170, DB = '/tmp/abschluss-knoepfe.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('    ✓ ' + n)) : (fail++, fails.push(n), console.log('    ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const JAHR = new Date().getFullYear() - 1;
const d2 = n => String(n).padStart(2, '0');

const da = (page, sel) => page.evaluate(s => !!document.querySelector(s), sel);
const sichtbar = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s); return !!(el && el.checkVisibility && el.checkVisibility());
}, sel);
const text = (page, sel) => page.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);
const dialogOffen = (page) => page.evaluate(() => !!document.querySelector('.modal-overlay'));
const dialogText = (page) => page.evaluate(() => (document.querySelector('.modal-overlay') || {}).innerText || '');
// Auf den Dialog WARTEN statt blind zu schlafen: Unter Last oeffnet er sich mal in 200 ms, mal in
// 1500 — eine feste Wartezeit macht den Test zum Gluecksspiel.
async function warteDialog(page, zeit = 15000) {
  await page.waitForSelector('.modal-overlay [data-act="ok"]', { timeout: zeit });
  await sleep(250);
}
async function klickDialog(page, act) {
  await page.waitForSelector(`.modal-overlay [data-act="${act}"]`, { timeout: 15000 });
  await page.click(`.modal-overlay [data-act="${act}"]`);
  await sleep(400);
}
const dialogZu = (page) => page.waitForFunction(() => !document.querySelector('.modal-overlay'), { timeout: 20000 });
const letzterToast = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.toast, [class*="toast"]')].map(e => e.innerText).join(' | '));

async function anmelden(page, name, passwort) {
  await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-user', { timeout: 15000 });
  await page.type('#login-user', name);
  await page.type('#login-pass', passwort);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 });
  await sleep(500);
}
// Hash-Wechsel ohne Änderung lädt NICHT neu — deshalb immer erst weg vom Ziel.
async function gehe(page, hash) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' });
  await sleep(900);
  await page.goto(BASIS + '/#' + hash, { waitUntil: 'networkidle0' });
  await sleep(1400);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-knoepfe-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/abschluss-knoepfe-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /buchhalter\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await an('admin'), chefA = await an('chef'), maxA = await an('max');
    const uid = maxA.user.id;

    await req('POST', `/api/statistics/targets/${uid}`, chefA.token, {
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });
    let ersterEintrag = null;
    for (const m of ['01', '02']) {
      for (let t = 1; t <= 28; t++) {
        const datum = `${JAHR}-${m}-${d2(t)}`;
        const wt = new Date(datum + 'T12:00:00Z').getUTCDay();
        if (wt === 0 || wt === 6) continue;
        const r = await req('POST', '/api/entries', adminA.token, { date: datum, time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: uid });
        if (!ersterEintrag) ersterEintrag = r.body.entry;
      }
    }
    ok('Vorbereitung steht', !!ersterEintrag);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 950 });

    // ══ Wer sieht die Karte überhaupt? ══════════════════════════════════════════════════
    console.log('\nSichtbarkeit der Karte:');
    await anmelden(page, 'max', pw('max'));
    await gehe(page, '/pdf');
    ok('Mitarbeiter sieht die Abschluss-Karte NICHT', !(await da(page, '#abschluss-karte')));
    ok('und auch den Lohn-Export nicht', !(await da(page, '#lohn-form')));

    await anmelden(page, 'buchhalter', pw('buchhalter'));
    await gehe(page, '/pdf');
    await page.waitForSelector('#abschluss-karte', { timeout: 15000 });
    ok('Buchhalter sieht die Karte', await sichtbar(page, '#abschluss-karte'));
    ok('und hat einen Abschließen-Knopf', await da(page, '#abschluss-btn'));
    ok('aber KEINEN „Wieder öffnen"-Knopf', !(await da(page, '#abschluss-oeffnen')));

    // ══ Monatsfeld: Grenzen gesetzt ═════════════════════════════════════════════════════
    console.log('\nMonatsfeld:');
    const grenzen = await page.evaluate(() => {
      const el = document.getElementById('abschluss-monat');
      return el ? { wert: el.value, min: el.min, max: el.max, pflicht: el.required } : null;
    });
    ok('Zielmonat ist vorbelegt', !!(grenzen && grenzen.wert), JSON.stringify(grenzen));
    ok('mit Unter- und Obergrenze', !!(grenzen && grenzen.min && grenzen.max), JSON.stringify(grenzen));
    ok('und ist Pflichtfeld', !!(grenzen && grenzen.pflicht));

    // ══ Abschließen: ABBRECHEN darf nichts tun ══════════════════════════════════════════
    console.log('\nAbschließen — Abbrechen:');
    await anmelden(page, 'chef', pw('chef'));
    await gehe(page, '/pdf');
    await page.waitForSelector('#abschluss-btn', { timeout: 15000 });
    await page.evaluate(m => { document.getElementById('abschluss-monat').value = m; }, `${JAHR}-02`);
    await page.click('#abschluss-btn');
    await warteDialog(page);
    ok('der Bestätigungsdialog geht auf', await dialogOffen(page));
    ok('er nennt den gewählten Monat', /Februar/.test(await dialogText(page)), await dialogText(page));
    ok('und sagt, was danach gilt', /schreibgeschützt|Administrator/.test(await dialogText(page)));
    await klickDialog(page, 'cancel');
    await sleep(900);
    ok('nach Abbrechen ist der Dialog zu', !(await dialogOffen(page)));
    ok('und NICHTS wurde abgeschlossen',
      ((await req('GET', '/api/closure', chefA.token)).body.bis) === null,
      String((await req('GET', '/api/closure', chefA.token)).body.bis));

    // ══ Abschließen: bestätigen ═════════════════════════════════════════════════════════
    console.log('\nAbschließen — bestätigen:');
    await page.evaluate(m => { document.getElementById('abschluss-monat').value = m; }, `${JAHR}-02`);
    await page.click('#abschluss-btn');
    await warteDialog(page);
    await klickDialog(page, 'ok');
    await page.waitForFunction(() => /Abgerechnet bis/.test(document.getElementById('abschluss-karte')?.innerText || ''), { timeout: 25000 });
    ok('zwei Monate sind abgeschlossen', ((await req('GET', '/api/closure', chefA.token)).body.perioden.length) === 2);
    ok('der Stichtag steht jetzt auf dem 28./29. Februar',
      /Abgerechnet bis 2[89]\.02\./.test(await text(page, '#abschluss-karte')), await text(page, '#abschluss-karte'));
    // Die Testdaten liegen im VORjahr — danach sind naturgemaess noch Monate offen. Der Hinweis
    // muss das sagen und beim naechsten offenen Monat weiterzaehlen.
    ok('der Hinweis nennt jetzt den März als nächsten offenen Monat',
      /Noch offen ab März/.test(await text(page, '#abschluss-offen')), await text(page, '#abschluss-offen'));
    ok('die beiden abgeschlossenen Zeiträume sind gelistet',
      (await page.$$('.abschluss-abweichung')).length === 2,
      String((await page.$$('.abschluss-abweichung')).length));

    // ══ Gesperrter Eintrag: Mitarbeiter ═════════════════════════════════════════════════
    console.log('\nGesperrter Eintrag — Mitarbeiter:');
    await anmelden(page, 'max', pw('max'));
    await gehe(page, `/entry/${ersterEintrag.id}`);
    await page.waitForSelector('#entry-form', { timeout: 15000 });
    ok('der Sperr-Hinweis steht da', await sichtbar(page, '#abgerechnet-hinweis'));
    ok('Speichern-Knopf ist trotzdem da (gesperrt wird serverseitig)', await da(page, '#entry-form button[type="submit"]'));

    await page.evaluate(() => { document.getElementById('ef-to').value = '19:00'; });
    await page.click('#entry-form button[type="submit"]');
    await sleep(900);
    // Begruendungsdialog des Mitarbeiters (optional) -> bestaetigen, damit die Anfrage rausgeht
    if (await dialogOffen(page)) { await klickDialog(page, 'ok'); await sleep(1500); }
    const unveraendert = (await req('GET', '/api/entries/' + ersterEintrag.id, adminA.token)).body.entry;
    ok('Speichern wird abgelehnt — der Eintrag bleibt unverändert', unveraendert.time_to === '15:30', unveraendert.time_to);
    ok('und der Nutzer bekommt eine Meldung, die den Grund nennt',
      /abgerechnet/i.test(await letzterToast(page)), await letzterToast(page));

    await gehe(page, `/entry/${ersterEintrag.id}`);
    await page.waitForSelector('#delete-entry', { timeout: 15000 });
    await page.click('#delete-entry');
    await warteDialog(page);
    ok('Löschen fragt zuerst nach', await dialogOffen(page));
    await klickDialog(page, 'ok');   // „Wirklich löschen?"
    await sleep(700);
    if (await dialogOffen(page)) { await klickDialog(page, 'ok'); await sleep(1500); }   // Begruendung
    const nochDa = (await req('GET', '/api/entries/' + ersterEintrag.id, adminA.token)).body.entry;
    ok('Löschen wird abgelehnt — der Eintrag ist noch da', !!nochDa && !nochDa.deleted_at, JSON.stringify(!!nochDa));

    // ══ Gesperrter Eintrag: Admin, Kommentar leer lassen ════════════════════════════════
    console.log('\nGesperrter Eintrag — Admin, Pflichtfeld leer:');
    await anmelden(page, 'admin', pw('admin'));
    await gehe(page, `/entry/${ersterEintrag.id}`);
    await page.waitForSelector('#entry-form', { timeout: 15000 });
    await page.evaluate(() => { document.getElementById('ef-to').value = '18:30'; });
    await page.click('#entry-form button[type="submit"]');
    await warteDialog(page);
    ok('der Begründungsdialog geht auf', await dialogOffen(page));
    ok('er ist als Pflicht gekennzeichnet', /Pflicht/.test(await dialogText(page)), await dialogText(page));
    await klickDialog(page, 'ok');           // leer bestaetigen
    await sleep(700);
    ok('bei leerem Feld bleibt der Dialog offen', await dialogOffen(page));
    ok('und zeigt einen Hinweis', await sichtbar(page, '#pm-error'), await text(page, '#pm-error'));
    ok('gespeichert wurde nichts',
      ((await req('GET', '/api/entries/' + ersterEintrag.id, adminA.token)).body.entry.time_to) === '15:30');

    await page.type('#pm-input', 'Stundenzettel nachgereicht');
    await klickDialog(page, 'ok');
    await sleep(2000);
    ok('mit Begründung wird gespeichert',
      ((await req('GET', '/api/entries/' + ersterEintrag.id, adminA.token)).body.entry.time_to) === '18:30');

    // ══ Übernehmen: Abbrechen, dann leerer Kommentar, dann echt ═════════════════════════
    console.log('\nDifferenz übernehmen — Abbrechen und Pflichtfeld:');
    await anmelden(page, 'chef', pw('chef'));
    await gehe(page, '/pdf');
    await page.waitForSelector('.abschluss-abweichung', { timeout: 15000 });
    for (const k of await page.$$('.abschluss-abweichung')) { await k.click(); await sleep(500); }
    await page.waitForFunction(() => !!document.querySelector('.abschluss-uebernehmen'), { timeout: 15000 });
    ok('der Übernehmen-Knopf erscheint bei offener Differenz', await sichtbar(page, '.abschluss-uebernehmen'));
    ok('er nennt den Betrag', /\d/.test(await text(page, '.abschluss-uebernehmen')), await text(page, '.abschluss-uebernehmen'));

    await page.click('.abschluss-uebernehmen');
    await warteDialog(page);
    ok('erst kommt eine Rückfrage', await dialogOffen(page));
    await klickDialog(page, 'cancel');
    await sleep(800);
    const nochOffen = (await req('GET', '/api/closure', chefA.token)).body.perioden.some(p => p.offenGesamt !== 0);
    ok('nach Abbrechen ist die Differenz noch offen', nochOffen);

    await gehe(page, '/pdf');
    await page.waitForSelector('.abschluss-abweichung', { timeout: 15000 });
    for (const k of await page.$$('.abschluss-abweichung')) { await k.click(); await sleep(500); }
    await page.waitForFunction(() => !!document.querySelector('.abschluss-uebernehmen'), { timeout: 15000 });
    await page.click('.abschluss-uebernehmen');
    await warteDialog(page);
    await klickDialog(page, 'ok');           // Rueckfrage bestaetigen
    await warteDialog(page);
    ok('dann wird der Kommentar verlangt', await dialogOffen(page) && /Kommentar|Wofür/.test(await dialogText(page)), await dialogText(page));
    await klickDialog(page, 'ok');           // leer
    await sleep(700);
    ok('leer geht nicht — der Dialog bleibt offen', await dialogOffen(page));
    ok('mit Hinweis, warum', await sichtbar(page, '#pm-error'), await text(page, '#pm-error'));
    ok('und gebucht wurde nichts',
      (await req('GET', '/api/closure', chefA.token)).body.perioden.some(p => p.offenGesamt !== 0));

    await page.type('#pm-input', 'Noteinsatz, Stundenzettel nachgereicht');
    await klickDialog(page, 'ok');
    await dialogZu(page);
    await sleep(2000);
    ok('mit Kommentar wird übernommen',
      !(await req('GET', '/api/closure', chefA.token)).body.perioden.some(p => p.offenGesamt !== 0),
      JSON.stringify((await req('GET', '/api/closure', chefA.token)).body.perioden.map(p => p.offenGesamt)));

    // ══ Wieder öffnen: Abbrechen, leere Begründung, dann echt ═══════════════════════════
    console.log('\nWieder öffnen — Abbrechen und Pflichtfeld:');
    await anmelden(page, 'admin', pw('admin'));
    await gehe(page, '/pdf');
    await page.waitForSelector('#abschluss-oeffnen', { timeout: 15000 });
    await page.click('#abschluss-oeffnen');
    await warteDialog(page);
    ok('die Rückfrage warnt vor der Rücknahme der Nachträge',
      /Nachträge|zurückgenommen/.test(await dialogText(page)), await dialogText(page));
    await klickDialog(page, 'cancel');
    await sleep(800);
    ok('nach Abbrechen sind beide Zeiträume noch da',
      ((await req('GET', '/api/closure', adminA.token)).body.perioden.length) === 2);

    await page.click('#abschluss-oeffnen');
    await warteDialog(page);
    await klickDialog(page, 'ok');
    await warteDialog(page);
    ok('dann wird die Begründung verlangt', await dialogOffen(page));
    await klickDialog(page, 'ok');           // leer
    await sleep(700);
    ok('leer geht nicht', await dialogOffen(page) && (await sichtbar(page, '#pm-error')));
    ok('und geöffnet wurde nichts',
      ((await req('GET', '/api/closure', adminA.token)).body.perioden.length) === 2);

    await page.type('#pm-input', 'Korrektur der Februar-Abrechnung');
    await klickDialog(page, 'ok');
    await dialogZu(page);
    await sleep(2000);
    ok('mit Begründung wird geöffnet',
      ((await req('GET', '/api/closure', adminA.token)).body.perioden.length) === 1,
      String((await req('GET', '/api/closure', adminA.token)).body.perioden.length));
    ok('ohne betroffene Nachträge bleibt die Meldung schlicht',
      /aufgehoben/.test(await letzterToast(page)) && !/zurückgenommen/.test(await letzterToast(page)),
      await letzterToast(page));

    // Jetzt den JANUAR öffnen — dort hängt der übernommene Nachtrag. Er muss zurückgenommen
    // werden, sonst zählte dieselbe Zeit doppelt (siehe tests/abschluss-haerte.js).
    const standVor = Number((await req('GET', `/api/statistics/overtime?user_id=${uid}`, adminA.token)).body.overtime || 0);
    await anmelden(page, 'admin', pw('admin'));   // frische Sitzung, damit nichts nachwirkt
    await gehe(page, '/pdf');
    await page.waitForSelector('#abschluss-oeffnen', { timeout: 15000 });
    await page.click('#abschluss-oeffnen');
    try {
      await warteDialog(page);
    } catch (_) {
      const zustand = await page.evaluate(() => ({
        knopf: !!document.getElementById('abschluss-oeffnen'),
        sichtbar: document.getElementById('abschluss-oeffnen')?.checkVisibility?.(),
        id: document.getElementById('abschluss-oeffnen')?.dataset?.id,
        perioden: document.querySelectorAll('.abschluss-abweichung').length,
        karte: (document.getElementById('abschluss-karte') || {}).innerText?.slice(0, 200),
      }));
      ok('der „Wieder öffnen"-Knopf reagiert', false, JSON.stringify(zustand));
      throw new Error('Dialog blieb aus — Zustand oben');
    }
    await klickDialog(page, 'ok');
    await warteDialog(page);
    await page.waitForSelector('#pm-input', { timeout: 15000 });
    await page.type('#pm-input', 'Auch den Januar korrigieren');
    await klickDialog(page, 'ok');
    await dialogZu(page);
    await sleep(2000);
    ok('beim Januar nennt die Meldung die zurückgenommenen Nachträge',
      /zurückgenommen/.test(await letzterToast(page)), await letzterToast(page));
    ok('kein Zeitraum ist mehr abgeschlossen',
      ((await req('GET', '/api/closure', adminA.token)).body.bis) === null);
    const standNach = Number((await req('GET', `/api/statistics/overtime?user_id=${uid}`, adminA.token)).body.overtime || 0);
    ok('der Überstundenstand zählt die Stunden nicht doppelt', standNach === standVor,
      `${standVor} → ${standNach} — der Nachtrag muss mit dem Zeitraum verschwinden`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nKnöpfe und Dialoge: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
