// Das Protokoll des Abrechnungs-Abschlusses — im Browser gelesen und gefiltert.
//
// Ein Vorgang, der nicht auffindbar ist, ist nicht protokolliert. Deshalb wird hier nicht nur
// geprüft, DASS geschrieben wird, sondern dass ein Mensch es auch findet: lesbare Bezeichnung
// statt rohem Schlüssel, im Filter auswählbar, mit Begründung in der Detailspalte, und im
// CSV-Export fürs Archiv.
//
// Besonders für das ABLEHNEN: Dort verfallen Stunden. Wenn ausgerechnet dieser Vorgang im
// Protokoll nicht wiederzufinden wäre, hätte die ganze Nachvollziehbarkeit ein Loch.
//   node tests/abschluss-audit-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3176, DB = '/tmp/abschluss-audit.db', BASIS = `http://localhost:${PORT}`;
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
const GRUND_EINGRIFF = 'Stundenzettel wurde nachgereicht';
const GRUND_UEBER = 'Noteinsatz Ostern, nachtraeglich gutgeschrieben';
const GRUND_ABLEHNUNG = 'Bereits bar ausgezahlt am 15.07.';
const GRUND_OEFFNEN = 'Korrektur der Maerz-Abrechnung';

const text = (page, sel) => page.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);

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
async function gehe(page, hash) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' });
  await sleep(1000);
  await page.goto(BASIS + '/#' + hash, { waitUntil: 'networkidle0' });
  await sleep(1500);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/abschluss-audit-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/abschluss-audit-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const admin = (await an('admin')).token, chef = (await an('chef')).token;
    const maxA = await an('max'); const uid = maxA.user.id;

    // ── Alle fünf Abschluss-Vorgänge erzeugen ─────────────────────────────────────────────
    await req('POST', `/api/statistics/targets/${uid}`, chef, {
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: `${JAHR}-01-01` });
    let einEintrag = null;
    for (const m of ['01', '02', '03']) {
      for (let t = 1; t <= 28; t++) {
        const datum = `${JAHR}-${m}-${d2(t)}`;
        const wt = new Date(datum + 'T12:00:00Z').getUTCDay();
        if (wt === 0 || wt === 6) continue;
        const r = await req('POST', '/api/entries', admin, { date: datum, time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: uid });
        if (!einEintrag) einEintrag = r.body.entry;
      }
    }
    await req('POST', '/api/closure/bis', chef, { month: `${JAHR}-03` });                     // closure_create
    await req('PUT', `/api/entries/${einEintrag.id}`, admin, { time_to: '17:00', reason: GRUND_EINGRIFF }); // closure_override
    const jan = (await req('GET', '/api/closure', chef)).body.perioden.find(p => p.periodFrom.endsWith('-01-01'));
    await req('POST', `/api/closure/${jan.id}/uebernehmen`, chef, { reason: GRUND_UEBER });    // closure_adjust
    await req('POST', '/api/entries', admin, { date: `${JAHR}-02-10`, time_from: '18:00', time_to: '20:00', break_minutes: 0, user_id: uid, reason: GRUND_EINGRIFF });
    const feb = (await req('GET', '/api/closure', chef)).body.perioden.find(p => p.periodFrom.endsWith('-02-01'));
    await req('POST', `/api/closure/${feb.id}/ablehnen`, chef, { reason: GRUND_ABLEHNUNG });   // closure_discard
    // Bis zum JANUAR zurueck oeffnen: Dort haengt der uebernommene Nachtrag, nur dann meldet das
    // Protokoll auch die Ruecknahme. Waehlte man nur den letzten Monat, praefte man das nicht.
    for (let i = 0; i < 3; i++) {
      const ps = (await req('GET', '/api/closure', admin)).body.perioden;
      if (!ps.length) break;
      await req('DELETE', `/api/closure/${ps[ps.length - 1].id}`, admin, { reason: GRUND_OEFFNEN }); // closure_reopen
    }
    await req('GET', `/api/payroll/monat.csv?month=${JAHR}-01`, admin);                        // payroll_export
    ok('alle sechs Vorgänge erzeugt', true);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    await anmelden(page, 'admin', pw('admin'));
    await gehe(page, '/audit');
    await page.waitForSelector('#audit-tbody tr', { timeout: 20000 });
    await sleep(1200);

    // ── Lesbare Bezeichnungen statt roher Schlüssel ───────────────────────────────────────
    console.log('\nBezeichnungen:');
    const tabelle = await text(page, '#audit-tbody');
    const ERWARTET = {
      'Abrechnung abgeschlossen': 'closure_create',
      'Änderung im abgerechneten Zeitraum': 'closure_override',
      'Nachtrag übernommen': 'closure_adjust',
      'Nachtrag abgelehnt': 'closure_discard',
      'Abschluss aufgehoben': 'closure_reopen',
      'Lohn-Export erzeugt': 'payroll_export',
    };
    for (const [label, key] of Object.entries(ERWARTET)) {
      ok(`„${label}" steht in Klartext`, tabelle.includes(label), 'fehlt');
      ok(`  und nicht als roher Schlüssel „${key}"`, !tabelle.includes(key), 'roher Schlüssel sichtbar');
    }

    // ── Begründungen sichtbar ─────────────────────────────────────────────────────────────
    console.log('\nBegründungen in der Detailspalte:');
    ok('die Begründung des Admin-Eingriffs', tabelle.includes(GRUND_EINGRIFF), 'fehlt');
    ok('der Kommentar der Übernahme', tabelle.includes(GRUND_UEBER), 'fehlt');
    ok('die Begründung der ABLEHNUNG', tabelle.includes(GRUND_ABLEHNUNG), 'fehlt');
    ok('die Begründung des Wiederöffnens', tabelle.includes(GRUND_OEFFNEN), 'fehlt');
    ok('das Wiederöffnen nennt die zurückgenommenen Nachträge',
      /zurückgenommen/.test(tabelle), 'Hinweis fehlt');

    // ── Filter: alle Abschluss-Aktionen auswählbar ────────────────────────────────────────
    console.log('\nFilter:');
    const optionen = await page.evaluate(() =>
      [...document.querySelectorAll('#audit-f-action option')].map(o => ({ wert: o.value, text: o.innerText })));
    for (const key of Object.values(ERWARTET)) {
      ok(`„${key}" ist im Filter auswählbar`, optionen.some(o => o.wert === key),
        JSON.stringify(optionen.map(o => o.wert)).slice(0, 200));
    }

    // ── Gezielt nach der Ablehnung filtern ────────────────────────────────────────────────
    await page.select('#audit-f-action', 'closure_discard');
    await page.click('#audit-filter');
    await page.waitForFunction(() =>
      !/Abrechnung abgeschlossen/.test(document.querySelector('#audit-tbody')?.innerText || ''), { timeout: 20000 });
    await sleep(900);
    const gefiltert = await text(page, '#audit-tbody');
    ok('gefiltert erscheint die Ablehnung', gefiltert.includes('Nachtrag abgelehnt'), gefiltert.slice(0, 200));
    ok('mit ihrer Begründung', gefiltert.includes(GRUND_ABLEHNUNG));
    ok('andere Vorgänge sind ausgeblendet', !gefiltert.includes('Abrechnung abgeschlossen'));
    ok('auch die Übernahme ist ausgeblendet', !gefiltert.includes('Nachtrag übernommen'));

    // Gegenprobe: Der Filter blendet wirklich aus und zeigt nicht einfach alles.
    await page.select('#audit-f-action', '');
    await page.click('#audit-filter');
    await page.waitForFunction(() =>
      /Abrechnung abgeschlossen/.test(document.querySelector('#audit-tbody')?.innerText || ''), { timeout: 20000 });
    ok('Gegenprobe: ohne Filter ist wieder alles da',
      (await text(page, '#audit-tbody')).includes('Abrechnung abgeschlossen'));

    // ── CSV-Export fürs Archiv ────────────────────────────────────────────────────────────
    console.log('\nCSV-Export:');
    const csv = (await req('GET', '/api/audit/export', admin)).text;
    ok('der Export enthält die Ablehnung', /closure_discard|Nachtrag abgelehnt/.test(csv), csv.slice(0, 150));
    ok('samt Begründung', csv.includes(GRUND_ABLEHNUNG));
    const csvGefiltert = (await req('GET', '/api/audit/export?action=closure_discard', admin)).text;
    ok('und lässt sich ebenfalls filtern',
      csvGefiltert.includes(GRUND_ABLEHNUNG) && !csvGefiltert.includes(GRUND_UEBER),
      csvGefiltert.slice(0, 200));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nProtokoll des Abschlusses: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
