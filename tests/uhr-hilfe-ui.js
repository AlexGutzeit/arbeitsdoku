// Zeit- und Datumsfeld am Handy: Antippen öffnet wieder Uhr bzw. Kalender — nur dort, wo es fehlt (R25, 25./26.09.2026).
//
// Chrome auf Android (bemerkt mit Version 154) öffnet beim Antippen eines Uhrzeit-Felds nicht mehr die
// Uhr, sondern markiert Stunde oder Minute; die Uhr gibt es nur noch über das Symbol rechts. Die App
// ruft sie jetzt beim Antippen selbst auf (showPicker) — bewusst NUR auf Android mit Chrome-artigem
// Browser und NUR bei Berührung. Dass showPicker() dort die Uhr wirklich öffnet, hat Alex auf seinem
// Handy mit einer Testseite geprüft; das kann ein Test-Chrome nicht zeigen. Dieser Test prüft
// deshalb, WANN die App die Uhr aufruft — und vor allem, wann nicht.
//
//   node tests/uhr-hilfe-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3333, DB = '/tmp/uhr-hilfe.db', LOG = '/tmp/uhr-hilfe.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const KENNUNG = {
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  rechner: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // Eine Seite mit gewählter Browser-Kennung. showPicker wird durch einen Zähler ersetzt: Der
    // Test-Chrome kann keine echte Uhr zeigen, aber er sieht, ob die App sie aufruft.
    const seite = async (kennung, beruehrung) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      await p.setUserAgent(kennung);
      await p.setViewport(beruehrung ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1200, height: 900 });
      await p.evaluateOnNewDocument(() => {
        window.__uhr = [];
        HTMLInputElement.prototype.showPicker = function () { window.__uhr.push(this.id || this.className); };
      });
      p.setDefaultTimeout(30000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
      return p;
    };
    const mitte = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 3, y: r.y + r.height / 2 }; }, sel);
    const tippe = async (p, sel) => { const m = await mitte(p, sel); await p.touchscreen.tap(m.x, m.y); await sleep(250); };
    const aufrufe = p => p.evaluate(() => window.__uhr.slice());
    const eintragsformular = async (p) => { await p.evaluate(() => { location.hash = '/entry/new'; }); await p.waitForSelector('#ef-from'); await sleep(800); };

    console.log('\nAndroid mit Chrome (Alex\' Handy)');
    const a = await seite(KENNUNG.android, true);
    await eintragsformular(a);
    await tippe(a, '#ef-from');
    ok('Antippen von „Von" ruft die Uhr auf', JSON.stringify(await aufrufe(a)) === '["ef-from"]', JSON.stringify(await aufrufe(a)));
    await tippe(a, '#ef-to');
    ok('Antippen von „Bis" ebenso', (await aufrufe(a)).includes('ef-to'), JSON.stringify(await aufrufe(a)));
    const vorher = (await aufrufe(a)).length;
    await tippe(a, '#ef-break');
    ok('ein anderes Feld (Pause) ruft keine Uhr auf', (await aufrufe(a)).length === vorher, JSON.stringify(await aufrufe(a)));
    // Datum: dieselbe Umstellung, dort öffnet sich der Kalender (Alex, 26.09.)
    await tippe(a, '#ef-date');
    ok('Antippen des Datums ruft den Kalender auf', (await aufrufe(a)).includes('ef-date'), JSON.stringify(await aufrufe(a)));
    await a.evaluate(() => { location.hash = '/pdf'; }); await a.waitForSelector('#lohn-monat'); await sleep(800);
    await tippe(a, '#lohn-monat');
    ok('… und das Monatsfeld (Lohn-Export) ebenso', (await aufrufe(a)).includes('lohn-monat'), JSON.stringify(await aufrufe(a)));
    await a.evaluate(() => { location.hash = '/planning/new'; }); await a.waitForSelector('#pf-single-from'); await sleep(800);
    await tippe(a, '#pf-single-from');
    ok('gilt für alle Zeitfelder — auch in der Planung', (await aufrufe(a)).includes('pf-single-from'), JSON.stringify(await aufrufe(a)));

    console.log('\nSamsung Internet');
    const s = await seite(KENNUNG.samsung, true);
    await eintragsformular(s); await tippe(s, '#ef-from');
    ok('Samsung Internet (Chrome-artig): Uhr wird aufgerufen', (await aufrufe(s)).includes('ef-from'), JSON.stringify(await aufrufe(s)));

    console.log('\nWo sich nichts ändern darf');
    const i = await seite(KENNUNG.iphone, true);
    await eintragsformular(i); await tippe(i, '#ef-from'); await tippe(i, '#ef-date');
    ok('iPhone: kein Aufruf (Uhr und Datum) — der Browser öffnet sie dort selbst', (await aufrufe(i)).length === 0, JSON.stringify(await aufrufe(i)));
    const f = await seite(KENNUNG.firefox, true);
    await eintragsformular(f); await tippe(f, '#ef-from');
    ok('Firefox auf Android: kein Aufruf', (await aufrufe(f)).length === 0, JSON.stringify(await aufrufe(f)));
    const r = await seite(KENNUNG.rechner, false);
    await eintragsformular(r);
    const m = await mitte(r, '#ef-from'); await r.mouse.click(m.x, m.y); await sleep(250);
    const md = await mitte(r, '#ef-date'); await r.mouse.click(md.x, md.y); await sleep(250);
    ok('Rechner mit Maus: kein Aufruf — dort tippt man ein', (await aufrufe(r)).length === 0, JSON.stringify(await aufrufe(r)));
    // Auch auf Android: ein Mausklick (Tablet mit Maus) ist keine Berührung
    await sleep(900);
    const vorMaus = (await aufrufe(a)).length;
    await a.evaluate(() => { location.hash = '/entry/new'; }); await a.waitForSelector('#ef-from'); await sleep(1000);
    const am = await mitte(a, '#ef-from'); await a.mouse.click(am.x, am.y); await sleep(250);
    ok('Android mit Maus statt Finger: kein Aufruf', (await aufrufe(a)).length === vorMaus, JSON.stringify(await aufrufe(a)));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nUhr-Hilfe: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
