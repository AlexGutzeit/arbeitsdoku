// Drei sich überschneidende Aufträge — Pausenvorschlag UND Arbeitszeit-Warnung, Schritt für Schritt.
//
// Alex' Vorgabe (30.07.2026): Zwei Aufträge überschneiden sich so, dass 9 Std Anwesenheit
// herauskommen; der dritte überschneidet ebenfalls und hebt den Tag über 10 Std. Im ersten Auftrag
// 30 min Pause, im zweiten 45 min. Danach dasselbe mit einem Minderjährigen.
//
// Die Kette (beide Personen identisch gebucht):
//   1  07:00–13:00              →  6 Std Anwesenheit
//   2  12:00–16:00 (1 Std Überschneidung) →  9 Std Anwesenheit
//   3  15:00–18:00 (1 Std Überschneidung) → 11 Std Anwesenheit
//   3b 15:00–19:00 als Variante            → 12 Std Anwesenheit
//
// Der lehrreiche Punkt: Die Warnung haengt an der ARBEITSZEIT, der Pausenvorschlag an der
// ANWESENHEIT. Bei 11 Std Anwesenheit und 75 min Pause sind es 9:45 Arbeitszeit — fuer den
// Erwachsenen also KEINE Warnung, fuer den Minderjaehrigen sehr wohl.
//
//   node tests/ueberschneidung-kette-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3220, DB = '/tmp/ueberschneidung.db', BASIS = `http://localhost:${PORT}`;
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
  const lg = fs.openSync('/tmp/ueberschneidung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/ueberschneidung-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    await req('PUT', '/api/settings', admin.token, { break_minutes_default: 30 });
    const neu = async (u, name, alter) => {
      const r = await req('POST', '/api/users', admin.token,
        { username: u, password: 'Start!2345', name, birth_date: jahre(alter), ...MA });
      if (r.status >= 300) throw new Error(u + ': ' + r.text);
      return r.body.user;
    };
    const gerd = await neu('gerd', 'Gerd Gross', 40);
    const anton = await neu('anton', 'Anton Azubi', 16);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument(() => {
      const E = Date; const b = new E(); b.setHours(19, 30, 0, 0); const v = b.getTime() - E.now();
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
    // Ohne Handanlegen an der Pause — sonst friert der Hinweis ein (gewolltes Verhalten).
    async function messen(datum, von, bis) {
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(400);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break'); await sleep(800);
      await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
      await sleep(1200);
      await page.evaluate((v, b) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
      }, von, bis);
      await sleep(1600);
      return {
        pause: await page.evaluate(() => document.getElementById('ef-break').value),
        netto: await page.evaluate(() => (document.getElementById('ef-net') || {}).textContent || ''),
        hinweis: await page.evaluate(() => { const e = document.getElementById('ef-break-hinweis'); return e && e.checkVisibility && e.checkVisibility() ? e.innerText : ''; }),
        warnung: await page.evaluate(() => { const e = document.getElementById('ef-zeit-warnung'); return e && e.checkVisibility && e.checkVisibility() ? e.innerText : ''; }),
      };
    }
    const buchen = (uid, tag, von, bis, pause) => req('POST', '/api/entries', admin.token,
      { date: tag, time_from: von, time_to: bis, break_minutes: pause, user_id: uid })
      .then(r => { if (r.status >= 300) throw new Error('Buchung: ' + r.text); });

    // Erwartung je Person. „warnt" = Text muss erscheinen (und das genannte Gesetz stimmen).
    const LAEUFE = [
      { wer: gerd, nutzer: 'gerd', jung: false, titel: 'Erwachsener (§ 3 ArbZG, Decke 10 Std)',
        schritte: [
          { von: '07:00', bis: '13:00', vorschlag: '30', nimmt: 30, warnt: null, hinweis: null },
          // 9 Std Anwesenheit minus 30 min Pause sind 8,5 Std Arbeitszeit — unter 9, das Gesetz
          // hebt also NICHTS an. Dann erscheint bewusst die kurze Zeile ohne Paragraphen.
          { von: '12:00', bis: '16:00', vorschlag: '0',  nimmt: 45, warnt: null,
            hinweis: /^Firmenpause 30 min · heute schon 30 min erfasst$/ },
          { von: '15:00', bis: '18:00', vorschlag: '0',  nimmt: 0,  warnt: null,
            hinweis: /11 Std Anwesenheit/ },
        ],
        variante: { von: '15:00', bis: '19:00', warnt: /10 Std 45 min/, gesetz: /§ 3 ArbZG/ } },
      { wer: anton, nutzer: 'anton', jung: true, titel: 'Minderjähriger (§ 8/§ 11 JArbSchG, Decke 8 Std)',
        schritte: [
          { von: '07:00', bis: '13:00', vorschlag: '30', nimmt: 30, warnt: null, hinweis: null },
          // Beim Jugendlichen greift das Gesetz schon hier — deshalb steht die Anwesenheit im Text
          // und belegt zugleich, dass die Ueberschneidung richtig gelesen wird: 9 Std, nicht 10.
          { von: '12:00', bis: '16:00', vorschlag: '30', nimmt: 45, warnt: null,
            hinweis: /9 Std Anwesenheit/ },
          { von: '15:00', bis: '18:00', vorschlag: '0',  nimmt: 0,  warnt: /9 Std 45 min/,
            hinweis: /11 Std Anwesenheit/ },
        ],
        variante: { von: '15:00', bis: '19:00', warnt: /10 Std 45 min/, gesetz: /Jugendarbeitsschutzgesetz/ } },
    ];

    for (const lauf of LAEUFE) {
      console.log(`\n── ${lauf.titel} ──`);
      const tag = tagNr(lauf.jung ? 1 : 0);
      await anmelden(lauf.nutzer, 'Start!2345');
      let nr = 0;
      for (const s of lauf.schritte) {
        nr++;
        const m = await messen(tag, s.von, s.bis);
        console.log(`   Auftrag ${nr}  ${s.von}–${s.bis}   Vorschlag ${m.pause} min   ${m.netto}`);
        if (m.hinweis) console.log(`      Pause:   „${m.hinweis}"`);
        if (m.warnung) console.log(`      Warnung: „${m.warnung}"`);
        ok(`${lauf.nutzer} · Auftrag ${nr} (${s.von}–${s.bis}) → Vorschlag ${s.vorschlag} min`,
          m.pause === s.vorschlag, `${m.pause} min`);
        if (s.hinweis) {
          ok(`${lauf.nutzer} · Auftrag ${nr}: der Hinweis darunter stimmt`, s.hinweis.test(m.hinweis), `„${m.hinweis}"`);
        }
        if (s.warnt) ok(`${lauf.nutzer} · Auftrag ${nr}: Arbeitszeit-Warnung erscheint`, s.warnt.test(m.warnung), `„${m.warnung}"`);
        else ok(`${lauf.nutzer} · Auftrag ${nr}: keine Arbeitszeit-Warnung`, m.warnung === '', `„${m.warnung}"`);
        await buchen(lauf.wer.id, tag, s.von, s.bis, s.nimmt);
      }
      // Variante: derselbe dritte Auftrag, aber eine Stunde laenger.
      const v = lauf.variante;
      const mv = await messen(tag, v.von, v.bis);
      console.log(`   Variante  ${v.von}–${v.bis}   Vorschlag ${mv.pause} min   ${mv.netto}`);
      if (mv.warnung) console.log(`      Warnung: „${mv.warnung}"`);
      ok(`${lauf.nutzer} · Variante bis ${v.bis}: Warnung erscheint`, v.warnt.test(mv.warnung), `„${mv.warnung}"`);
      ok(`${lauf.nutzer} · Variante: das genannte Gesetz stimmt`, v.gesetz.test(mv.warnung), `„${mv.warnung}"`);

      const alle = (await req('GET', `/api/entries?date_from=${tag}&date_to=${tag}`, admin.token))
        .body.entries.filter(e => e.user_id === lauf.wer.id);
      const pausen = alle.reduce((s2, e) => s2 + Number(e.break_minutes || 0), 0);
      ok(`${lauf.nutzer} · am Tagesende 3 Einträge und 75 min Pause`,
        alle.length === 3 && pausen === 75, `${alle.length} Einträge, ${pausen} min`);
    }

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nÜberschneidungs-Kette: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
