// Zwei ZEITGLEICHE Aufträge und der Pausenvorschlag (Alex, 30.07.2026).
//
// Zwei Aufträge parallel dokumentiert, je 07:00–12:00: dem Kunden gegenüber sind das 10 Stunden,
// ANWESEND war der Mitarbeiter aber nur 5. Die gesetzliche Anhebung (§ 4 ArbZG, 45 min über 9 Std
// Arbeitszeit) darf hier also NICHT greifen — sonst schlägt die App eine Pause vor, für die es
// keinen Anlass gibt, und begründet sie auch noch mit einem Gesetz.
//
// Dieselbe Falle wie bei der Höchstarbeitszeit: Es zählt die überlappungsfreie Anwesenheit,
// nicht die Summe der Einträge.
//
//   node tests/pause-parallel-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3218, DB = '/tmp/pause-parallel.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const jahre = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toLocaleDateString('sv-SE'); };
const MA = { role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 };
const tagNr = n => new Date(Date.now() - (n + 2) * 864e5).toLocaleDateString('sv-SE');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/pause-parallel-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/pause-parallel-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    await req('PUT', '/api/settings', admin.token, { break_minutes_default: 30 });
    const r = await req('POST', '/api/users', admin.token,
      { username: 'paul', password: 'Start!2345', name: 'Paul Parallel', birth_date: jahre(35), ...MA });
    if (r.status >= 300) throw new Error('Nutzer: ' + r.text);
    const uid = r.body.user.id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument(() => {
      const E = Date; const b = new E(); b.setHours(19, 0, 0, 0); const v = b.getTime() - E.now();
      function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
      G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
    });
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'paul'); await page.type('#login-pass', 'Start!2345');
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);

    // Formular oeffnen, Datum + Zeiten setzen, Vorschlag und Hinweis ablesen.
    async function messen(datum, von, bis) {
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(400);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break'); await sleep(800);
      await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
      await sleep(1100);
      await page.evaluate((v, b) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
      }, von, bis);
      await sleep(1500);
      return {
        pause: await page.evaluate(() => document.getElementById('ef-break').value),
        hinweis: await page.evaluate(() => {
          const e = document.getElementById('ef-break-hinweis');
          return e && e.checkVisibility && e.checkVisibility() ? e.innerText : '';
        }),
        warnung: await page.evaluate(() => {
          const e = document.getElementById('ef-zeit-warnung');
          return e && e.checkVisibility && e.checkVisibility() ? e.innerText : '';
        }),
      };
    }

    console.log('\n── Zweiter, ZEITGLEICHER Auftrag (je 5 Std) ────────────');
    const tag1 = tagNr(0);
    let a = await req('POST', '/api/entries', admin.token,
      { date: tag1, time_from: '07:00', time_to: '12:00', break_minutes: 30, user_id: uid });
    if (a.status >= 300) throw new Error('Vorbereitung: ' + a.text);
    let m = await messen(tag1, '07:00', '12:00');
    ok('Vorschlag 0 min — die Firmenpause ist am Tag schon genommen', m.pause === '0', `${m.pause} min · „${m.hinweis}"`);
    ok('… und KEINE gesetzliche Anhebung (Anwesenheit sind 5 Std, nicht 10)',
      !/Arbeitszeitgesetz/.test(m.hinweis), `„${m.hinweis}"`);
    ok('… und keine Höchstzeit-Warnung', m.warnung === '', `„${m.warnung}"`);

    console.log('\n── Dasselbe, aber im ersten Auftrag noch keine Pause ────');
    const tag2 = tagNr(1);
    a = await req('POST', '/api/entries', admin.token,
      { date: tag2, time_from: '07:00', time_to: '12:00', break_minutes: 0, user_id: uid });
    if (a.status >= 300) throw new Error('Vorbereitung: ' + a.text);
    m = await messen(tag2, '07:00', '12:00');
    ok('Vorschlag 30 min — die volle Firmenpause, mehr nicht', m.pause === '30', `${m.pause} min · „${m.hinweis}"`);
    ok('… und weiterhin keine gesetzliche Anhebung', !/Arbeitszeitgesetz/.test(m.hinweis), `„${m.hinweis}"`);

    console.log('\n── Gegenprobe: NACHEINANDER sind es wirklich 10 Std ─────');
    const tag3 = tagNr(2);
    a = await req('POST', '/api/entries', admin.token,
      { date: tag3, time_from: '07:00', time_to: '12:00', break_minutes: 0, user_id: uid });
    if (a.status >= 300) throw new Error('Vorbereitung: ' + a.text);
    m = await messen(tag3, '12:00', '17:00');     // Anschluss statt parallel → 10 Std Anwesenheit
    ok('hier greift das Gesetz: Vorschlag 45 min', m.pause === '45', `${m.pause} min · „${m.hinweis}"`);
    ok('… und der Hinweis nennt das Arbeitszeitgesetz', /Arbeitszeitgesetz/.test(m.hinweis), `„${m.hinweis}"`);
    ok('… und der Hinweis spricht von 10 Std Anwesenheit', /10 Std Anwesenheit/.test(m.hinweis), `„${m.hinweis}"`);

    // ── Alex' Kette vom 30.07.2026 ──────────────────────────────────────────────────────────
    // Vier Aufträge, zwei davon zeitgleich, dazwischen eine Lücke — und am Ende zieht das Gesetz
    // doch noch an. Jeder Schritt wird GEMESSEN und dann so gebucht, wie Alex ihn beschrieben hat.
    console.log('\n── Kette: 4 Aufträge, zwei davon zeitgleich ────────────');
    const tag4 = tagNr(3);
    const KETTE = [
      { nr: 1, von: '07:00', bis: '12:00', erwartet: '30', genommen: 15, was: 'erster Auftrag' },
      { nr: 2, von: '07:00', bis: '12:00', erwartet: '15', genommen: 15, was: 'zeitgleich zum ersten' },
      { nr: 3, von: '12:00', bis: '13:00', erwartet: '0',  genommen: 0,  was: 'kurz im Anschluss' },
      { nr: 4, von: '12:00', bis: '17:00', erwartet: '15', genommen: 15, was: 'langer Nachmittag, jetzt greift § 4' },
    ];
    for (const k of KETTE) {
      const g = await messen(tag4, k.von, k.bis);
      ok(`Auftrag ${k.nr} (${k.von}–${k.bis}, ${k.was}) → Vorschlag ${k.erwartet} min`,
        g.pause === k.erwartet, `${g.pause} min · „${g.hinweis}"`);
      if (g.hinweis) console.log(`      „${g.hinweis}"`);
      const r = await req('POST', '/api/entries', admin.token,
        { date: tag4, time_from: k.von, time_to: k.bis, break_minutes: k.genommen, user_id: uid });
      if (r.status >= 300) throw new Error(`Auftrag ${k.nr}: ` + r.text);
    }
    // Der Tag am Ende: Anwesenheit 07:00–17:00 = 10 Std, 45 min Pause, also 9:15 Arbeitszeit.
    const tagsEnde = (await req('GET', `/api/entries?date_from=${tag4}&date_to=${tag4}`, admin.token)).body.entries;
    const pausenSumme = tagsEnde.reduce((s, e) => s + Number(e.break_minutes || 0), 0);
    ok('am Ende sind 45 min Pause im Tag erfasst — genau das gesetzliche Soll', pausenSumme === 45, String(pausenSumme));
    ok('… und der Tag hat 4 Einträge, davon zwei zeitgleiche', tagsEnde.length === 4, String(tagsEnde.length));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPause bei zeitgleichen Aufträgen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
