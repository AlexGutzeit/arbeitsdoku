// Der Tagesverlauf auf dem Handy: Seite scrollt, Raster passt sich dem Tag an (Alex, 26.08.2026)
//
// Alex' Beobachtung am eigenen Gerät: „ich kann nicht mehr weiter nach unten scrollen, und der
// 1/3 Bildschirmplatz für den Zeitverlauf ist knapp." Gemessen bei 393×830: 317 px Verlauf, die
// Seite selbst unbeweglich — man musste IM Kasten wischen, während Kennzahlen und Filter starr
// darüber standen.
//
// Zwei Dinge hängen zusammen und werden hier beide geprüft:
//   * Unterhalb einer sinnvollen Höhe bekommt der Verlauf keine Begrenzung mehr, die SEITE scrollt
//     — dasselbe Verhalten wie im Wochen- und Monatsraster.
//   * Das Raster zeichnet nur noch die Stunden, die der Tag braucht. Ohne das wäre der erste Punkt
//     eine Verschlechterung: 1200 px, davon oben sechs Stunden leer.
//
// Am Rechner muss alles bleiben, wie es war — dort ist genug Platz.
//
//   node tests/handy-verlauf-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3295, DB = '/tmp/handy-verlauf.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/handy-verlauf-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const messen = async (p, datum) => {
  await p.evaluate((d) => { S.view = 'day'; S.currentDate = new Date(d + 'T12:00:00'); render(); }, datum);
  await sleep(2500);
  return p.evaluate(() => {
    const doc = document.documentElement, sc = document.querySelector('.timeline-scroll');
    const st = [...document.querySelectorAll('.tl-hour-label')].map(e => e.textContent);
    const ersterBlock = document.querySelector('.tl-entry');
    return {
      seiteScrolltUm: doc.scrollHeight - window.innerHeight,
      maxHeight: sc ? sc.style.maxHeight : null,
      innenScrollUm: sc ? sc.scrollHeight - sc.clientHeight : null,
      stundeVon: st[0] || null, stundeBis: st[st.length - 1] || null, stunden: st.length,
      ersterBlockTop: ersterBlock ? Math.round(parseFloat(ersterBlock.style.top)) : null,
    };
  });
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const PW = 'Str3ng!Geheim';
    await req('POST', '/api/users', admin, { username: 'monteur', password: PW, name: 'Mark Monteur',
      role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1990-05-05' });
    const ma = (await req('GET', '/api/users', admin)).body.users.find(u => u.username === 'monteur');
    const buch = (datum, von, bis, pause) => req('POST', '/api/entries', admin,
      { user_id: ma.id, date: datum, time_from: von, time_to: bis, break_minutes: pause || 0, description: 'x' });

    await buch('2026-07-08', '07:00', '16:30', 45);     // normaler Tag
    await buch('2026-07-09', '13:00', '14:00', 0);      // EIN kurzer Eintrag am Nachmittag
    await buch('2026-07-10', '06:15', '23:30', 45);     // sehr langer Tag

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    console.log('── Handy (393 × 830): die SEITE scrollt ──');
    const handy = await browser.newPage();
    await handy.setViewport({ width: 393, height: 830, isMobile: true, hasTouch: true });
    handy.setDefaultTimeout(30000);
    await handy.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await handy.waitForSelector('#login-user');
    await handy.type('#login-user', 'monteur'); await handy.type('#login-pass', PW);
    await handy.click('#login-form button[type="submit"]');
    await sleep(2500);
    await handy.evaluate(() => { location.hash = '#/'; }); await sleep(2000);

    let m = await messen(handy, '2026-07-08');
    ok('die Seite lässt sich scrollen', m.seiteScrolltUm > 100, JSON.stringify(m.seiteScrolltUm));
    ok('… weil der Verlauf keine Höhenbegrenzung mehr bekommt', m.maxHeight === 'none', String(m.maxHeight));
    ok('… und deshalb nicht mehr in sich scrollen muss', m.innenScrollUm <= 1, String(m.innenScrollUm));

    console.log('\n── Das Raster zeigt nur die Stunden des Tages ──');
    ok('07:00–16:30 → Raster 06:00 bis 18:00', m.stundeVon === '06:00' && m.stundeBis === '18:00',
      `${m.stundeVon}–${m.stundeBis}`);
    // Der erste Block muss genau eine Stunde unter dem Rasteranfang sitzen (07:00 bei Start 06:00).
    ok('… und der erste Eintrag sitzt an der richtigen Stelle (50 px = eine Stunde)',
      m.ersterBlockTop === 50, String(m.ersterBlockTop));

    m = await messen(handy, '2026-07-10');
    ok('langer Tag 06:15–23:30 → Raster 05:00 bis 24:00', m.stundeVon === '05:00' && m.stundeBis === '24:00',
      `${m.stundeVon}–${m.stundeBis}`);

    m = await messen(handy, '2026-07-09');
    ok('ein einzelner Termin 13:00–14:00 ergibt trotzdem mindestens acht Stunden Raster',
      m.stunden >= 9, `${m.stundeVon}–${m.stundeBis} (${m.stunden} Marken)`);
    ok('… und er ist im Raster enthalten',
      Number(m.stundeVon.slice(0, 2)) <= 13 && Number(m.stundeBis.slice(0, 2)) >= 14, `${m.stundeVon}–${m.stundeBis}`);

    console.log('\n── Am Rechner bleibt alles wie bisher ──');
    // Eigener Kontext: Sonst liegt die Anmeldung des Handys im selben localStorage und die Seite
    // landet gar nicht erst auf dem Anmeldebildschirm.
    const rKtx = await browser.createBrowserContext();
    const rechner = await rKtx.newPage();
    await rechner.setViewport({ width: 1400, height: 1000 });
    rechner.setDefaultTimeout(30000);
    await rechner.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await rechner.waitForSelector('#login-user');
    await rechner.type('#login-user', 'monteur'); await rechner.type('#login-pass', PW);
    await rechner.click('#login-form button[type="submit"]');
    await sleep(2500);
    await rechner.evaluate(() => { location.hash = '#/'; }); await sleep(2000);
    const r = await messen(rechner, '2026-07-10');
    ok('dort behält der Verlauf seine eigene Scrollfläche', r.maxHeight !== 'none' && /px$/.test(r.maxHeight || ''), String(r.maxHeight));
    ok('… und die Seite selbst bleibt stehen', r.seiteScrolltUm === 0, String(r.seiteScrolltUm));

    console.log('\n── Woche und Monat sind unberührt ──');
    for (const [v, name] of [['week', 'Woche'], ['month', 'Monat']]) {
      await handy.evaluate((vv) => { S.view = vv; render(); }, v);
      await sleep(2200);
      const g = await handy.evaluate(() => {
        const doc = document.documentElement, sc = document.querySelector('.grid-scroll');
        return { seite: doc.scrollHeight - window.innerHeight, innen: sc ? sc.scrollHeight - sc.clientHeight : null };
      });
      ok(`${name}: die Seite scrollt wie bisher`, g.seite > 0, JSON.stringify(g));
    }
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
  }
  console.log(`\nTagesverlauf auf dem Handy: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
