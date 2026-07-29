// Zwei Alterstabellen: § 4 ArbZG ab 18, § 11 JArbSchG darunter.
//
// Maßgeblich ist das Geburtsdatum beim Mitarbeiter. FEHLT es, wird „unter 18" angenommen — lieber
// eine zu lange Pause vorschlagen als eine zu kurze bei einem Minderjährigen.
//
// Gerechnet wird auf den EINTRAGSTAG, nicht auf heute: Wer im Mai 18 wird, fällt für einen Eintrag
// aus dem März noch unter den Jugendschutz. Genau dieser Übergang steht unten.
//   node tests/pause-jugendschutz-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3200, DB = '/tmp/pause-jugend.db', BASIS = `http://localhost:${PORT}`;
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
async function formular(page, datum, von, bis) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(700);
  await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(800);
  await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
  await sleep(1300);
  await page.evaluate((v, b) => {
    const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
    f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
    t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
  }, von, bis);
  await sleep(1500);
}
const T = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const vorJahren = (j, versatzTage = 0) => {
  const d = new Date(Date.now() - versatzTage * 864e5);
  d.setFullYear(d.getFullYear() - j);
  return d.toISOString().slice(0, 10);
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/pause-jugend-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/pause-jugend-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('PUT', '/api/settings', admin, { break_minutes_default: 30 });

    const anlegen = async (username, name, geburt) => {
      const r = await req('POST', '/api/users', admin, {
        username, password: 'Start!2345', name, role: 'mitarbeiter', birth_date: geburt,
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 });
      return r;
    };
    const erwachsen = await anlegen('erwachsen', 'Erika Erwachsen', vorJahren(30));
    const azubi = await anlegen('azubi', 'Jonas Jung', vorJahren(16));
    const ohne = await anlegen('ohnedatum', 'Ohne Datum', '');
    ok('drei Mitarbeiter angelegt', [erwachsen, azubi, ohne].every(r => r.status === 201),
      [erwachsen, azubi, ohne].map(r => r.status).join('/'));
    ok('das Geburtsdatum wird gespeichert und zurückgeliefert',
      erwachsen.body.user.birth_date === vorJahren(30), String(erwachsen.body.user.birth_date));
    ok('ein leeres Geburtsdatum bleibt leer', !ohne.body.user.birth_date, String(ohne.body.user.birth_date));

    const unsinn = await anlegen('unsinn', 'Un Sinn', '2099-01-01');
    ok('ein Datum in der Zukunft wird abgewiesen', unsinn.status === 400, `${unsinn.status} ${unsinn.body?.error || ''}`);
    const kaputt = await anlegen('kaputt', 'Ka Putt', '2010-02-30');
    ok('der 30. Februar wird abgewiesen', kaputt.status === 400, `${kaputt.status} ${kaputt.body?.error || ''}`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await uhrStellen(page, 19, 0);

    // ══ Normaler 8½-Stunden-Tag: derselbe Tag, drei Personen ═══════════════════════════
    console.log('\n8 Std 30 Anwesenheit — derselbe Tag, drei Personen (Firmenwert 30):');
    await anmelden(page, 'erwachsen', 'Start!2345');
    await formular(page, T(1), '07:00', '15:30');
    ok('Erwachsene: 30 min (Firmenwert, Gesetz verlangt nicht mehr)',
      (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));

    await anmelden(page, 'azubi', 'Start!2345');
    await formular(page, T(1), '07:00', '15:30');
    const azubiWert = await feld(page, 'ef-break');
    const azubiHinweis = await hinweis(page);
    console.log(`      Azubi (16): ${azubiWert} min · „${azubiHinweis}"`);
    ok('Azubi unter 18: 60 min', azubiWert === '60', azubiWert);
    ok('der Hinweis nennt das Jugendarbeitsschutzgesetz',
      /Jugendarbeitsschutzgesetz/.test(azubiHinweis), azubiHinweis);
    ok('und NICHT das Arbeitszeitgesetz', !/ Arbeitszeitgesetz/.test(azubiHinweis), azubiHinweis);
    ok('ohne Zusatz über eine Annahme, das Datum ist ja bekannt',
      !/vorsichtshalber/.test(azubiHinweis), azubiHinweis);

    await anmelden(page, 'ohnedatum', 'Start!2345');
    await formular(page, T(1), '07:00', '15:30');
    const ohneWert = await feld(page, 'ef-break');
    const ohneHinweis = await hinweis(page);
    console.log(`      Ohne Geburtsdatum: ${ohneWert} min · „${ohneHinweis}"`);
    ok('ohne Geburtsdatum wird der strengere Jugendschutz angenommen: 60 min',
      ohneWert === '60', ohneWert);
    ok('und der Hinweis sagt, dass es eine Annahme ist',
      /vorsichtshalber/.test(ohneHinweis) && /unter 18/.test(ohneHinweis), ohneHinweis);

    // ══ Kurzer Tag: die 4½-Stunden-Schwelle der Jugendlichen ═══════════════════════════
    console.log('\nKurzer Tag — die 4½-Stunden-Grenze gibt es nur für Jugendliche:');
    await anmelden(page, 'erwachsen', 'Start!2345');
    await formular(page, T(2), '07:00', '11:40');          // 4 Std 40
    ok('Erwachsene: 30 min (nur der Firmenwert)', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    await anmelden(page, 'azubi', 'Start!2345');
    await formular(page, T(2), '07:00', '11:40');
    ok('Azubi: ebenfalls 30 min — das Gesetz verlangt hier auch nur 30',
      (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));

    // ══ Der Übergang: 18. Geburtstag mitten im Zeitraum ════════════════════════════════
    console.log('\nWird jemand 18, gilt für ältere Einträge noch der Jugendschutz:');
    const geburtstagVor10Tagen = vorJahren(18, 10);        // wurde vor 10 Tagen 18
    const r = await req('POST', '/api/users', admin, {
      username: 'grenzfall', password: 'Start!2345', name: 'Gerade Achtzehn', role: 'mitarbeiter',
      birth_date: geburtstagVor10Tagen,
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 });
    ok('Mitarbeiter mit 18. Geburtstag vor 10 Tagen angelegt', r.status === 201, String(r.status));
    await anmelden(page, 'grenzfall', 'Start!2345');
    await formular(page, T(3), '07:00', '15:30');          // NACH dem 18. Geburtstag
    ok('Eintrag nach dem Geburtstag → Erwachsenen-Regel (30 min)',
      (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    await formular(page, T(20), '07:00', '15:30');         // VOR dem 18. Geburtstag
    ok('Eintrag von vor dem Geburtstag → noch Jugendschutz (60 min)',
      (await feld(page, 'ef-break')) === '60',
      `${await feld(page, 'ef-break')} — gerechnet wird auf den Eintragstag, nicht auf heute`);

    // ══ Nachtragen des Geburtsdatums wirkt ═════════════════════════════════════════════
    console.log('\nGeburtsdatum nachtragen:');
    const ohneId = ohne.body.user.id;
    const nach = await req('PUT', `/api/users/${ohneId}`, admin, { birth_date: vorJahren(40) });
    ok('Geburtsdatum lässt sich nachtragen', nach.status === 200, `${nach.status} ${nach.body?.error || ''}`);
    await anmelden(page, 'ohnedatum', 'Start!2345');
    await formular(page, T(4), '07:00', '15:30');
    ok('danach gilt die Erwachsenen-Regel (30 statt 60)',
      (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    const auditTxt = (await req('GET', '/api/audit?limit=100', admin)).text;
    ok('die Änderung steht im Protokoll', /Geburtsdatum/.test(auditTxt), auditTxt.slice(0, 120));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nJugendschutz-Pausen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
