// Scrollflächen nutzen den Platz, der wirklich da ist (Alex, 07.08.2026).
//
// Im CSS standen feste Schätzungen: Zeitleiste `100vh - 260px`, Board `100vh - 160px`. Über der
// Fläche steht aber je Seite verschieden viel — in der Planung blieb dadurch auf JEDEM Handy ein
// grauer Streifen von 94 px ungenutzt, auf dem Zeitnachweis wurde die Seite unnötig lang.
// Seitdem misst `passeScrollflaechenAn()` in app-1-core.js den freien Platz.
//
// Geprüft wird deshalb nicht „sieht besser aus", sondern nachrechenbar:
//   * unter der Zeitleiste bleibt fast nichts mehr ungenutzt — auf drei Bildschirmgrößen
//   * die Fläche wächst mit dem Bildschirm mit (feste Zahl im CSS täte das nicht in dieser Form)
//   * was UNTER der Karte steht, bleibt sichtbar (sonst schöbe die Fläche es aus dem Bild)
//   * die Kennzahl-Karten stehen auf dem Handy nebeneinander statt untereinander
//   * beim Drehen des Geräts wird die Höhe nachgezogen
//   * die Fläche unterschreitet nie das brauchbare Mindestmaß
//
//   node tests/platznutzung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3241, DB = '/tmp/platznutzung.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Vom kleinen Handy bis zum grossen Monitor. Die Prüfung muss auf ALLEN gelten — eine feste
// Pixelzahl im CSS kann das nicht leisten, genau darum geht es hier. (Alex: „achte darauf, dass es
// auf jeder Monitor-Größe passen muss.")
const GERAETE = [
  { name: 'Handy klein   360x640', w: 360, h: 640 },
  { name: 'Handy mittel  411x795', w: 411, h: 795 },
  { name: 'Handy gross   430x932', w: 430, h: 932 },
  { name: 'Tablet hoch   768x1024', w: 768, h: 1024 },
  { name: 'Tablet quer  1024x768', w: 1024, h: 768 },
  { name: 'Notebook     1366x768', w: 1366, h: 768 },
  { name: 'Monitor      1920x1080', w: 1920, h: 1080 },
  { name: 'Monitor gross 2560x1440', w: 2560, h: 1440 },
  { name: 'flaches Fenster 1280x500', w: 1280, h: 500 },
];
const ERLAUBTER_REST = 40;   // Luft (10) + Innenabstand der Hauptfläche (8) + etwas Spielraum
// Das Mindestmass aus app-1-core.js (`_FLAECHE_MIN`). Bleibt weniger uebrig, bekommt die Flaeche
// GAR KEINE Begrenzung mehr und die Seite scrollt als Ganzes — Alex am 27.08.2026 zum Handy:
// „der 1/3 bildschirmplatz fuer den Zeitverlauf ist knapp ... da scrollt die ganze Seite, oder?
// So haette ich es auch gern." Vorher stand hier 270, das war die alte Untergrenze.
const MINDESTFLAECHE = 440;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/platznutzung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/platznutzung-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const antwort = (await req('GET', '/api/users', admin.token)).body;
    const nutzer = Array.isArray(antwort) ? antwort : (antwort.users || []);
    const heute = new Date().toLocaleDateString('sv-SE');
    for (const u of nutzer.slice(0, 3)) {
      await req('POST', '/api/planning', admin.token, { date: heute, time_from: '07:00', time_to: '15:30',
        description: 'Baustelle ' + u.name, assigned_user_ids: [u.id] });
      await req('POST', '/api/entries', admin.token, { user_id: u.id, date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'Arbeit' });
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);
    await page.setViewport({ width: 411, height: 795 });
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', pw('admin'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(600);

    const messen = async () => page.evaluate(() => {
      const box = document.querySelector('.timeline-scroll');
      const karte = box.closest('.timeline-wrapper');
      const main = document.querySelector('.main');
      return {
        fenster: window.innerHeight,
        hoehe: Math.round(box.getBoundingClientRect().height),
        oben: Math.round(box.getBoundingClientRect().top),
        inhalt: Math.round(box.scrollHeight),
        scrollt: box.scrollHeight > box.clientHeight + 2,
        restUnten: Math.round(window.innerHeight - karte.getBoundingClientRect().bottom),
        seitenScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        mainUnten: Math.round(main.getBoundingClientRect().bottom),
      };
    });

    console.log('── Planung: kein grauer Streifen mehr unter der Zeitleiste ──');
    console.log('   (vom kleinen Handy bis zum grossen Monitor)');
    const werte = [];
    for (const g of GERAETE) {
      await page.setViewport({ width: g.w, height: g.h });
      await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.timeline-scroll'); await sleep(1400);
      const m = await messen();
      werte.push({ g, m });
      // Ungenutzter Platz ist nur dann ein Fehler, wenn es ueberhaupt noch etwas zu zeigen gaebe.
      // Auf einem grossen Monitor ist der Tag irgendwann komplett im Bild — dann ist der Rest
      // darunter keine Verschwendung, sondern schlicht nichts mehr da.
      if (m.scrollt) {
        ok(`${g.name}: höchstens ${ERLAUBTER_REST} px ungenutzt`, m.restUnten <= ERLAUBTER_REST, `${m.restUnten} px ungenutzt, obwohl noch ${m.inhalt - m.hoehe} px Inhalt folgen`);
      } else {
        ok(`${g.name}: der ganze Tag ist im Bild (kein Scrollen nötig)`, true, `Fläche ${m.hoehe} px, Inhalt ${m.inhalt} px`);
      }
      // Die Seite selbst soll nicht scrollen — ausser der Bildschirm ist flacher als das Mindestmass.
      const passtUeberhaupt = m.fenster - m.oben >= MINDESTFLAECHE;
      if (passtUeberhaupt) ok(`${g.name}: die Seite selbst muss nicht gescrollt werden`, m.seitenScroll <= 2, `${m.seitenScroll} px`);
      // Zu flach: die Flaeche wird freigegeben, die Seite scrollt. Das ist kein Freifahrtschein —
      // gepruft wird, dass dabei WIRKLICH alles erreichbar ist statt abgeschnitten zu werden.
      else ok(`${g.name}: zu flach für das Mindestmaß → Seite scrollt, nichts wird abgeschnitten`,
        !m.scrollt, `Seitenscroll ${m.seitenScroll} px, Kasten ${m.hoehe} px, Inhalt ${m.inhalt} px`);
    }
    // Solange der Inhalt nicht hineinpasst, muss mehr Bildschirmhöhe auch mehr Fläche bedeuten.
    const wachsend = werte.filter(x => x.m.scrollt).map(x => x.m);
    const monoton = wachsend.every((m, i) => i === 0 || m.hoehe >= wachsend[i - 1].hoehe - 2 || m.fenster < wachsend[i - 1].fenster);
    ok('die Fläche wächst mit dem Bildschirm mit', monoton, wachsend.map(m => `${m.fenster}→${m.hoehe}`).join(', '));
    const m360 = werte.find(x => x.g.w === 360).m, m430 = werte.find(x => x.g.w === 430).m;
    // Frueher zeichnete das Raster immer 00:00-24:00 (1200 px) und war damit auf JEDEM Geraet
    // hoeher als der Bildschirm — mehr Hoehe hiess deshalb immer exakt so viel mehr Flaeche.
    // Seit dem Zuschnitt auf die gebrauchten Stunden (27.08.2026) endet das Wachsen beim Inhalt:
    // Ist der ganze Tag im Bild, waere jedes weitere Pixel der graue Streifen, den der Abschnitt
    // darueber gerade verbietet. Geprueft wird also beides — waechst mit, aber nie ueber den
    // Inhalt hinaus.
    const gewachsen = m430.hoehe - m360.hoehe;
    const amInhalt = m430.hoehe >= m430.inhalt - 2;
    ok('… und zwar um den Höhenunterschied der Geräte, bis der Inhalt ganz im Bild ist',
      amInhalt ? gewachsen > 0 : Math.abs(gewachsen - (932 - 640)) < 20,
      `${gewachsen} px gewachsen; 430er: Fläche ${m430.hoehe}, Inhalt ${m430.inhalt}`);

    console.log('\n── Was unter der Karte steht, bleibt sichtbar ──');
    // Wochenansicht: darunter liegt das Raster mit eigener Legende. Nichts darf aus dem Bild rutschen.
    await page.setViewport({ width: 411, height: 795 });
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.timeline-scroll'); await sleep(1200);
    const untenDrunter = await page.evaluate(() => {
      const main = document.querySelector('.main');
      const karte = document.querySelector('.timeline-wrapper');
      const kinder = [...main.children].filter(e => e.getBoundingClientRect().height > 0);
      const nachDerKarte = kinder.slice(kinder.indexOf(karte) + 1);
      return { anzahl: nachDerKarte.length,
               abgeschnitten: nachDerKarte.filter(e => e.getBoundingClientRect().bottom > window.innerHeight + 2).length };
    });
    ok('nichts unterhalb der Karte wird aus dem Bild geschoben', untenDrunter.abgeschnitten === 0, JSON.stringify(untenDrunter));

    console.log('\n── Zeitnachweis: Kennzahlen nebeneinander ──');
    await page.goto(BASIS + '/#/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.summary-card'); await sleep(1500);
    const karten = await page.evaluate(() => {
      const k = [...document.querySelectorAll('.summary-card')].map(e => { const r = e.getBoundingClientRect(); return { oben: Math.round(r.top), hoehe: Math.round(r.height) }; });
      const zeilen = new Set(k.map(x => x.oben));
      const grid = document.querySelector('.summary-grid').getBoundingClientRect();
      return { anzahl: k.length, zeilen: zeilen.size, gridHoehe: Math.round(grid.height) };
    });
    ok('die Kennzahl-Karten stehen in EINER Zeile', karten.anzahl >= 3 && karten.zeilen === 1, JSON.stringify(karten));
    ok('… und brauchen dafür unter 110 px statt gut 200', karten.gridHoehe < 110, `${karten.gridHoehe} px`);

    console.log('\n── Beim Drehen wird die Höhe nachgezogen ──');
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.timeline-scroll'); await sleep(1200);
    const hochkant = (await messen()).hoehe;
    await page.setViewport({ width: 795, height: 411 });   // quer
    await sleep(900);
    const quer = await messen();
    // Was hier zaehlt, ist dass beim Drehen NEU GERECHNET wird — eine eingefrorene Hoehe aus dem
    // Hochformat wuerde den Inhalt im Querformat abschneiden. Seit dem Zuschnitt kann die Antwort
    // auf „flacher" zweierlei sein: entweder die Flaeche schrumpft, oder sie faellt unter das
    // Mindestmass und wird ganz freigegeben — dann scrollt die Seite. Beides ist richtig,
    // eingefroren mit abgeschnittenem Inhalt ist es nicht.
    ok('beim Drehen wird neu gerechnet — quer flacher oder Fläche freigegeben',
      quer.hoehe < hochkant || quer.seitenScroll > 2, `${hochkant} → ${quer.hoehe}, Seitenscroll ${quer.seitenScroll}`);
    ok('… und quer bleibt der ganze Tag erreichbar', !quer.scrollt || quer.restUnten <= ERLAUBTER_REST,
      `Fläche ${quer.hoehe}, Inhalt ${quer.inhalt}, Rest unten ${quer.restUnten}`);
    await page.setViewport({ width: 411, height: 795 });
    await sleep(900);
    const zurueck = (await messen()).hoehe;
    ok('und nach dem Zurückdrehen wieder wie vorher', Math.abs(zurueck - hochkant) <= 4, `${hochkant} → ${quer} → ${zurueck}`);

    console.log('\n── Mindestmaß: auf einem sehr flachen Bildschirm bleibt die Fläche brauchbar ──');
    await page.setViewport({ width: 411, height: 420 });
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.timeline-scroll'); await sleep(1200);
    const flach = await page.evaluate(() => Math.round(document.querySelector('.timeline-scroll').getBoundingClientRect().height));
    ok('die Zeitleiste bleibt mindestens 260 px hoch', flach >= 260, `${flach} px`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPlatznutzung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
