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
    await buch('2026-07-13', '04:00', '09:00', 0);      // Ausnahme: Beginn um 4 Uhr
    await buch('2026-07-07', '04:30', '04:30', 0);      // ohne Dauer, frueh — die API laesst das zu
    await buch('2026-07-14', '09:00', '12:00', 0);      // spaeter Beginn — Raster bleibt beim Firmenwert
    // Eine Planung fuer denselben Tag, damit die Planungs-Zeitleiste etwas zu zeigen hat.
    const plan = await req('POST', '/api/planning', admin,
      { date: '2026-07-14', time_from: '08:00', time_to: '15:00', assigned_user_ids: [ma.id], client: 'Planprobe' });
    ok('Planung angelegt', plan.status === 201 || plan.status === 200, plan.status + ' ' + plan.text.slice(0, 90));

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

    console.log('\n── Der Anker ist die Firmenvorgabe (07:00 / 8 Std / 30 min) ──');
    // Alex' Regel: „standard nach den Firmen-Beginn-Einstellungen minus eine Stunde, aber wenn
    // jemand eher beginnt, entsprechend eher anfangen — bzw. abends laenger laufen lassen."
    m = await messen(handy, '2026-07-14');
    ok('Beginn erst 09:00 → das Raster startet trotzdem bei 06:00 (Firmenbeginn − 1)',
      m.stundeVon === '06:00', `${m.stundeVon}–${m.stundeBis}`);
    ok('… und reicht bis 17:00 (regulärer Feierabend 15:30 + 1)', m.stundeBis === '17:00', m.stundeBis);

    m = await messen(handy, '2026-07-13');
    ok('Beginn um 04:00 → das Raster zieht auf 03:00 vor', m.stundeVon === '03:00', `${m.stundeVon}–${m.stundeBis}`);
    ok('… und der frühe Eintrag ist vollständig sichtbar', m.ersterBlockTop === 50, String(m.ersterBlockTop));

    m = await messen(handy, '2026-07-10');
    ok('Feierabend 23:30 → das Raster läuft bis 24:00', m.stundeBis === '24:00', m.stundeBis);

    // Ein Eintrag OHNE DAUER wird gezeichnet, traegt aber keine Spanne bei. Zaehlte er beim
    // Aufziehen nicht mit, saesse er bei 04:30 ueber einem Raster ab 06:00 — top negativ, also
    // unsichtbar. Er muss die Untergrenze mitziehen, ohne die Obergrenze zu beruehren.
    m = await messen(handy, '2026-07-07');
    ok('Eintrag ohne Dauer um 04:30 → das Raster zieht auf 03:00 vor',
      m.stundeVon === '03:00', `${m.stundeVon}–${m.stundeBis}`);
    // 04:30 ist anderthalb Stunden nach dem Rasteranfang 03:00 → 75 px. Ohne die Regel waere
    // es -75, der Block laege oberhalb des Rasters.
    ok('… und er sitzt sichtbar im Raster statt darüber (75 px)', m.ersterBlockTop === 75,
      String(m.ersterBlockTop));
    ok('… und die Obergrenze bleibt beim Firmenwert', m.stundeBis === '17:00', m.stundeBis);

    m = await messen(handy, '2026-07-09');
    ok('ein einzelner Termin 13:00–14:00 bleibt im Firmen-Raster',
      m.stundeVon === '06:00' && m.stundeBis === '17:00', `${m.stundeVon}–${m.stundeBis}`);
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

    console.log('\n── Die Planung folgt derselben Regel ──');
    // Alex, 27.08.2026: „bevor du deployst, pass die planung auch darauf an."
    // Sie darf NUR zusammen mit dem Zuschnitt freigegeben werden — sonst zeichnet sie 00:00–24:00
    // ohne Begrenzung und man landet morgens um Mitternacht.
    await handy.evaluate((d) => {
      S.planningView = 'day'; S.planningDate = new Date(d + 'T12:00:00'); location.hash = '#/planning';
    }, '2026-07-14');
    await sleep(3500);
    const pl = await handy.evaluate(() => {
      const doc = document.documentElement, sc = document.querySelector('.timeline-scroll');
      const st = [...document.querySelectorAll('.tl-hour-label')].map(e => e.textContent);
      return { seiteScrollt: doc.scrollHeight - window.innerHeight, maxHeight: sc ? sc.style.maxHeight : null,
               von: st[0] || null, bis: st[st.length - 1] || null, marken: st.length,
               oben: sc ? sc.scrollTop : null, innen: sc ? sc.scrollHeight - sc.clientHeight : null };
    });
    if (pl.von) {
      ok('Planung: Raster beginnt am Firmenwert (06:00), nicht bei Mitternacht', pl.von === '06:00', `${pl.von}–${pl.bis}`);
      ok('… und endet bei 17:00', pl.bis === '17:00', String(pl.bis));
      // Der Zuschnitt macht das Raster so kurz, dass es hier komplett ins Fenster passt — es gibt
      // gar nichts mehr zu scrollen. Das ist das beste Ergebnis; die Zusicherung darf es nicht
      // gegen „die Seite muss scrollen" ausspielen. Was NICHT sein darf, ist das alte Verhalten:
      // ein enger Kasten, in dem man wischen muss, waehrend die Seite starr steht.
      // Toleranz statt 0: Rahmen und Innenabstaende lassen ein paar Pixel Rest — gemessen 5 px.
      // Das ist kein Scrollen, das ist Rundung. Alles unter 30 px ist keine Flaeche zum Wischen.
      ok('… und niemand muss mehr in einem engen Kasten wischen',
        pl.innen <= 30 || pl.maxHeight === 'none', JSON.stringify(pl));
      ok('… und man startet ganz oben, nicht mitten im Raster', pl.oben === 0, String(pl.oben));
    } else {
      ok('Planung: die Zeitleiste ist überhaupt aufgebaut', false, 'kein Raster gefunden: ' + JSON.stringify(pl));
    }

    console.log('\n── Woche und Monat sind unberührt ──');
    await handy.evaluate(() => { location.hash = '#/'; }); await sleep(2000);
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
