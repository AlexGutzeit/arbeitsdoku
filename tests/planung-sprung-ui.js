// Termine auf der Willkommensseite sind anklickbar (Alex, 07.08.2026) — wie zuvor die Aushänge.
//
// Antippen führt in die PLANUNG, dort in die TAGESANSICHT des richtigen Tages, und der angetippte
// Termin wird kurz hervorgehoben.
//
// Damit der Test etwas aussagt, liegen Termine an ZWEI Tagen und mehrere am selben Tag; angetippt
// wird einer, der weder der erste des Tages noch am ersten Tag ist. Sonst wäre „richtig gelandet"
// nicht von „zufällig richtig" zu unterscheiden.
//
//   node tests/planung-sprung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3232, DB = '/tmp/planung-sprung.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Zwei Tage DIESER Woche, damit die Willkommensseite sie zeigt (sie blickt auf die laufende KW).
function tageDieserWoche() {
  const heute = new Date();
  const wt = heute.getDay();
  const montag = new Date(heute); montag.setDate(heute.getDate() + (wt === 0 ? -6 : 1 - wt));
  const iso = (d) => d.toLocaleDateString('sv-SE');
  const a = new Date(montag); a.setDate(montag.getDate() + 1);   // Dienstag
  const b = new Date(montag); b.setDate(montag.getDate() + 3);   // Donnerstag
  return [iso(a), iso(b)];
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planung-sprung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/planung-sprung-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;

    const [tagA, tagB] = tageDieserWoche();
    // Die Route erwartet assigned_user_ids (nicht user_ids) und antwortet mit { entry: … }.
    const anlegen = async (datum, von, bis, text) => {
      const r = await req('POST', '/api/planning', admin.token,
        { date: datum, time_from: von, time_to: bis, description: text, assigned_user_ids: [max.user.id] });
      if (r.status >= 300) throw new Error('Planung: ' + r.text);
      return r.body.entry.id;
    };
    const ids = {
      a1: await anlegen(tagA, '07:00', '09:00', 'Erster am ersten Tag'),
      b1: await anlegen(tagB, '08:00', '10:00', 'Erster am zweiten Tag'),
      b2: await anlegen(tagB, '13:00', '16:00', 'ZWEITER am zweiten Tag'),
    };
    console.log(`   Termine: ${tagA} (1) und ${tagB} (2) — angetippt wird der zweite am ${tagB}\n`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 500, height: 900 });
    page.setDefaultTimeout(45000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);

    console.log('── Willkommensseite ──');
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-page'); await sleep(1600);
    const anzahl = await page.$$eval('[data-planung]', els => els.length);
    ok('die Termine sind als anklickbare Felder gerendert', anzahl === 3, String(anzahl));
    const attr = await page.$eval(`[data-planung="${ids.b2}"]`, el => ({
      role: el.getAttribute('role'), tab: el.getAttribute('tabindex'),
      tag: el.dataset.planungTag, label: el.getAttribute('aria-label') }));
    ok('… mit Tastatur-Bedienbarkeit und richtigem Datum',
      attr.role === 'button' && attr.tab === '0' && attr.tag === tagB, JSON.stringify(attr));

    console.log('\n── Antippen führt in die Tagesansicht ──');
    await page.click(`[data-planung="${ids.b2}"]`);
    await page.waitForFunction(() => location.hash === '#/planning', { timeout: 15000 });
    await sleep(2200);
    const zustand = await page.evaluate((id) => {
      const el = document.querySelector(`.tl-plan-entry[data-planning-id="${id}"]`);
      const aktiv = document.querySelector('.view-toggle button.active, .plan-views button.active');
      const zeitraum = (document.querySelector('.current-period') || {}).textContent || '';
      if (!el) return { da: false, ansicht: aktiv && aktiv.textContent.trim(), zeitraum };
      const r = el.getBoundingClientRect();
      return { da: true, hervor: el.classList.contains('tl-plan-entry--hervor'),
               sichtbar: r.top >= -5 && r.bottom <= window.innerHeight + 5,
               ansicht: aktiv && aktiv.textContent.trim(), zeitraum };
    }, ids.b2);
    ok('Route ist die Planung', (await page.evaluate(() => location.hash)) === '#/planning');
    ok('Tagesansicht ist aktiv', /Tag/i.test(zustand.ansicht || ''), JSON.stringify(zustand));
    ok('der richtige Tag wird angezeigt', zustand.zeitraum.includes(tagB.slice(8, 10) + '.' + tagB.slice(5, 7)),
      `angezeigt „${zustand.zeitraum}", erwartet ${tagB}`);
    ok('der angetippte Termin ist da', zustand.da, JSON.stringify(zustand));
    ok('… und hervorgehoben', zustand.hervor, JSON.stringify(zustand));
    ok('… und im Sichtbereich', zustand.sichtbar, JSON.stringify(zustand));

    console.log('\n── Gegenprobe: der andere Termin desselben Tages ist NICHT hervorgehoben ──');
    const anderer = await page.evaluate((id) => {
      const el = document.querySelector(`.tl-plan-entry[data-planning-id="${id}"]`);
      return el ? el.classList.contains('tl-plan-entry--hervor') : null;
    }, ids.b1);
    ok('nur der angetippte ist markiert', anderer === false, String(anderer));

    console.log('\n── Die Knöpfe im Termin lösen NICHT den Sprung aus ──');
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-page'); await sleep(1600);
    const hatUebernehmen = await page.$(`[data-planung="${ids.b2}"] .accept-welcome-plan`);
    if (hatUebernehmen) {
      await hatUebernehmen.click();
      await sleep(1500);
      const wo = await page.evaluate(() => location.hash);
      ok('„Übernehmen" führt zum Zeiteintrag, nicht in die Planung', /entry|accept/.test(wo), wo);
    } else {
      ok('„Übernehmen" vorhanden', false, 'Knopf nicht gefunden');
    }

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPlanungs-Sprung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
