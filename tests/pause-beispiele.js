// Beispiel-Tabelle zur Pausenlogik — gemessen an der echten Oberfläche, nicht ausgerechnet.
//
// Jede Zeile ist zugleich eine Prüfung: Die Tabelle kann also nicht veralten, ohne dass der Test
// rot wird. Wer die Vorbelegung ändert, sieht sofort, welche Beispiele nicht mehr stimmen.
//
// Gemessen wird, was ein Mitarbeiter im Feld „Pause" vorfindet und was darunter steht.
//   node tests/pause-beispiele.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3197, DB = '/tmp/pause-beispiele.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

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
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 }); await sleep(400);
}

// Jedes Beispiel bekommt einen EIGENEN Tag, damit sie sich nicht gegenseitig beeinflussen.
const tagNr = (n) => new Date(Date.now() - (n + 2) * 864e5).toISOString().slice(0, 10);

const BEISPIELE = [
  { titel: 'Kurzer Tag, nichts vorher', firma: 30, vorher: [],
    von: '07:00', bis: '12:00', erwartet: '30' },
  { titel: 'Normaler Tag am Stück', firma: 30, vorher: [],
    von: '07:00', bis: '15:30', erwartet: '30' },
  { titel: 'Zweiter Auftrag, 30 min schon genommen', firma: 30, vorher: [['07:00', '11:00', 30]],
    von: '11:00', bis: '15:00', erwartet: '0' },
  { titel: 'Zweiter Auftrag, erst 15 min genommen', firma: 30, vorher: [['07:00', '11:00', 15]],
    von: '11:00', bis: '15:00', erwartet: '15' },
  { titel: 'Dritter Auftrag, 15 + 10 genommen', firma: 30, vorher: [['07:00', '10:00', 15], ['10:00', '12:00', 10]],
    von: '12:00', bis: '15:00', erwartet: '5' },
  { titel: 'Mehr Pause genommen als vorgesehen', firma: 30, vorher: [['07:00', '12:00', 45]],
    von: '12:00', bis: '15:00', erwartet: '0' },
  { titel: '9 Std 30 Anwesenheit — noch unter der Schwelle', firma: 30, vorher: [],
    von: '07:00', bis: '16:30', erwartet: '30' },
  { titel: '9 Std 45 Anwesenheit — mit 30 wären es 9:15 Arbeitszeit', firma: 30, vorher: [],
    von: '07:00', bis: '16:45', erwartet: '45', gesetz: true },
  { titel: '11 Std Anwesenheit', firma: 30, vorher: [],
    von: '07:00', bis: '18:00', erwartet: '45', gesetz: true },
  { titel: 'Langer Tag verteilt: 2× 15 genommen, dann verlängert', firma: 30,
    vorher: [['07:00', '12:00', 15], ['12:00', '16:00', 15]],
    von: '16:00', bis: '17:00', erwartet: '15', gesetz: true },
  { titel: 'Langer Tag, 45 bereits genommen', firma: 30, vorher: [['07:00', '17:00', 45]],
    von: '17:00', bis: '18:00', erwartet: '0' },
  { titel: 'Firmenwert 45 bei 8 Std — Firma über Gesetz', firma: 45, vorher: [],
    von: '07:00', bis: '15:00', erwartet: '45' },
  { titel: 'Firmenwert 60 bei 11 Std — Firma bleibt Untergrenze', firma: 60, vorher: [],
    von: '07:00', bis: '18:00', erwartet: '60' },
  { titel: 'Firmenwert 0, kurzer Tag', firma: 0, vorher: [],
    von: '07:00', bis: '12:30', erwartet: '0' },
  { titel: 'Firmenwert 0, 6 Std 20 — die Sechs-Stunden-Falle', firma: 0, vorher: [],
    von: '07:00', bis: '13:20', erwartet: '30', gesetz: true },
];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/pause-beispiele-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  const zeilen = [];
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/pause-beispiele-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await an('admin'), maxA = await an('max');
    const uid = maxA.user.id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await uhrStellen(page, 19, 0);

    let letzterFirmenwert = null;
    for (let i = 0; i < BEISPIELE.length; i++) {
      const b = BEISPIELE[i];
      const datum = tagNr(i);
      for (const [von, bis, pause] of b.vorher) {
        await req('POST', '/api/entries', adminA.token,
          { date: datum, time_from: von, time_to: bis, break_minutes: pause, user_id: uid });
      }
      // Firmenwert nur bei Bedarf umstellen — danach neu anmelden, die Vorgaben werden je
      // Sitzung geholt.
      if (b.firma !== letzterFirmenwert) {
        await req('PUT', '/api/settings', adminA.token, { break_minutes_default: b.firma });
        await anmelden(page, 'max', pw('max'));
        letzterFirmenwert = b.firma;
      }
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(600);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(700);
      await page.evaluate((d) => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
      await sleep(1300);
      await page.evaluate((v, bi) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = bi; t.dispatchEvent(new Event('change', { bubbles: true }));
      }, b.von, b.bis);
      await sleep(1500);

      const wert = await feld(page, 'ef-break');
      const hw = await hinweis(page);
      zeilen.push({ ...b, gemessen: wert, hinweis: hw, datum });
      ok(`${b.titel} → ${b.erwartet} min`, wert === b.erwartet, `gemessen ${wert} min · Hinweis: „${hw}"`);
      if (b.gesetz) ok(`  ${b.titel}: Hinweis nennt das Gesetz`, /Arbeitszeitgesetz/.test(hw), hw);
    }

    // ── Tabelle ausgeben ────────────────────────────────────────────────────────────────
    console.log('\n╔══ Pausen-Vorbelegung: gemessene Beispiele ' + '═'.repeat(46));
    console.log('║');
    let letzteFirma = null;
    for (const z of zeilen) {
      if (z.firma !== letzteFirma) {
        console.log(`║  ── Firmenpause ${z.firma} min ` + '─'.repeat(56 - String(z.firma).length));
        letzteFirma = z.firma;
      }
      const vorherTxt = z.vorher.length
        ? z.vorher.map(v => `${v[0]}–${v[1]} (${v[2]} min)`).join(' + ')
        : '—';
      console.log(`║  ${z.titel}`);
      console.log(`║     schon gebucht: ${vorherTxt}`);
      console.log(`║     neuer Eintrag: ${z.von}–${z.bis}   →   VORSCHLAG: ${z.gemessen} min`);
      if (z.hinweis) console.log(`║     Hinweis: „${z.hinweis}"`);
      console.log('║');
    }
    console.log('╚' + '═'.repeat(88));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPausen-Beispiele: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
