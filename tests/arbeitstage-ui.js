// Gearbeitete Tage in der Statistik — Oberfläche (Alex, 30.09.2026).
//
// In der echten App: Karte „Arbeitstage" in der Übersicht, darunter „Gearbeitete Tage" mit Hinweis (Beginn bis Ende,
// genau 8:00 = bis 8) und je Mitarbeiter einer aufklappbaren Zeile „N Arbeitstage · mehr als 8 Std.: X · bis 8 Std.: Y";
// aufgeklappt die Tage mit Wochentag, Beginn–Ende, Anwesend, Gearbeitet, Spesen. Chef sieht alle, die Mitarbeiterin
// nur sich. Auf dem Handy (390 px) bleibt die Tabelle im Kasten und lässt sich mit dem Finger seitlich wischen.
//
//   node tests/arbeitstage-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3363, DB = '/tmp/arbeitstage-ui.db', LOG = '/tmp/arbeitstage-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const HEUTE = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
// Tage im laufenden Monat, die sicher vor heute liegen — sonst die ersten Tage des Vormonats
const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const id = {};
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'], ['moritz', 'Moritz Muster', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r })).body.user.id;
      await req('POST', `/api/statistics/targets/${id[u]}`, admin, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: plus(HEUTE, -40) });
    }
    // Drei Tage in der letzten Woche: Anna 2 Tage (einer über 8), Moritz 1 Tag
    const d1 = plus(HEUTE, -3), d2 = plus(HEUTE, -2), d3 = plus(HEUTE, -1);
    for (const [u, d, v, b, p] of [['anna', d1, '07:00', '16:30', 30], ['anna', d2, '07:00', '12:00', 0], ['moritz', d3, '06:00', '15:00', 60]]) {
      await req('POST', '/api/entries', admin, { date: d, time_from: v, time_to: b, break_minutes: p, user_id: id[u] });
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u, handy) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport(handy ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 900 });
      p.setDefaultTimeout(15000);
      await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
      await p.evaluate(() => { location.hash = '/statistics'; });
      await p.waitForSelector('.stats-arbeitstage'); await sleep(600);
      // „Gesamt" — dann liegen alle drei Tage sicher im Zeitraum, egal wann im Monat der Test läuft
      await p.evaluate(() => { const b = document.querySelector('[data-period="total"]'); if (b) b.click(); });
      await p.waitForFunction(() => document.querySelector('.stats-arbeitstage')); await sleep(900);
      return p;
    };

    console.log('Chef');
    const C = await seite('carla');
    const karte = await C.evaluate(() => { const k = document.getElementById('stats-arbeitstage-karte'); return k && k.textContent.replace(/\s+/g, ' ').trim(); });
    ok('Karte „Arbeitstage" in der Übersicht: 3', karte === '3 Arbeitstage', karte);
    ok('Hinweis: Beginn bis Ende, genau 8:00 = bis 8', await C.evaluate(() => { const t = document.querySelector('.stats-arbeitstage').textContent.replace(/\s+/g, ' ');
      return /ersten Beginn bis zum letzten Ende/.test(t) && /genau 8:00 Std\. zählt zu „bis 8 Std\.“/.test(t); }));
    const zeilen = await C.evaluate(() => [...document.querySelectorAll('.stats-tage > summary')].map(s => s.textContent.replace(/\s+/g, ' ').trim()));
    ok('je Mitarbeiter eine Zeile mit Namen und Aufteilung', zeilen.some(z => /^Anna Berger · 2 Arbeitstage · mehr als 8 Std\.: 1 · bis 8 Std\.: 1$/.test(z))
      && zeilen.some(z => /^Moritz Muster · 1 Arbeitstag · mehr als 8 Std\.: 1 · bis 8 Std\.: 0$/.test(z)), JSON.stringify(zeilen));
    ok('zugeklappt, bis man sie öffnet', await C.evaluate(() => [...document.querySelectorAll('.stats-tage')].every(d => !d.open)));
    await C.evaluate(() => [...document.querySelectorAll('.stats-tage > summary')].find(s => /Anna/.test(s.textContent)).click()); await sleep(300);
    const tage = await C.evaluate(() => { const d = [...document.querySelectorAll('.stats-tage')].find(x => x.open);
      return d ? [...d.querySelectorAll('tr')].slice(1).map(r => [...r.children].map(c => c.textContent.trim())) : null; });
    const wt = (iso) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(iso + 'T12:00:00Z').getUTCDay()];
    const de = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
    ok('aufgeklappt: Tag, Beginn – Ende, Anwesend, Gearbeitet, Spesen', tage && tage.length === 2
      && tage[0].join('|') === `${wt(d1)} ${de(d1)}|07:00 – 16:30|9:30|9:00|mehr als 8 Std.`
      && tage[1].join('|') === `${wt(d2)} ${de(d2)}|07:00 – 12:00|5:00|5:00|bis 8 Std.`, JSON.stringify(tage));

    // Alex, 30.09.2026: Auf dem Handy war die Spalte „Spesen" abgeschnitten, seitlich wischen ging nicht. Die
    // Tabelle stand in einer .table-scroll ohne CSS-Regel und ragte über den Kasten hinaus; .main schnitt sie ab.
    console.log('Handy (390 px, Finger)');
    const H = await seite('carla', true);
    await H.evaluate(() => { const s = [...document.querySelectorAll('.stats-tage > summary')].find(x => /Anna/.test(x.textContent));
      s.click(); s.parentElement.scrollIntoView({ block: 'center' }); }); await sleep(400);
    const mass = () => H.evaluate(() => { const d = [...document.querySelectorAll('.stats-tage')].find(x => x.open);
      const b = d.querySelector('.table-scroll'), t = b.querySelector('table'), r = b.getBoundingClientRect();
      return { kasten: Math.round(d.getBoundingClientRect().right), box: Math.round(r.right), tabelle: Math.round(t.getBoundingClientRect().right),
        breit: b.scrollWidth, sicht: b.clientWidth, links: b.scrollLeft, x: Math.round(r.left + r.width * 0.7), y: Math.round(r.top + r.height / 2),
        seite: document.documentElement.scrollWidth,
        // Was liegt gleich RECHTS NEBEN dem Kasten, auf Höhe der ersten Zeile? Ragt die Tabelle hinaus, ist es eine Zelle.
        daneben: !!(document.elementFromPoint(d.getBoundingClientRect().right + 5, t.rows[1].getBoundingClientRect().top + 5) || { closest: () => null }).closest('.stats-tage-tabelle') }; });
    const m1 = await mass();
    ok('Tabelle bleibt im Kasten, der Rest liegt zum Wischen bereit', !m1.daneben && m1.tabelle > m1.kasten && m1.breit > m1.sicht, JSON.stringify(m1));
    ok('die Seite selbst scrollt nicht seitwärts', m1.seite <= 390, 'Seitenbreite ' + m1.seite);
    // Echte Fingerbewegung (aufsetzen, ziehen, loslassen). Input.synthesizeScrollGesture mit 'touch' scrollt in
    // chrome-headless-shell gar nichts — auch auf einer nackten Probeseite nicht; wäre also immer rot.
    await H.touchscreen.touchStart(m1.x, m1.y);
    for (let i = 1; i <= 10; i++) await H.touchscreen.touchMove(m1.x - i * 20, m1.y);
    await H.touchscreen.touchEnd(); await sleep(600);
    const m2 = await mass();
    ok('mit dem Finger nach links wischen zeigt die Spalte „Spesen"', m2.links > 0
      && await H.evaluate(() => { const d = [...document.querySelectorAll('.stats-tage')].find(x => x.open);
        const b = d.querySelector('.table-scroll').getBoundingClientRect(), th = [...d.querySelectorAll('th')].pop().getBoundingClientRect();
        return th.right <= b.right + 1 && th.left >= b.left - 1; }), JSON.stringify(m2));

    console.log('Mitarbeiterin');
    const A = await seite('anna');
    const eigene = await A.evaluate(() => [...document.querySelectorAll('.stats-tage > summary')].map(s => s.textContent.replace(/\s+/g, ' ').trim()));
    ok('sieht nur sich (ohne Namen davor)', eigene.length === 1 && /^2 Arbeitstage · mehr als 8 Std\.: 1 · bis 8 Std\.: 1$/.test(eigene[0]), JSON.stringify(eigene));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nGearbeitete Tage (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
