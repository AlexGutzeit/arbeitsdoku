// Prod-Klon: Die Summen im Zeitnachweis passen zusammen — Gesamt = Summe der Jahre, Jahr = Summe seiner Monate,
// je Person und insgesamt, auch MIT Filter. NUR LESEND, auf einer eigenen KOPIE von /tmp/prodklon.db.
//
// Alex' Frage vom 06.10.2026: „Wenn im Gesamt nach dem Projekt gefiltert wird — kommt in der Monatsansicht (alle
// addiert), in der Jahresansicht und in der Gesamtansicht überall dasselbe raus?" Damals von Hand geprüft und
// gleich; jetzt prüft es jede Suite. Geklickt wird wie ein Mensch (Umschalter, Pfeile, Filter-Auswahl), gelesen
// wird, was auf dem Bildschirm steht (Kachel „Nettostunden", Summe im Spaltenkopf je Person).
//
// Das Repo ist öffentlich: KEINE echten Projekt- oder Personennamen hier. Die Projekte wählt der Test selbst (die
// drei mit den meisten Einträgen), dazu einmal „ein Projekt + Regie".
//
//   node tests/zeitnachweis-summen-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer'); const jwt = require('jsonwebtoken'); const initSqlJs = require('sql.js');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const VORLAGE = '/tmp/prodklon.db', DB = '/tmp/zeitnachweis-summen-prodklon.db';
const PORT = 3374, SECRET = 'test-secret-mindestens-32-zeichen-lang-summen', BASE = `http://localhost:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const minuten = (t) => { const m = String(t || '').match(/(-?)(\d+):(\d\d)/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; };
const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const get = (p) => new Promise(res => { http.get({ host: 'localhost', port: PORT, path: p }, x => { x.resume(); res(x.statusCode); }).on('error', () => res(0)); });

(async () => {
  if (!fs.existsSync(VORLAGE)) { console.log('Prod-Klon ' + VORLAGE + ' fehlt — Test übersprungen.'); process.exit(0); }
  fs.copyFileSync(VORLAGE, DB);                     // die Vorlage nie anfassen (ältere Tests schreiben sonst hinein)
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { if (await get('/health') === 200) break; await sleep(200); }
    const SQL = await initSqlJs(); const db = new SQL.Database(fs.readFileSync(DB));
    const [id, username, name, role] = db.exec("SELECT id, username, name, role FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    const top = db.exec(`SELECT e.project_id, COUNT(*) FROM entries e JOIN projects p ON p.id = e.project_id
      WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL GROUP BY e.project_id ORDER BY 2 DESC LIMIT 3`);
    const projekte = top.length ? top[0].values.map(v => v[0]) : [];
    db.close();
    if (!projekte.length) { console.log('Keine Projekte mit Einträgen im Klon — Test übersprungen.'); return; }
    console.log(`  echte Daten · geprüft werden ${projekte.length} Projekte (die mit den meisten Einträgen) + ein Projekt mit Regie`);

    const token = jwt.sign({ userId: id, role }, SECRET, { expiresIn: '2h' });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1400, height: 900 }); p.setDefaultTimeout(45000);
    const fehler = []; p.on('pageerror', e => fehler.push(String(e)));
    await p.goto(BASE, { waitUntil: 'domcontentloaded' });
    await p.evaluate((t, u) => { localStorage.setItem('token', t); localStorage.setItem('user', u); }, token, JSON.stringify({ id, username, name, role }));
    await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);     // goto mit nur anderem Anker lädt NICHT neu
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(3000);
    const warte = () => sleep(2000);
    const klick = async (sel) => { await p.click(sel); await warte(); };
    // Was auf dem Bildschirm steht: Zeitraum, Kachel „Nettostunden", Summe je Person (Spaltenkopf)
    const lies = () => p.evaluate(() => {
      const koepfe = [...document.querySelectorAll('.week-month-grid thead th.grid-col-header')].map(th => ({
        name: th.innerText.split('\n')[0].trim(), summe: (th.querySelector('.grid-col-header-sum') || {}).innerText || '' }));
      return { periode: document.querySelector('.current-period').innerText, netto: document.querySelector('.summary-card .value').innerText, koepfe,
        jahre: [...document.querySelectorAll('.week-month-grid tbody .grid-row-header')].map(z => z.innerText.trim()) };
    });
    const jePerson = (stand) => { const o = {}; for (const k of stand.koepfe) o[k.name] = (o[k.name] || 0) + minuten(k.summe); return o; };
    const addiere = (ziel, quelle) => { for (const [n, v] of Object.entries(quelle)) ziel[n] = (ziel[n] || 0) + v; return ziel; };
    const vergleiche = (titel, a, b) => {
      const namen = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(n => a[n] || b[n]);
      const abweichend = namen.filter(n => (a[n] || 0) !== (b[n] || 0));
      ok(`${titel} (${namen.length} Personen)`, abweichend.length === 0,
        abweichend.slice(0, 3).map(n => `Person ${namen.indexOf(n) + 1}: ${hm(a[n] || 0)} ≠ ${hm(b[n] || 0)}`).join(' · '));
    };

    async function probe(titel, pid, regie) {
      console.log(`\n── ${titel} ──`);
      await klick('.view-toggle [data-view="total"]');
      await p.select('#filter-project', String(pid)); await warte();
      await p.select('#filter-regie', regie || ''); await warte();
      const gesamt = await lies();
      ok('Gesamt: Kachel = Summe der Personen', minuten(gesamt.netto) === Object.values(jePerson(gesamt)).reduce((s, v) => s + v, 0),
        `${gesamt.netto} ≠ ${hm(Object.values(jePerson(gesamt)).reduce((s, v) => s + v, 0))}`);
      const jahrSummen = {}; let jahreNetto = 0;
      for (const jahr of gesamt.jahre) {
        await klick('.view-toggle [data-view="year"]');
        await p.evaluate(y => { S.currentDate = new Date(Number(y), 5, 15); renderDashboardContent(); }, jahr); await warte();
        const j = await lies();
        // Die Monate des Jahres per Pfeil durchblättern
        await klick('.view-toggle [data-view="month"]');
        await p.evaluate(y => { S.currentDate = new Date(Number(y), 0, 15); renderDashboardContent(); }, jahr); await warte();
        const monatSummen = {}; let monateNetto = 0;
        for (let m = 0; m < 12; m++) {
          const mo = await lies(); addiere(monatSummen, jePerson(mo)); monateNetto += minuten(mo.netto);
          if (m < 11) await klick('#date-next');
        }
        ok(`${jahr}: Jahres-Kachel ${j.netto} = 12 Monate addiert`, minuten(j.netto) === monateNetto, `Monate ${hm(monateNetto)}`);
        vergleiche(`${jahr}: je Person Jahr = Monate`, jePerson(j), monatSummen);
        addiere(jahrSummen, jePerson(j)); jahreNetto += minuten(j.netto);
        await klick('.view-toggle [data-view="total"]');
      }
      ok(`Gesamt ${gesamt.netto} = alle Jahre addiert`, minuten(gesamt.netto) === jahreNetto, hm(jahreNetto));
      vergleiche('je Person Gesamt = Jahre', jePerson(gesamt), jahrSummen);
      ok('der Filter blieb beim Wechseln stehen', await p.$eval('#filter-project', s => s.value) === String(pid));
    }
    for (const [i, pid] of projekte.entries()) await probe(`Projekt ${i + 1} von ${projekte.length}`, pid);
    await probe('Projekt 1 + Regie: Ja', projekte[0], '1');
    await p.select('#filter-project', ''); await p.select('#filter-regie', '');
    ok('keine JavaScript-Fehler', fehler.length === 0, fehler.slice(0, 2).join(' | '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nZeitnachweis-Summen am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
