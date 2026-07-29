// Was passiert mit der Restpause, wenn die Firmenpause MITTEN im Betrieb umgestellt wird?
//
// Alex' Frage: Tag 1 mit 30 min (15 + 15 erfasst), dann stellt der Chef auf 45 um — bekommt der
// dritte Termin desselben Tages dann noch einmal 15 Minuten vorgeschlagen?
//
// Der Test behauptet die Antwort nicht, er MISST sie und schreibt sie hin. Zusätzlich der klare
// Fall: Tag 2 nach der Umstellung muss die vollen 45 vorschlagen.
//   node tests/restpause-firmenwert-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3195, DB = '/tmp/restpause-fw.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function uhrStellen(page, h, m) {
  await page.evaluateOnNewDocument((s, min) => {
    const E = Date; const b = new E(); b.setHours(s, min, 0, 0); const v = b.getTime() - E.now();
    function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
    G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
  }, h, m);
}
const feld = (page, id) => page.evaluate(i => (document.getElementById(i) || {}).value, id);
const hinweis = (page) => page.evaluate(() => {
  const el = document.getElementById('ef-break-hinweis');
  return el && el.checkVisibility && el.checkVisibility() ? el.innerText : '';
});
async function anmelden(page, n, pw) {
  await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-user', { timeout: 15000 });
  await page.type('#login-user', n); await page.type('#login-pass', pw);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 }); await sleep(500);
}
async function formular(page, datum) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
  await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(900);
  if (datum) {
    await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
    await sleep(1500);
  }
}
const TAG0 = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const TAG1 = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const TAG2 = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/restpause-fw-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/restpause-fw-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await an('admin'), maxA = await an('max');
    const uid = maxA.user.id;
    const gespeichertePausen = [];
    const eintrag = async (d, von, bis, p) => {
      const r = await req('POST', '/api/entries', adminA.token,
        { date: d, time_from: von, time_to: bis, break_minutes: p, user_id: uid });
      if (r.status === 201) gespeichertePausen.push(p);
      return r;
    };
    const firmenpause = async (min) => req('PUT', '/api/settings', adminA.token, { break_minutes_default: min });
    // Diese Prüfungen gelten der ERWACHSENEN-Tabelle (§ 4 ArbZG). Ohne Geburtsdatum nimmt die App
    // vorsichtshalber „unter 18" an — das muss hier also ausdrücklich gesetzt werden, sonst prüfte
    // der Test unbemerkt die Jugendschutz-Werte. (§ 11 JArbSchG: tests/pause-jugendschutz-ui.js)
    const volljaehrig = new Date(); volljaehrig.setFullYear(volljaehrig.getFullYear() - 35);
    await req('PUT', `/api/users/${uid}`, adminA.token, { birth_date: volljaehrig.toISOString().slice(0, 10) });


    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await uhrStellen(page, 14, 0);

    // ══ TAG 1 mit Firmenpause 30 ═══════════════════════════════════════════════════════
    console.log('\nTag 1, Firmenpause 30:');
    await firmenpause(30);
    await anmelden(page, 'max', pw('max'));
    await formular(page, TAG1);
    ok('erster Termin → 30 vorbelegt', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));

    await eintrag(TAG1, '07:00', '10:00', 15);
    await formular(page, TAG1);
    ok('nach 15 min → 15 vorbelegt', (await feld(page, 'ef-break')) === '15', await feld(page, 'ef-break'));

    await eintrag(TAG1, '10:00', '13:00', 15);
    await formular(page, TAG1);
    ok('nach 15 + 15 → 0 vorbelegt (Tagessoll erreicht)', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));

    // ══ UMSTELLUNG auf 45 — mitten am Tag ══════════════════════════════════════════════
    console.log('\nChef stellt mitten am Nachmittag auf 45 um:');
    await firmenpause(45);
    const geprueft = (await req('GET', '/api/settings/arbeitszeit', maxA.token)).body.arbeitszeit;
    ok('der Server liefert jetzt 45', Number(geprueft.break_minutes_default) === 45, JSON.stringify(geprueft));

    // OHNE Neuladen: Die Firmenwerte werden einmal je Sitzung geholt.
    await formular(page, TAG1);
    const ohneNeuladen = await feld(page, 'ef-break');
    console.log(`      Ohne Neuladen der App steht im Feld: ${ohneNeuladen}`);
    ok('ohne Neuladen bleibt es beim alten Wert (Vorgabe wird je Sitzung geholt)',
      ohneNeuladen === '0', `${ohneNeuladen} — erwartet 0, weil die App noch 30 kennt`);

    // MIT Neuladen (so, wie es ein Mitarbeiter am nächsten Morgen erlebt)
    await anmelden(page, 'max', pw('max'));
    await formular(page, TAG1);
    const dritter = await feld(page, 'ef-break');
    const dritterHinweis = await hinweis(page);
    console.log(`\n      >>> Alex' Frage: dritter Termin an Tag 1 nach der Umstellung: ${dritter} min`);
    console.log(`      >>> Hinweis dazu: „${dritterHinweis}"`);
    ok('der dritte Termin bekommt die Differenz zum NEUEN Firmenwert vorgeschlagen',
      dritter === '15', `${dritter} — 45 minus 30 bereits erfasste`);
    ok('und der Hinweis erklärt es mit dem NEUEN Wert',
      /Firmenpause 45/.test(dritterHinweis) && /30 min erfasst/.test(dritterHinweis), dritterHinweis);

    // ══ TAG 2 — der klare Fall ═════════════════════════════════════════════════════════
    console.log('\nTag 2 nach der Umstellung:');
    await formular(page, TAG2);
    ok('leerer Tag → volle 45 vorbelegt', (await feld(page, 'ef-break')) === '45', await feld(page, 'ef-break'));
    ok('kein Hinweis, weil noch nichts erfasst ist', (await hinweis(page)) === '', await hinweis(page));

    await eintrag(TAG2, '07:00', '11:00', 45);
    await formular(page, TAG2);
    ok('nach 45 min → 0 vorbelegt', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('mit Hinweis auf 45', /Firmenpause 45 min · heute schon 45 min/.test(await hinweis(page)), await hinweis(page));

    // ══ Gegenrichtung: Firmenwert SENKEN ═══════════════════════════════════════════════
    console.log('\nGegenprobe — Firmenpause wieder senken:');
    await firmenpause(20);
    await anmelden(page, 'max', pw('max'));
    await formular(page, TAG2);
    ok('bei 45 erfassten und neuem Wert 20 → 0, nicht negativ',
      (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));

    // ══ Alex' genaue Folge: 15 / 15 / 0 gespeichert, dann Umstellung ═══════════════════
    // Der Unterschied zum Fall oben ist der DRITTE Eintrag mit 0 Minuten. Er ist tatsächlich
    // gespeichert — zählt aber 0 zur Summe. Die Frage ist, ob das etwas ändert.
    console.log('\nGenaue Folge 15 / 15 / 0, danach Umstellung auf 45:');
    await firmenpause(30);
    await anmelden(page, 'max', pw('max'));
    await formular(page, TAG0);
    ok('Eintrag 1 → 30 vorbelegt', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    await eintrag(TAG0, '07:00', '10:00', 15);

    await formular(page, TAG0);
    ok('Eintrag 2 → 15 vorbelegt', (await feld(page, 'ef-break')) === '15', await feld(page, 'ef-break'));
    await eintrag(TAG0, '10:00', '13:00', 15);

    await formular(page, TAG0);
    ok('Eintrag 3 → 0 vorbelegt', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    await eintrag(TAG0, '13:00', '16:00', 0);      // mit 0 GESPEICHERT

    const summe = (await req('GET', `/api/entries?date_from=${TAG0}&date_to=${TAG0}`, adminA.token)).body.entries
      .filter(e => Number(e.user_id) === Number(uid)).reduce((s, e) => s + Number(e.break_minutes || 0), 0);
    ok('drei Einträge gespeichert, Summe 30 min (15 + 15 + 0)', summe === 30, `Summe=${summe}`);

    await firmenpause(45);
    await anmelden(page, 'max', pw('max'));
    await formular(page, TAG0);
    const eintrag4 = await feld(page, 'ef-break');
    const hinweis4 = await hinweis(page);
    console.log(`\n      >>> Eintrag 4 nach der Umstellung auf 45: ${eintrag4} min`);
    console.log(`      >>> Hinweis: „${hinweis4}"`);
    ok('Eintrag 4 → 15 vorbelegt (45 minus die 30 erfassten)', eintrag4 === '15', eintrag4);
    ok('der Eintrag mit 0 Minuten ändert nichts an der Summe',
      /heute schon 30 min erfasst/.test(hinweis4), hinweis4);

    // Und weiter: werden die 15 genommen, ist wieder Schluss.
    await eintrag(TAG0, '16:00', '18:00', 15);
    await formular(page, TAG0);
    ok('Eintrag 5 → 0 vorbelegt (45 erreicht)', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    ok('Hinweis nennt 45 von 45', /Firmenpause 45 min · heute schon 45 min/.test(await hinweis(page)), await hinweis(page));

    await firmenpause(20);   // fuer die Schlusspruefung unten zuruecksetzen

    // ══ Und: gespeicherte Einträge bleiben unberührt ═══════════════════════════════════
    const alle = (await req('GET', `/api/entries?date_from=${TAG0}&date_to=${TAG2}`, adminA.token)).body.entries
      .filter(e => Number(e.user_id) === Number(uid));
    const pausen = alle.map(e => e.break_minutes).sort((a, b) => a - b);
    const erwartet = gespeichertePausen.slice().sort((a, b) => a - b);
    ok(`keine GESPEICHERTE Pause hat sich durch die Umstellungen verändert (${erwartet.length} Einträge)`,
      JSON.stringify(pausen) === JSON.stringify(erwartet),
      `gespeichert ${JSON.stringify(erwartet)}, gelesen ${JSON.stringify(pausen)}`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nFirmenwert-Umstellung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
