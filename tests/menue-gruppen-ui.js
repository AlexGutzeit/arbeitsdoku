// Aufklappbare Menü-Gruppen (Papierkorb, Kollegen): auf UND wieder zu — mit Maus, Finger und Tastatur.
//
// Alex, 05.10.2026: „Das Papierkorb-Menü kann man aufklappen, aber nicht mehr zuklappen." Ursache: Die
// Gruppe klappte zusätzlich bei :hover auf. Am Rechner steht der Mauszeiger nach dem Klick noch über der
// Gruppe, am Handy „klebt" :hover nach dem Antippen — das Tippen nahm .open weg, :hover hielt sie offen.
// Der alte Test (trash-nav-ui.js) prüfte nur, DASS die Gruppe da ist.
//
// Wichtig für die Messung: Die Maus bleibt nach dem Klick dort stehen, wo sie geklickt hat — genau das
// ist die Lage, in der der Fehler auftrat. Die Touch-Simulation des Testbrowsers bildet das Kleben von
// :hover NICHT nach; deshalb ist der Maus-Fall hier der scharfe.
//
//   node tests/menue-gruppen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3369, DB = '/tmp/menue-gruppen-ui.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/menue-gruppen-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/menue-gruppen-ui-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const neueSeite = async (vp) => {
      const p = await browser.newPage(); await p.setViewport(vp); p.setDefaultTimeout(30000);
      p.on('pageerror', e => fehler.push(String(e)));
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => localStorage.clear());
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', 'admin'); await p.type('#login-pass', pw('admin'));
      await p.click('#login-form button[type="submit"]'); await sleep(2200);
      await p.click('#menu-btn'); await sleep(700);
      return p;
    };
    const zustand = (p, gruppe) => p.evaluate(g => {
      const el = document.getElementById(g); const sub = el && el.querySelector('.nav-subitem');
      const label = el && el.querySelector('.nav-group-label');
      return { offen: !!el && el.classList.contains('open'), sichtbar: !!sub && getComputedStyle(sub).display !== 'none',
               aria: label && label.getAttribute('aria-expanded') };
    }, gruppe);
    const punkt = (p, gruppe) => p.evaluate(g => {
      const e = document.querySelector('#' + g + ' .nav-group-label'); e.scrollIntoView({ block: 'center' });
      const b = e.getBoundingClientRect(); return { x: b.x + 40, y: b.y + b.height / 2 };
    }, gruppe);

    for (const gruppe of ['nav-papierkorb']) {
      console.log(`── ${gruppe}: Rechner (die Maus bleibt nach dem Klick darüber stehen) ──`);
      let p = await neueSeite({ width: 1280, height: 900 });
      let z = await zustand(p, gruppe);
      ok('anfangs zu', !z.offen && !z.sichtbar && z.aria === 'false', JSON.stringify(z));
      let pt = await punkt(p, gruppe);
      await p.mouse.move(pt.x, pt.y); await sleep(400);
      z = await zustand(p, gruppe);
      ok('Drüberfahren allein klappt NICHT auf', !z.sichtbar, JSON.stringify(z));
      await p.mouse.click(pt.x, pt.y); await sleep(400);
      z = await zustand(p, gruppe);
      ok('Klick klappt auf', z.offen && z.sichtbar && z.aria === 'true', JSON.stringify(z));
      await p.mouse.click(pt.x, pt.y); await sleep(400);
      z = await zustand(p, gruppe);
      ok('zweiter Klick klappt wieder zu — obwohl die Maus noch darüber steht', !z.offen && !z.sichtbar && z.aria === 'false', JSON.stringify(z));

      console.log('── … Tastatur ──');
      await p.focus('#' + gruppe + ' .nav-group-label');
      await p.keyboard.press('Enter'); await sleep(300);
      z = await zustand(p, gruppe);
      ok('Enter klappt auf', z.offen && z.sichtbar, JSON.stringify(z));
      await p.keyboard.press('Space'); await sleep(300);
      z = await zustand(p, gruppe);
      ok('Leertaste klappt zu', !z.offen && !z.sichtbar, JSON.stringify(z));
      await p.close();

      console.log('── … Handy ──');
      p = await neueSeite({ width: 400, height: 850, isMobile: true, hasTouch: true });
      pt = await punkt(p, gruppe);
      await p.touchscreen.tap(pt.x, pt.y); await sleep(400);
      z = await zustand(p, gruppe);
      ok('Antippen klappt auf', z.offen && z.sichtbar, JSON.stringify(z));
      await p.touchscreen.tap(pt.x, pt.y); await sleep(400);
      z = await zustand(p, gruppe);
      ok('nochmal Antippen klappt zu', !z.offen && !z.sichtbar, JSON.stringify(z));
      await p.close();
    }

    console.log('── Auf einer Unterseite ist die Gruppe offen — und trotzdem zuklappbar ──');
    const p = await neueSeite({ width: 1280, height: 900 });
    await p.goto(BASIS + '/#/deleted-entries', { waitUntil: 'domcontentloaded' }); await sleep(2000);
    await p.click('#menu-btn'); await sleep(700);
    let z = await zustand(p, 'nav-papierkorb');
    ok('im Papierkorb: Gruppe offen', z.offen && z.sichtbar && z.aria === 'true', JSON.stringify(z));
    const pt = await punkt(p, 'nav-papierkorb');
    await p.mouse.click(pt.x, pt.y); await sleep(400);
    z = await zustand(p, 'nav-papierkorb');
    ok('… und lässt sich zuklappen', !z.offen && !z.sichtbar, JSON.stringify(z));

    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
  }
  console.log(`\nMenü-Gruppen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
