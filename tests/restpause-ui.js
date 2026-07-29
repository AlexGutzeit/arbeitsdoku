// Restpausen-Vorbelegung (#13): Die Pause wird nur noch mit dem REST zur Firmenpause vorbelegt.
//
// Firmenpause 30: erster Auftrag 30 → danach 0. Erster 15 → nächster 15; werden dort 10 genommen
// → dritter 5; bis 0. Gegenstück zur Startzeit, die an den letzten Eintrag anschließt.
//
// Reine Vorbelegung: An Ist-, Soll- und Überstunden ändert sich nichts. Geprüft wird deshalb, was
// im FELD steht — und ausdrücklich, dass eine gespeicherte Pause beim Bearbeiten unangetastet
// bleibt. Würde dort die Restpause gerechnet, zeigte ein Eintrag mit voller Pause plötzlich 0 und
// einmal Speichern löschte sie.
//   node tests/restpause-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3193, DB = '/tmp/restpause.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Die Uhr stellen: Vor dem Arbeitsbeginn schlägt das Formular „jetzt" vor, und Zeitangaben in den
// Prüfungen stimmten dann nicht mehr. Ohne das wäre der Test nur zu bestimmten Tageszeiten grün.
async function uhrStellen(page, stunde, minute) {
  await page.evaluateOnNewDocument((h, m) => {
    const Echt = Date; const basis = new Echt(); basis.setHours(h, m, 0, 0);
    const versatz = basis.getTime() - Echt.now();
    function Gestellt(...a) { return a.length === 0 ? new Echt(Echt.now() + versatz) : new Echt(...a); }
    Gestellt.prototype = Echt.prototype; Gestellt.now = () => Echt.now() + versatz;
    Gestellt.parse = Echt.parse; Gestellt.UTC = Echt.UTC; window.Date = Gestellt;
  }, stunde, minute);
}

const feld = (page, id) => page.evaluate(i => (document.getElementById(i) || {}).value, id);
const hinweis = (page) => page.evaluate(() => {
  const el = document.getElementById('ef-break-hinweis');
  return el && el.checkVisibility && el.checkVisibility() ? el.innerText : '';
});

async function anmelden(page, name, pw) {
  await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-user', { timeout: 15000 });
  await page.type('#login-user', name); await page.type('#login-pass', pw);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 });
  await sleep(500);
}
// Hash-Wechsel ohne Änderung lädt NICHT neu — immer erst weg vom Ziel.
async function neuesFormular(page) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
  await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ef-break', { timeout: 15000 });
  await sleep(900);
}

const HEUTE = new Date().toISOString().slice(0, 10);
const GESTERN = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/restpause-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/restpause-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await an('admin'), maxA = await an('max');
    const uid = maxA.user.id;
    const eintrag = (datum, von, bis, pause) => req('POST', '/api/entries', adminA.token,
      { date: datum, time_from: von, time_to: bis, break_minutes: pause, user_id: uid });
    // Diese Prüfungen gelten der ERWACHSENEN-Tabelle (§ 4 ArbZG). Ohne Geburtsdatum nimmt die App
    // vorsichtshalber „unter 18" an — das muss hier also ausdrücklich gesetzt werden, sonst prüfte
    // der Test unbemerkt die Jugendschutz-Werte. (§ 11 JArbSchG: tests/pause-jugendschutz-ui.js)
    const volljaehrig = new Date(); volljaehrig.setFullYear(volljaehrig.getFullYear() - 35);
    await req('PUT', `/api/users/${uid}`, adminA.token, { birth_date: volljaehrig.toISOString().slice(0, 10) });


    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await uhrStellen(page, 12, 0);
    await anmelden(page, 'max', pw('max'));

    // ── Erster Eintrag des Tages: volle Firmenpause ──────────────────────────────────────
    console.log('\nDein Beispiel, Firmenpause 30:');
    await neuesFormular(page);
    ok('erster Auftrag → 30 vorbelegt', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    ok('und KEIN Hinweis, weil noch nichts erfasst ist', (await hinweis(page)) === '', await hinweis(page));

    // ── Planungs-Übernahme bei LEEREM Tag: der Planungswert gilt ────────────────────────
    console.log('\nÜbernahme aus der Planung:');
    const plan = await req('POST', '/api/planning', adminA.token, {
      date: HEUTE, time_from: '07:00', time_to: '16:00', break_minutes: 45,
      assigned_user_ids: [uid], client: 'Planungskunde' });
    const planId = plan.body?.entry?.id;
    ok('Planung mit 45 min Pause angelegt', !!planId, JSON.stringify(plan.body).slice(0, 120));
    await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
    await page.goto(BASIS + `/#/planning/accept/${planId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(1200);
    ok('leerer Tag → der geplante Wert 45 steht im Feld', (await feld(page, 'ef-break')) === '45',
      await feld(page, 'ef-break'));

    // ── 30 genommen → danach 0 ──────────────────────────────────────────────────────────
    await eintrag(HEUTE, '07:00', '11:00', 30);
    await neuesFormular(page);
    ok('nach 30 min → 0 vorbelegt', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('mit Hinweis, warum', /30 min erfasst/.test(await hinweis(page)), await hinweis(page));
    ok('der Hinweis nennt auch die Firmenpause', /Firmenpause 30/.test(await hinweis(page)), await hinweis(page));

    // ── Planungs-Übernahme bei BELEGTEM Tag: die Restpause gewinnt ──────────────────────
    await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
    await page.goto(BASIS + `/#/planning/accept/${planId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(1200);
    ok('belegter Tag → die Restpause schlägt den Planungswert (0 statt 45)',
      (await feld(page, 'ef-break')) === '0',
      `${await feld(page, 'ef-break')} — sonst stünde die Pause zweimal im Tag`);
    ok('mit Hinweis auf das schon Erfasste', /30 min erfasst/.test(await hinweis(page)), await hinweis(page));

    // ── Die Kette aus deinem Beispiel: 15 → 15, dann 10 → 5, dann 5 → 0 ─────────────────
    console.log('\nDie Kette 15 → 10 → 5:');
    await req('DELETE', `/api/entries/${(await req('GET', `/api/entries?date_from=${HEUTE}&date_to=${HEUTE}`, adminA.token)).body.entries[0].id}`, adminA.token, { reason: 'Testaufbau' });
    await eintrag(HEUTE, '07:00', '09:00', 15);
    await neuesFormular(page);
    ok('nach 15 min → 15 vorbelegt', (await feld(page, 'ef-break')) === '15', await feld(page, 'ef-break'));
    await eintrag(HEUTE, '09:00', '11:00', 10);
    await neuesFormular(page);
    ok('nach 15 + 10 → 5 vorbelegt', (await feld(page, 'ef-break')) === '5', await feld(page, 'ef-break'));
    await eintrag(HEUTE, '11:00', '13:00', 5);
    await neuesFormular(page);
    ok('nach 15 + 10 + 5 → 0 vorbelegt', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('der Hinweis zählt alles zusammen', /30 min erfasst/.test(await hinweis(page)), await hinweis(page));

    // ── Mehr als die Firmenpause → nie negativ ──────────────────────────────────────────
    console.log('\nGrenzfälle:');
    await eintrag(HEUTE, '13:00', '15:00', 45);
    await neuesFormular(page);
    ok('mehr als die Firmenpause → 0, nicht negativ', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));

    // ── Anderer Tag: unberührt ──────────────────────────────────────────────────────────
    await page.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, GESTERN);
    await sleep(1500);
    ok('Datumswechsel auf einen leeren Tag → wieder 30', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    ok('und der Hinweis verschwindet', (await hinweis(page)) === '', await hinweis(page));
    await page.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, HEUTE);
    await sleep(1500);
    ok('zurück auf heute → wieder 0', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));

    // ── Manuell gesetzt: wird NICHT überschrieben ───────────────────────────────────────
    console.log('\nManuelle Eingabe hat Vorrang:');
    await page.evaluate(() => {
      const el = document.getElementById('ef-break'); el.value = '25';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate((d) => {
      const el = document.getElementById('ef-date'); el.value = d;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, GESTERN);
    await sleep(1500);
    ok('manuell gesetzte Pause bleibt beim Datumswechsel stehen', (await feld(page, 'ef-break')) === '25', await feld(page, 'ef-break'));
    ok('die Startzeit zieht trotzdem nach (eigene Erkennung je Feld)',
      (await feld(page, 'ef-from')) === '07:00', await feld(page, 'ef-from'));

    // ── BEARBEITEN: gespeicherte Pause bleibt unangetastet ──────────────────────────────
    console.log('\nBearbeiten — der gefährliche Fall:');
    const vorhandene = (await req('GET', `/api/entries?date_from=${HEUTE}&date_to=${HEUTE}`, adminA.token)).body.entries;
    const mitPause = vorhandene.find(e => e.break_minutes === 45);
    await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
    await page.goto(BASIS + `/#/entry/${mitPause.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(900);
    ok('beim Bearbeiten steht die GESPEICHERTE Pause im Feld (45)',
      (await feld(page, 'ef-break')) === '45',
      `${await feld(page, 'ef-break')} — würde hier die Restpause stehen, löschte einmal Speichern die Pause`);
    ok('und es erscheint kein Restpausen-Hinweis', (await hinweis(page)) === '', await hinweis(page));

    // Gegenprobe: Speichern ändert die Pause nicht
    await page.click('#entry-form button[type="submit"]');
    await sleep(700);
    if (await page.evaluate(() => !!document.querySelector('.modal-overlay [data-act="ok"]'))) {
      await page.click('.modal-overlay [data-act="ok"]'); await sleep(1500);
    }
    const danach = (await req('GET', '/api/entries/' + mitPause.id, adminA.token)).body.entry;
    ok('nach dem Speichern ist die Pause unverändert 45', danach.break_minutes === 45, String(danach.break_minutes));

    // ── Admin: ohne gewählten Mitarbeiter gibt es keinen Tagesbezug ─────────────────────
    console.log('\nAdmin bucht für jemanden:');
    await anmelden(page, 'admin', pw('admin'));
    await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
    await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(1000);
    ok('ohne Auswahl steht der Firmenwert 30 da', (await feld(page, 'ef-break')) === '30',
      `${await feld(page, 'ef-break')} — ohne Mitarbeiter gibt es keinen Tag, auf den sich ein Rest bezöge`);
    ok('und kein Hinweis', (await hinweis(page)) === '', await hinweis(page));

    await page.evaluate((id) => {
      const el = document.getElementById('ef-user'); el.value = String(id);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, uid);
    await sleep(1800);
    ok('nach der Auswahl zieht die Restpause des Mitarbeiters nach (0)',
      (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('samt Hinweis', /erfasst/.test(await hinweis(page)), await hinweis(page));

    // ── Firmenwert geändert → Vorschlag folgt ───────────────────────────────────────────
    console.log('\nFirmenwert wirkt:');
    await req('PUT', '/api/settings', adminA.token, { break_minutes_default: 60 });
    await anmelden(page, 'max', pw('max'));       // frische Sitzung: Firmenwerte werden einmal je Sitzung geholt
    await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
    await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(1000);
    ok('bei Firmenpause 60 und 75 erfassten Minuten → 0', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('der Hinweis nennt den neuen Firmenwert', /Firmenpause 60/.test(await hinweis(page)), await hinweis(page));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nRestpausen-Vorbelegung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
