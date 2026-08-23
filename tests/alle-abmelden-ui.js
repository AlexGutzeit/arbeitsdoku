// „Auf allen Geräten abmelden" — der Knopf darf einen NICHT selbst hinauswerfen (Alex, 23.08.2026).
//
// Der Server erhöht dabei einen Zähler je Nutzer; jedes Token mit kleinerem Stand ist in derselben
// Sekunde wertlos — auch das eigene, mit dem geklickt wurde. Damit man sich nicht selbst
// aussperrt, liefert die Antwort sofort ein frisches Token, das die Oberfläche übernehmen MUSS.
// Vergisst sie das, fliegt der Nutzer beim nächsten Klick raus.
//
// Auf API-Ebene stand das schon in konto-sitzung-daten.js. Was fehlte: Den Knopf hat im Browser
// nie jemand gedrückt — geprüft war nur, DASS er da ist. Genau dazwischen liegt der Fehler, den
// niemand sähe.
//
// Mitgeprüft wird der zweite Tab auf DEMSELBEN Gerät. Er hält sein Token im Speicher; ohne
// Abgleich über den localStorage wäre er nach dem Klick ausgesperrt, obwohl es dasselbe Gerät ist.
//
//   node tests/alle-abmelden-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3270, DB = '/tmp/alle-abmelden.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Fragt MIT dem Token, das die Seite gerade wirklich benutzt — nicht mit einem aus dem Test.
const kommtDurch = (page) => page.evaluate(async () =>
  (await fetch('/api/entries', { headers: { Authorization: 'Bearer ' + S.token } })).status);
const tokenIn = (page) => page.evaluate(() => ({ speicher: localStorage.getItem('token'), laufend: S.token }));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/alle-abmelden-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/alle-abmelden-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const anmelden = async (page) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
      await page.click('#login-form button[type="submit"]');
      await sleep(2400);
    };

    // „Rechner" = der Standard-Kontext. „Handy" = eigener Kontext, also eigener Speicher.
    const rechner = await browser.newPage(); await rechner.setViewport({ width: 520, height: 950 });
    rechner.setDefaultTimeout(30000);
    await anmelden(rechner);
    const handyKontext = await browser.createBrowserContext();
    const handy = await handyKontext.newPage(); await handy.setViewport({ width: 420, height: 860 });
    handy.setDefaultTimeout(30000);
    await anmelden(handy);

    // Ein zweiter Tab, der SCHON OFFEN IST, wenn geklickt wird. Er haelt sein Token im Speicher
    // der Seite; der localStorage allein hilft ihm nicht, wenn ihn niemand darauf hinweist.
    const zweiterTab = await browser.newPage(); await zweiterTab.setViewport({ width: 520, height: 950 });
    zweiterTab.setDefaultTimeout(30000);
    await zweiterTab.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);

    console.log('── Ausgangslage: beide Geräte sind drin ──');
    ok('Rechner kommt durch', (await kommtDurch(rechner)) === 200);
    ok('Handy kommt durch', (await kommtDurch(handy)) === 200);
    const vorher = await tokenIn(rechner);
    ok('… und die Token unterscheiden sich', vorher.speicher !== (await tokenIn(handy)).speicher);

    console.log('\n── Am Rechner auf „Auf allen Geräten abmelden" drücken ──');
    await rechner.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await rechner.waitForSelector('#alle-abmelden'); await sleep(1500);
    await rechner.evaluate(() => { const b = document.getElementById('alle-abmelden'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(900);
    // Der Sicherheitsdialog will bestätigt werden — und zwar GENAU sein OK-Knopf.
    // Beim ersten Versuch suchte der Test nach einem Knopf mit passender Beschriftung und traf
    // dabei „Abmelden" in der Kopfzeile: Der Test meldete sich selbst ab und behauptete danach,
    // der Knopf sperre einen aus. Deshalb hier der eindeutige Weg über den Dialog.
    const dialogDa = !!(await rechner.$('.dialog-modal [data-act="ok"]'));
    ok('der Sicherheitsdialog geht auf', dialogDa,
      'ohne ihn wuerde der Test danach nur pruefen, dass Nichtstun nichts kaputtmacht');
    await rechner.click('.dialog-modal [data-act="ok"]');
    await sleep(2200);

    console.log('\n── DIESES Gerät bleibt angemeldet ──');
    const nachher = await tokenIn(rechner);
    ok('es gibt ein FRISCHES Token', !!nachher.speicher && nachher.speicher !== vorher.speicher,
      `${String(vorher.speicher).slice(-12)} → ${String(nachher.speicher).slice(-12)}`);
    ok('… und der laufende Betrieb benutzt dasselbe', nachher.laufend === nachher.speicher);
    ok('der Rechner kommt weiterhin durch', (await kommtDurch(rechner)) === 200);
    // Nicht nur die Schnittstelle — die Seite selbst muss weiter benutzbar sein.
    await rechner.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('… und die App zeigt keine Anmeldemaske', !(await rechner.$('#login-user')));
    await rechner.reload({ waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('… auch nach einem Neuladen nicht', !(await rechner.$('#login-user')),
      'sonst waere das frische Token nicht dauerhaft gespeichert');

    console.log('\n── Das andere Gerät ist draußen ──');
    ok('das Handy wird abgewiesen', (await kommtDurch(handy)) === 401);
    await handy.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);
    ok('… und landet in der Anmeldemaske', !!(await handy.$('#login-user')));

    console.log('\n── Der zweite Tab auf DEMSELBEN Gerät, der schon offen war ──');
    await sleep(1200);
    ok('er hat das frische Token uebernommen', (await tokenIn(zweiterTab)).laufend === nachher.speicher,
      `Tab: …${String((await tokenIn(zweiterTab)).laufend).slice(-12)}  Speicher: …${String(nachher.speicher).slice(-12)}`);
    ok('… und kommt weiterhin durch', (await kommtDurch(zweiterTab)) === 200,
      'derselbe Rechner darf nicht ausgesperrt sein');

    console.log('\n── Ein danach geoeffneter Tab ohnehin ──');
    const dritterTab = await browser.newPage(); await dritterTab.setViewport({ width: 520, height: 950 });
    dritterTab.setDefaultTimeout(30000);
    await dritterTab.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);
    ok('kein Anmeldebildschirm', !(await dritterTab.$('#login-user')));
    ok('… und kommt durch', (await kommtDurch(dritterTab)) === 200);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAuf allen Geräten abmelden: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
