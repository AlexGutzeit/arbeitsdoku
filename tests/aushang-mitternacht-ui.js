// Ein Aushang, der kurz nach Mitternacht geschrieben wurde, muss auf der Willkommensseite stehen.
//
// Hintergrund: SQLite schreibt `strftime('now')` in UTC. Im Sommer liegt das zwei Stunden hinter
// unserer Uhr. Ein Aushang von 00:30 Uhr trägt also intern das Datum von GESTERN. Der Filter
// „heute erstellt" verglich diesen Zeitstempel roh gegen das lokale Datum — und fand nichts. Der
// Aushang war zwischen Mitternacht und 02:00 Uhr unsichtbar, danach tauchte er auf. Genau die Art
// Fehler, die man im Tagesbetrieb nie bemerkt und um Mitternacht nicht glaubt.
//
// Der vorhandene Test `aushang-sprung-ui` hätte das gefunden — aber nur, wenn er zufällig nachts
// läuft. Dieser hier stellt die Falle absichtlich, zu JEDER Uhrzeit: Die Antwort des Servers wird
// im Browser abgefangen und der Zeitstempel auf „heute, 00:30 Uhr bei uns" gesetzt — was in UTC
// zwangsläufig der Vortag ist. Der Test prüft vorher nach, dass die Falle wirklich steht.
//
//   node tests/aushang-mitternacht-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3264, DB = '/tmp/aushang-mitternacht.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// „Heute, 00:30 Uhr Ortszeit" als UTC-Zeitstempel im Format der Datenbank.
function mitternachtsStempel() {
  const heute = new Date().toLocaleDateString('sv-SE');       // JJJJ-MM-TT, lokal
  const d = new Date(`${heute}T00:30:00`);                    // 00:30 Uhr Ortszeit
  return d.toISOString().replace('T', ' ').replace('Z', '');  // '…-… 22:30:00.000' (UTC)
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/aushang-mitternacht-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/aushang-mitternacht-srv.log', 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body;
    await req('POST', '/api/bulletin', chef.token, { title: 'Kurz nach Mitternacht', text: 'Frühschicht faellt aus' });

    const stempel = mitternachtsStempel();
    const heuteLokal = new Date().toLocaleDateString('sv-SE');

    console.log('── Steht die Falle überhaupt? ──');
    ok('der Zeitstempel trägt roh gelesen NICHT das heutige Datum',
      stempel.slice(0, 10) !== heuteLokal, `${stempel} vs. ${heuteLokal}`);
    ok('… gehört bei uns aber sehr wohl zu heute',
      new Date(stempel.replace(' ', 'T') + 'Z').toLocaleDateString('sv-SE') === heuteLokal, stempel);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 500, height: 900 });
    page.setDefaultTimeout(30000);

    // Die Antwort auf /api/bulletin wird im Browser umgeschrieben: alle Aushänge gelten als um
    // 00:30 Uhr geschrieben. Am Server ändert sich nichts — geprüft wird allein die Anzeige.
    await page.evaluateOnNewDocument((s) => {
      const echt = window.fetch;
      window.fetch = async (...args) => {
        const antwort = await echt(...args);
        const adresse = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (!adresse.includes('/api/bulletin')) return antwort;
        const daten = await antwort.clone().json().catch(() => null);
        if (!daten || !Array.isArray(daten.entries)) return antwort;
        for (const e of daten.entries) e.created_at = s;
        return new Response(JSON.stringify(daten), { status: antwort.status, headers: { 'Content-Type': 'application/json' } });
      };
    }, stempel);

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'chef'); await page.type('#login-pass', pw('chef'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await sleep(2200);

    console.log('\n── Die Willkommensseite zeigt ihn ──');
    const karten = await page.$$eval('[data-aushang]', ns => ns.map(n => n.textContent.trim()));
    ok('der Aushang von 00:30 Uhr steht auf der Seite', karten.length === 1, JSON.stringify(karten));
    ok('… mit seinem Titel', /Kurz nach Mitternacht/.test(karten.join(' ')), JSON.stringify(karten));

    console.log('\n── Die Umrechnung selbst ──');
    const umgerechnet = await page.evaluate(s => datumAusZeitstempel(s), stempel);
    ok('datumAusZeitstempel liefert den hiesigen Kalendertag', umgerechnet === heuteLokal, `${umgerechnet} vs. ${heuteLokal}`);
    ok('leere Eingabe ergibt einen leeren Text', (await page.evaluate(() => datumAusZeitstempel(''))) === '');
    ok('Unsinn stürzt nicht ab, sondern fällt auf die rohen Zeichen zurück',
      (await page.evaluate(() => datumAusZeitstempel('kein datum'))) === 'kein datum');

    console.log('\n── Ein Aushang von vorgestern gehört nicht auf die Seite ──');
    const vorgestern = (() => { const d = new Date(Date.now() - 2 * 864e5); return d.toISOString().replace('T', ' ').replace('Z', ''); })();
    await page.evaluate(s => {
      const echt = window.fetch;
      window.fetch = async (...args) => {
        const antwort = await echt(...args);
        const adresse = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (!adresse.includes('/api/bulletin')) return antwort;
        const daten = await antwort.clone().json().catch(() => null);
        if (!daten || !Array.isArray(daten.entries)) return antwort;
        for (const e of daten.entries) e.created_at = s;
        return new Response(JSON.stringify(daten), { status: antwort.status, headers: { 'Content-Type': 'application/json' } });
      };
    }, vorgestern);
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(1200);
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('kein alter Aushang auf der Willkommensseite',
      (await page.$$eval('[data-aushang]', ns => ns.length)) === 0);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAushang um Mitternacht: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
