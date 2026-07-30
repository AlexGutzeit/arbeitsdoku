// Hinweis bei Überschreitung der gesetzlichen Höchstarbeitszeit.
//
// § 3 ArbZG: 10 Stunden sind die harte Tagesdecke für Erwachsene.
// § 8 JArbSchG: 8 Stunden am Tag UND 40 Stunden in der Woche für unter 18-Jährige.
//
// Drei Dinge, die man leicht falsch baut und die hier deshalb einzeln geprüft werden:
//   * Es zählt der GANZE TAG, nicht die einzelne Buchung — dreimal vier Stunden reissen die Grenze,
//     ohne dass ein einzelner Eintrag auffällig wäre.
//   * Beim BEARBEITEN darf der eigene gespeicherte Eintrag nicht doppelt zählen.
//   * Die Grenze ist „mehr als", nicht „ab": Genau 10:00 ist noch erlaubt.
//
// Es ist ein Hinweis, KEINE Sperre — wer elf Stunden gearbeitet hat, muss das eintragen können.
// Auch das wird geprüft.
//
//   node tests/hoechstarbeitszeit-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3215, DB = '/tmp/hoechstarbeitszeit.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const jahre = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
const MA = { role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 };
// Montag der vorletzten Woche — sicher vergangen, und die ganze Woche liegt frei.
function montagVorletzteWoche() {
  const d = new Date(); d.setDate(d.getDate() - 14);
  const wt = d.getDay();
  d.setDate(d.getDate() + (wt === 0 ? -6 : 1 - wt));
  return d.toISOString().slice(0, 10);
}
const plusTage = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/hoechstarbeitszeit-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/hoechstarbeitszeit-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    await req('PUT', '/api/settings', admin.token, { break_minutes_default: 30 });

    const anlegen = async (u, name, alter) => {
      const r = await req('POST', '/api/users', admin.token,
        { username: u, password: 'Start!2345', name, birth_date: jahre(alter), ...MA });
      if (r.status >= 300) throw new Error(u + ': ' + r.text);
      return r.body.user;
    };
    const erwachsen = await anlegen('gross', 'Gerd Gross', 40);
    const jung = await anlegen('klein', 'Jonas Klein', 16);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument(() => {
      const E = Date; const b = new E(); b.setHours(19, 0, 0, 0); const v = b.getTime() - E.now();
      function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
      G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
    });
    const anmelden = async (n, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', n); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
    };
    const warnung = () => page.evaluate(() => {
      const el = document.getElementById('ef-zeit-warnung');
      return el && el.checkVisibility && el.checkVisibility() ? el.innerText : '';
    });
    // Formular oeffnen und Werte setzen; gibt den Warntext zurueck.
    async function messen(datum, von, bis, pause, editId) {
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(400);
      await page.goto(BASIS + (editId ? '/#/entry/' + editId : '/#/entry/new'), { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break'); await sleep(800);
      if (!editId) {
        await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
        await sleep(1000);
      }
      await page.evaluate((v, b, p) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to'), br = document.getElementById('ef-break');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
        br.value = String(p); br.dispatchEvent(new Event('change', { bubbles: true }));
      }, von, bis, pause);
      await sleep(1600);
      return warnung();
    }

    const woche = montagVorletzteWoche();
    const tagA = plusTage(woche, 0), tagB = plusTage(woche, 1), tagC = plusTage(woche, 2);

    console.log('\n── Erwachsener (§ 3 ArbZG, Decke 10 Std) ───────────────');
    await anmelden('gross', 'Start!2345');
    let w = await messen(tagA, '07:00', '17:45', 45);   // netto genau 10:00
    ok('genau 10:00 Arbeitszeit → keine Warnung', w === '', `„${w}"`);
    w = await messen(tagA, '07:00', '17:46', 45);       // netto 10:01
    ok('10:01 → Warnung erscheint', /10 Std 1 min/.test(w) && /§ 3 ArbZG/.test(w), `„${w}"`);
    ok('… und sie nennt das Arbeitszeitgesetz, nicht den Jugendschutz',
      /Arbeitszeitgesetz erlaubt/.test(w) && !/Jugendarbeitsschutz/.test(w), `„${w}"`);

    console.log('\n── … über mehrere Einträge desselben Tages ─────────────');
    for (const [von, bis] of [['06:00', '10:00'], ['10:00', '14:00']]) {
      const r = await req('POST', '/api/entries', admin.token,
        { date: tagB, time_from: von, time_to: bis, break_minutes: 0, user_id: erwachsen.id });
      if (r.status >= 300) throw new Error('Vorbereitung: ' + r.text);
    }
    w = await messen(tagB, '14:00', '17:00', 0);        // 4 + 4 + 3 = 11:00
    ok('3 Einträge zusammen 11:00 → Warnung', /11 Std/.test(w) && /§ 3 ArbZG/.test(w), `„${w}"`);
    w = await messen(tagB, '14:00', '16:00', 0);        // 4 + 4 + 2 = 10:00
    ok('… bei zusammen genau 10:00 wieder weg', w === '', `„${w}"`);

    // ── Alex' Fall: zwei ZEITGLEICHE Einträge ───────────────────────────────────────────────
    // 7–11 und noch einmal 7–11 (zwei Auftraege parallel dokumentiert, so gewollt), dann 11–15:30
    // mit 30 min Pause. Abgerechnet sind das 12 Stunden, GEARBEITET wurden 8 — und nur die zaehlen
    // fuer das Arbeitszeitgesetz. Die Warnung darf hier also NICHT kommen. Genau daran scheitert
    // eine naive Summe ueber die Einträge.
    console.log('\n── Zeitgleiche Einträge: 12 Std abgerechnet, 8 Std gearbeitet ──');
    const tagD = plusTage(woche, 3);
    for (const nutzer of [erwachsen, jung]) {
      for (let i = 0; i < 2; i++) {
        const r = await req('POST', '/api/entries', admin.token,
          { date: tagD, time_from: '07:00', time_to: '11:00', break_minutes: 0, user_id: nutzer.id });
        if (r.status >= 300) throw new Error('Vorbereitung parallel: ' + r.text);
      }
    }
    w = await messen(tagD, '11:00', '15:30', 30);          // ueberlappungsfrei 07:00–15:30 minus 30 = 8:00
    ok('Erwachsener: 2× 7–11 parallel + 11–15:30 → keine Warnung', w === '', `„${w}"`);
    const summeAbgerechnet = (await req('GET', `/api/entries?date_from=${tagD}&date_to=${tagD}`, admin.token))
      .body.entries.filter(e => e.user_id === erwachsen.id).reduce((s, e) => s + Number(e.net_hours || 0), 0);
    ok('… obwohl die beiden gebuchten Einträge allein schon 8 Std ergeben', summeAbgerechnet === 8, String(summeAbgerechnet));

    await anmelden('klein', 'Start!2345');
    w = await messen(tagD, '11:00', '15:30', 30);          // ebenfalls genau 8:00
    ok('unter 18: dieselbe Buchung → noch keine Warnung (genau 8:00)', w === '', `„${w}"`);
    w = await messen(tagD, '11:00', '15:45', 30);          // eine Viertelstunde laenger → 8:15
    ok('unter 18: eine Viertelstunde länger → Warnung', /8 Std 15 min/.test(w) && /Jugendarbeitsschutzgesetz/.test(w), `„${w}"`);
    await anmelden('gross', 'Start!2345');
    w = await messen(tagD, '11:00', '15:45', 30);
    ok('Erwachsener bei derselben Verlängerung → weiterhin keine Warnung', w === '', `„${w}"`);

    console.log('\n── Bearbeiten: der eigene Eintrag zählt nicht doppelt ──');
    const lang = await req('POST', '/api/entries', admin.token,
      { date: tagC, time_from: '07:00', time_to: '16:00', break_minutes: 30, user_id: erwachsen.id });   // netto 8:30
    if (lang.status >= 300) throw new Error('Vorbereitung: ' + lang.text);
    const langId = lang.body.entry ? lang.body.entry.id : lang.body.id;
    w = await messen(tagC, '07:00', '16:00', 30, langId);
    ok('vorhandenen 8:30-Eintrag öffnen → keine Warnung (kein Doppelzählen)', w === '', `„${w}"`);
    w = await messen(tagC, '07:00', '18:30', 30, langId);   // auf netto 11:00 verlängert
    ok('denselben Eintrag auf 11:00 verlängern → Warnung', /11 Std/.test(w), `„${w}"`);

    console.log('\n── Speichern bleibt erlaubt (Hinweis, keine Sperre) ────');
    // Beim Bearbeiten fragt die App eine Begruendung ab (GoBD). Ohne diese Antwort haengt der
    // Absendevorgang im Dialog — daran ist dieser Test beim ersten Lauf haengengeblieben.
    await page.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await page.waitForSelector('#pm-input', { timeout: 15000 });
    await page.type('#pm-input', 'Langer Einsatz, Zeiten nachgetragen');
    await page.click('[data-act="ok"]');
    await sleep(2500);
    const gespeichert = (await req('GET', `/api/entries?date_from=${tagC}&date_to=${tagC}`, admin.token))
      .body.entries.find(e => Number(e.id) === Number(langId));
    ok('der überlange Eintrag lässt sich speichern', gespeichert && gespeichert.time_to === '18:30',
      JSON.stringify(gespeichert && gespeichert.time_to));

    console.log('\n── Unter 18 (§ 8 JArbSchG, 8 Std / 40 Std) ─────────────');
    await anmelden('klein', 'Start!2345');
    w = await messen(tagA, '07:00', '16:00', 60);       // netto 8:00
    ok('genau 8:00 → keine Warnung', w === '', `„${w}"`);
    w = await messen(tagA, '07:00', '16:30', 60);       // netto 8:30
    ok('8:30 → Warnung nach Jugendarbeitsschutzgesetz',
      /8 Std 30 min/.test(w) && /Jugendarbeitsschutzgesetz/.test(w), `„${w}"`);
    ok('… und sie nennt die 8½-Bedingung', /8½ nur, wenn an einem anderen Tag/.test(w), `„${w}"`);
    ok('… und NICHT das Arbeitszeitgesetz der Erwachsenen', !/§ 3 ArbZG/.test(w), `„${w}"`);

    console.log('\n── Wochengrenze der Jugendlichen (40 Std) ──────────────');
    // Mo–Do je 8:00 netto = 32:00. Der Freitag im Formular entscheidet.
    for (let i = 0; i < 4; i++) {
      const r = await req('POST', '/api/entries', admin.token,
        { date: plusTage(woche, i), time_from: '07:00', time_to: '16:00', break_minutes: 60, user_id: jung.id });
      if (r.status >= 300) throw new Error('Woche: ' + r.text);
    }
    w = await messen(plusTage(woche, 4), '07:00', '16:00', 60);   // 32 + 8 = 40:00
    ok('Woche genau 40:00 → keine Warnung', w === '', `„${w}"`);
    w = await messen(plusTage(woche, 4), '07:00', '16:15', 60);   // 32 + 8:15 = 40:15
    ok('Woche 40:15 → Wochen-Warnung', /40 Std 15 min/.test(w) && /40 Stunden pro Woche/.test(w), `„${w}"`);
    ok('… und der Tag (8:15) wird im selben Hinweis genannt', /8 Std 15 min/.test(w), `„${w}"`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nHöchstarbeitszeit: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
