// Der 18. Geburtstag am ECHTEN Datenstand: Kippt die Pausenregel am richtigen Tag?
//
// Anlass: Jakob Wolf (*19.08.2008) wird demnächst 18. Bis dahin gilt § 11 JArbSchG (30 min ab 4½,
// 60 min ab 6 Std), ab seinem Geburtstag § 4 ArbZG (30 min ab 6, 45 min ab 9 Std).
//
// Geprüft wird gegen eine ARBEITSKOPIE der Produktivdaten, mit VORGESTELLTER BROWSER-UHR — sonst
// wäre der Übergang nur an genau einem Kalendertag im Jahr prüfbar. Der Vorschlag entsteht im
// Browser aus dem Geburtsdatum und dem EINTRAGSDATUM, deshalb genügt es, die Uhr der Seite zu
// stellen; geschrieben wird nichts.
//
// Der Test sucht sich seinen Prüfling selbst (jüngster Nutzer mit Geburtsdatum) und reist zu
// dessen 18. Geburtstag — er veraltet also nicht, wenn Jakob volljährig geworden ist.
//   node tests/jugendschutz-uebergang-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3211, DB = '/tmp/jugendschutz-uebergang.db', BASIS = `http://localhost:${PORT}`;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const hole = (pfad, token) => new Promise(res => {
  const r = http.request({ host: 'localhost', port: PORT, path: pfad, headers: token ? { Authorization: 'Bearer ' + token } : {} },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
  r.on('error', () => res({ status: 0 })); r.end();
});
const plusTage = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test übersprungen.'); process.exit(0); }
  const pruefsumme = require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');
  fs.copyFileSync(QUELLE, DB);

  const SQL = await initSqlJs();
  const d = new SQL.Database(fs.readFileSync(DB));
  const spalten = d.exec('PRAGMA table_info(users)')[0].values.map(v => v[1]);
  if (!spalten.includes('birth_date')) { console.log('Klon kennt birth_date noch nicht — Test übersprungen.'); d.close(); process.exit(0); }
  const kandidaten = d.exec(
    "SELECT id, name, birth_date FROM users WHERE birth_date IS NOT NULL AND birth_date != '' AND COALESCE(active,1)=1 ORDER BY birth_date DESC"
  );
  d.close();
  if (!kandidaten.length) { console.log('Niemand mit Geburtsdatum im Klon — Test übersprungen.'); process.exit(0); }
  // Standard: der jüngste Mensch mit Geburtsdatum. Mit PRUEFLING="Teil des Namens" gezielt wählbar.
  const zeilen = kandidaten[0].values;
  const gesucht = process.env.PRUEFLING
    ? zeilen.find(z => String(z[1]).toLowerCase().includes(process.env.PRUEFLING.toLowerCase()))
    : null;
  if (process.env.PRUEFLING && !gesucht) { console.log(`Niemand passt auf "${process.env.PRUEFLING}" — Test übersprungen.`); process.exit(0); }
  const [uid, uname, geburt] = gesucht || zeilen[0];
  const achtzehn = `${Number(geburt.slice(0, 4)) + 18}${geburt.slice(4)}`;
  console.log(`Prüfling: ${uname} (*${geburt}) — 18. Geburtstag am ${achtzehn}\n`);

  const lg = fs.openSync('/tmp/jugendschutz-uebergang-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { if ((await hole('/health')).status === 200) break; await sleep(250); }
    const token = jwt.sign({ userId: uid, role: 'mitarbeiter' }, SECRET, { expiresIn: '2h' });
    const me = await hole('/api/auth/me', token);
    ok('Anmeldung am Klon möglich', me.status === 200 && me.body.user.birth_date === geburt,
      me.status + ' ' + JSON.stringify(me.body && me.body.user && me.body.user.birth_date));

    const firma = (await hole('/api/settings/arbeitszeit', token)).body;
    const firmenPause = Number(firma.arbeitszeit.break_minutes_default);
    console.log(`  Firmenpause laut Einstellungen: ${firmenPause} min\n`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // Ein Messpunkt: Browser-Uhr auf `tag` stellen, Formular öffnen, Zeiten setzen, Vorschlag lesen.
    async function messen(tag, von, bis) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 900 });
      page.setDefaultTimeout(45000);
      await page.evaluateOnNewDocument((iso, tk, usr) => {
        const E = Date; const ziel = new E(iso + 'T09:00:00').getTime(); const v = ziel - E.now();
        function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
        G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
        localStorage.setItem('token', tk); localStorage.setItem('user', usr);
      }, tag, token, JSON.stringify(me.body.user));
      // networkidle0 waere hier falsch: Die Sitzung ist von Anfang an angemeldet, der SSE-Kanal
      // bleibt offen und der Ruhezustand tritt nie ein.
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(700);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#ef-break'); await sleep(900);
      await page.evaluate(t => { const e = document.getElementById('ef-date'); e.value = t; e.dispatchEvent(new Event('change', { bubbles: true })); }, tag);
      await sleep(1200);
      await page.evaluate((v, b) => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
        f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
      }, von, bis);
      await sleep(1500);
      const wert = await page.evaluate(() => document.getElementById('ef-break').value);
      const hinweis = await page.evaluate(() => { const e = document.getElementById('ef-break-hinweis'); return e && e.checkVisibility && e.checkVisibility() ? e.innerText : ''; });
      await page.close();
      return { wert, hinweis };
    }

    // Tage ohne vorhandene Einträge wählen — sonst mischt sich die Restpausen-Rechnung ein und der
    // Test misst etwas anderes, als er zu messen glaubt.
    const frei = async (tag) => {
      const r = await hole(`/api/entries?date_from=${tag}&date_to=${tag}`, token);
      return (r.body && r.body.entries ? r.body.entries : []).length === 0;
    };
    for (const t of [plusTage(achtzehn, -1), achtzehn, plusTage(achtzehn, 1)]) {
      ok(`${t}: keine vorhandenen Einträge (sauberer Messpunkt)`, await frei(t));
    }

    console.log('\n── Normaler Tag 07:00–15:30 (8:30 Anwesenheit) ─────────');
    for (const [tag, erwartet, was] of [
      [plusTage(achtzehn, -1), '60', 'Vortag — noch 17, Jugendarbeitsschutz'],
      [achtzehn,               String(firmenPause), 'Geburtstag — ab heute Erwachsener, Firmenpause'],
      [plusTage(achtzehn, 1),  String(firmenPause), 'Tag danach — bleibt Erwachsener'],
    ]) {
      const m = await messen(tag, '07:00', '15:30');
      ok(`${tag} → ${erwartet} min  (${was})`, m.wert === erwartet, `gemessen ${m.wert} · „${m.hinweis}"`);
      if (m.hinweis) console.log(`      „${m.hinweis}"`);
    }

    console.log('\n── Langer Tag 07:00–17:00 (10 Std Anwesenheit) ─────────');
    for (const [tag, erwartet, was] of [
      [plusTage(achtzehn, -1), '60', 'Vortag — JArbSchG, 60 min ab 6 Std'],
      [achtzehn,               '45', 'Geburtstag — ArbZG, 45 min ab 9 Std'],
    ]) {
      const m = await messen(tag, '07:00', '17:00');
      ok(`${tag} → ${erwartet} min  (${was})`, m.wert === erwartet, `gemessen ${m.wert} · „${m.hinweis}"`);
      if (m.hinweis) console.log(`      „${m.hinweis}"`);
    }

    console.log('\n── Heute (Ist-Zustand des Prüflings) ───────────────────');
    const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    const nochJugendlich = heute < achtzehn;
    const heuteFrei = await frei(heute);
    if (heuteFrei) {
      const m = await messen(heute, '07:00', '15:30');
      ok(`heute (${heute}) → ${nochJugendlich ? '60' : String(firmenPause)} min`,
        m.wert === (nochJugendlich ? '60' : String(firmenPause)), `gemessen ${m.wert} · „${m.hinweis}"`);
      if (m.hinweis) console.log(`      „${m.hinweis}"`);
    } else {
      console.log(`  (übersprungen — ${uname} hat heute schon Einträge, die Restpause würde mitreden)`);
    }

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(1000);
  }

  ok('Ausgangskopie unberührt',
    require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex') === pruefsumme);
  try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nJugendschutz-Übergang am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
