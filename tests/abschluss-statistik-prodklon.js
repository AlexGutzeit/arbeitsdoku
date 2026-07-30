// Der zeitraum-bezogene „abgerechnet"-Hinweis an ECHTEN Daten.
//
// Auf dem Produktivstand sind mehrere Monate abgeschlossen. Genau da muss auffallen, wenn die
// Statistik weiterhin überall denselben (letzten) Abschluss zeigt — mit erfundenen Testdaten kann
// man sich das schönrechnen, mit den echten nicht.
//
// Geprüft wird gegen eine ARBEITSKOPIE, nur lesend gegenüber der Quelle:
//   * jeder abgeschlossene Monat zeigt SEINE Zahlen — abgeglichen gegen die Snapshot-Zeile
//   * ein offener Monat zeigt gar nichts
//   * die Jahresansicht nennt den letzten Stichtag
//
// Mit SHOTS=1 werden zusätzlich Bildschirmfotos abgelegt (Pfad über SHOT_DIR).
//   node tests/abschluss-statistik-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3225, DB = '/tmp/abschluss-stat-klon.db', BASIS = `http://localhost:${PORT}`;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const hole = (pfad, token) => new Promise(res => {
  const r = http.request({ host: 'localhost', port: PORT, path: pfad, headers: token ? { Authorization: 'Bearer ' + token } : {} },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
  r.on('error', () => res({ status: 0 })); r.end();
});
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monatsName = iso => `${MONATE[Number(String(iso).slice(5, 7)) - 1]} ${String(iso).slice(0, 4)}`;
const zahlDe = n => String(Math.round(Number(n) * 100) / 100).replace('.', ',');

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test übersprungen.'); process.exit(0); }
  const pruefsumme = crypto.createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');
  fs.copyFileSync(QUELLE, DB);

  const SQL = await initSqlJs();
  const d0 = new SQL.Database(fs.readFileSync(DB));
  const hatTabelle = d0.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_closures'").length;
  if (!hatTabelle) { console.log('Klon kennt den Abschluss noch nicht — Test übersprungen.'); d0.close(); process.exit(0); }
  const perioden = (d0.exec('SELECT id, period_from, period_to FROM payroll_closures ORDER BY period_from')[0] || { values: [] }).values;
  // Ein Mitarbeiter, der in MEHREREN Abschlüssen mit UNTERSCHIEDLICHEN Ist-Stunden steht — nur dann
  // faellt auf, wenn immer derselbe Abschluss gezeigt wird.
  const kandidaten = (d0.exec(`SELECT r.user_id, u.name, COUNT(DISTINCT r.ist) verschieden, COUNT(*) n
                                 FROM payroll_closure_rows r JOIN users u ON u.id = r.user_id
                                WHERE u.role = 'mitarbeiter'
                                GROUP BY r.user_id HAVING verschieden >= 2 ORDER BY n DESC`)[0] || { values: [] }).values;
  if (!perioden.length || !kandidaten.length) { console.log('Zu wenig abgeschlossene Monate im Klon — Test übersprungen.'); d0.close(); process.exit(0); }
  const [uid, uname] = kandidaten[0];
  const zeilen = {};
  for (const [pid, von] of perioden) {
    const r = d0.exec(`SELECT soll, ist, saldo, ueberstunden_gesamt FROM payroll_closure_rows WHERE closure_id=${pid} AND user_id=${uid}`);
    if (r.length) zeilen[von] = r[0].values[0];
  }
  d0.close();
  console.log(`Klon: ${perioden.length} Abschlüsse · Prüfling ${uname} (${Object.keys(zeilen).length} Zeilen)\n`);

  const lg = fs.openSync('/tmp/abschluss-stat-klon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { if ((await hole('/health')).status === 200) break; await sleep(200); }
    const token = jwt.sign({ userId: uid, role: 'mitarbeiter' }, SECRET, { expiresIn: '2h' });
    const me = await hole('/api/auth/me', token);
    ok('Anmeldung am Klon möglich', me.status === 200, String(me.status));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 2 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument((tk, usr) => { localStorage.setItem('token', tk); localStorage.setItem('user', usr); },
      token, JSON.stringify(me.body.user));
    // networkidle0 taugt nicht: angemeldet gestartet haelt der SSE-Kanal die Verbindung offen.
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(800);

    async function ansicht(period, datum, bild) {
      await page.goto(BASIS + '/#/statistics', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.stats-page'); await sleep(1000);
      await page.evaluate((p, dd) => { S.statsPeriod = p; if (dd) S.statsDate = new Date(dd + 'T12:00:00'); renderStatistics(); }, period, datum);
      await sleep(1500);
      const text = await page.evaluate(() => {
        const k = document.querySelector('.stats-page > .card');
        return k && /abgerechnet/i.test(k.innerText) ? k.innerText.replace(/\s+/g, ' ').trim() : '';
      });
      if (bild && process.env.SHOTS === '1') {
        await page.screenshot({ path: path.join(SHOT_DIR, bild), clip: { x: 0, y: 0, width: 1000, height: 900 } });
      }
      return text;
    }

    console.log('── Jeder abgeschlossene Monat zeigt SEINE Zahlen ──');
    let nr = 0;
    for (const [, von] of perioden) {
      const z = zeilen[von];
      if (!z) continue;
      nr++;
      const t = await ansicht('month', von.slice(0, 7) + '-15', nr <= 2 ? `10-abschluss-${von.slice(0, 7)}.png` : null);
      console.log(`   ${monatsName(von).padEnd(14)} → „${t.slice(0, 120)}${t.length > 120 ? '…' : ''}"`);
      ok(`${monatsName(von)}: der Hinweis nennt genau diesen Monat`,
        t.includes(monatsName(von) + ' ist abgerechnet'), `„${t}"`);
      ok(`${monatsName(von)}: Ist ${zahlDe(z[1])} h — die Zahl aus DIESEM Abschluss`,
        t.includes(`Ist ${zahlDe(z[1])} h`), `„${t}"`);
      ok(`${monatsName(von)}: Überstunden gesamt ${zahlDe(z[3])} h`,
        t.includes(`Überstunden gesamt ${zahlDe(z[3])} h`), `„${t}"`);
    }
    ok('mehr als ein Monat geprüft (sonst wäre die Aussage wertlos)', nr >= 2, String(nr));

    console.log('\n── Tag und Woche in abgeschlossenen Monaten ──');
    // Ein Tag oder eine Woche IN einem abgeschlossenen Monat folgt diesem Monat. Reicht die Woche
    // über den Monatswechsel hinaus, muss dazustehen, dass nicht alles Angezeigte abgerechnet ist.
    const ersteVon = perioden[0][1], letzteBis = perioden[perioden.length - 1][2];
    const mitteMonat = ersteVon.slice(0, 8) + '18';
    const tTag = await ansicht('day', mitteMonat, null);
    ok(`Tag im ${monatsName(ersteVon)} → dessen Abschluss`, tTag.includes(monatsName(ersteVon) + ' ist abgerechnet'), `„${tTag}"`);
    ok('Tag: kein Zusatz — der Tag liegt ganz im Abschluss',
      !/nicht abgerechnet sind/.test(tTag), `„${tTag}"`);

    const tWoche = await ansicht('week', mitteMonat, null);
    ok(`Woche im ${monatsName(ersteVon)} → derselbe Abschluss`, tWoche.includes(monatsName(ersteVon) + ' ist abgerechnet'), `„${tWoche}"`);
    ok('Woche mitten im Monat: ebenfalls kein Zusatz',
      !/nicht abgerechnet sind/.test(tWoche), `„${tWoche}"`);

    // Die Woche, die auf den letzten Stichtag folgt, ragt zur Hälfte in den offenen Bereich.
    const danach = new Date(letzteBis + 'T12:00:00Z'); danach.setUTCDate(danach.getUTCDate() + 1);
    const tRand = await ansicht('week', danach.toISOString().slice(0, 10), '13-abschluss-woche-monatswechsel.png');
    ok('Woche über den letzten Stichtag hinaus → Hinweis auf die offenen Tage',
      /nicht abgerechnet sind/.test(tRand), `„${tRand}"`);

    console.log('\n── Offener Monat und Jahresansicht ──');
    const letzterBis = letzteBis;
    const naechster = new Date(letzterBis + 'T12:00:00Z'); naechster.setUTCDate(naechster.getUTCDate() + 15);
    const offen = naechster.toISOString().slice(0, 10);
    const tOffen = await ansicht('month', offen, '11-abschluss-offener-monat.png');
    ok(`offener Monat (${monatsName(offen)}) → gar kein Hinweis`, tOffen === '', `„${tOffen}"`);

    const tJahr = await ansicht('year', letzterBis, '12-abschluss-jahr.png');
    ok('Jahr → „Abgerechnet bis …" statt eines einzelnen Monats',
      /Abgerechnet bis/.test(tJahr) && !/ist abgerechnet/.test(tJahr), `„${tJahr}"`);
    const bisDe = `${letzterBis.slice(8, 10)}.${letzterBis.slice(5, 7)}.${letzterBis.slice(0, 4)}`;
    ok(`Jahr → Stichtag ist der letzte Abschluss (${bisDe})`, tJahr.includes(bisDe), `„${tJahr}"`);
    ok('Jahr → Zusatz, weil auch offene Tage im Jahr liegen', /nicht abgerechnet sind/.test(tJahr), `„${tJahr}"`);

    // „Gesamt" reicht vom ersten Eintrag bis zum BEZUGSDATUM — nicht zwangsläufig bis heute, auch
    // wenn die Ansicht keinen Datumswähler hat. Beim ersten Anlauf hing hier noch der 30.06. aus
    // der Jahres-Prüfung nach; damit endete „Gesamt" genau am letzten Stichtag und der Zusatz
    // fehlte zu Recht. Deshalb wird das Datum hier ausdrücklich auf HEUTE gesetzt.
    const heuteIso = new Date().toLocaleDateString('sv-SE');
    const tGesamt = await ansicht('total', heuteIso, '14-abschluss-gesamt.png');
    ok('Gesamt → wie die Jahresansicht: „Abgerechnet bis …"',
      /Abgerechnet bis/.test(tGesamt) && !/ist abgerechnet/.test(tGesamt), `„${tGesamt}"`);
    ok(`Gesamt → derselbe Stichtag (${bisDe})`, tGesamt.includes(bisDe), `„${tGesamt}"`);
    ok('Gesamt → Zusatz wegen der offenen Tage bis heute', /nicht abgerechnet sind/.test(tGesamt), `„${tGesamt}"`);
    console.log(`   Gesamt → „${tGesamt.slice(0, 150)}…"`);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(1000);
  }

  ok('Ausgangskopie unberührt',
    crypto.createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex') === pruefsumme);
  try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nAbschluss-Hinweis am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
