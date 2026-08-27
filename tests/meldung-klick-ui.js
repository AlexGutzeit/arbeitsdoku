// Der Klick auf eine Meldung landet im richtigen Menü — die Seite des Clients (Alex, 27.08.2026).
//
// Der Service Worker kann die offene App nicht selbst umschalten: Ein Sprung von /#/dashboard nach
// /#/orders ist in einer Hash-Anwendung KEINE neue Seite, und `client.navigate()` lehnt dafuer sein
// Versprechen still ab. Deshalb schickt er der App eine Nachricht, und die routet selbst.
//
// Genau dieser Empfaenger wird hier geprueft — mit einer echten Nachricht an
// `navigator.serviceWorker`, nicht mit einem nachgebauten Aufruf. Ohne den Test waere er die
// Sorte Code, die beim naechsten Umbau still verschwindet: Es gibt keine Oberflaeche dafuer,
// niemand klickt ihn versehentlich an, und der Fehler zeigt sich erst auf einem echten Handy.
//
//   node tests/meldung-klick-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3297, DB = '/tmp/meldung-klick.db', LOG = '/tmp/meldung-klick-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Eine Nachricht schicken, wie der Service Worker sie schickt, und abwarten.
const melden = async (seite, url) => {
  await seite.evaluate((u) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { typ: 'meldung-geklickt', url: u } }));
  }, url);
  await sleep(700);
  return seite.evaluate(() => location.hash);
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    seite.setDefaultTimeout(45000);
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pw);
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForSelector('a[href="#/statistics"]'); await sleep(800);

    console.log('── Der Empfänger ist überhaupt da ──');
    ok('die Seite kennt den Service Worker', await seite.evaluate(() => 'serviceWorker' in navigator));

    console.log('\n── Die Meldung führt in ihr Menü ──');
    await seite.evaluate(() => { location.hash = '/dashboard'; });
    await sleep(700);
    for (const [was, ziel, erwartet] of [
      ['Bestellung', '/#/orders', '#/orders'],
      ['Aushang', '/#/bulletin', '#/bulletin'],
      ['Abwesenheit', '/#/absences', '#/absences'],
      ['Planung', '/#/planning', '#/planning'],
    ]) {
      const nachher = await melden(seite, ziel);
      ok(`${was} → ${erwartet}`, nachher === erwartet, `steht auf ${nachher}`);
    }

    console.log('\n── Was NICHT passieren darf ──');
    // Die Zusammenfassung und die Testmeldung zeigen auf '/'. Sie haben kein eigenes Menue, und
    // wer gerade in einem Formular steckt, soll davon nicht weggerissen werden.
    await seite.evaluate(() => { location.hash = '/notes'; });
    await sleep(700);
    ok('ein Ziel „/" lässt die Ansicht stehen', (await melden(seite, '/')) === '#/notes',
      await seite.evaluate(() => location.hash));
    // Eine fremde Nachricht darf nichts ausloesen — sonst koennte jedes Skript die App umschalten.
    const vorher = await seite.evaluate(() => location.hash);
    await seite.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { typ: 'irgendwas', url: '/#/orders' } }));
    });
    await sleep(600);
    ok('eine fremde Nachricht bewirkt nichts', (await seite.evaluate(() => location.hash)) === vorher,
      await seite.evaluate(() => location.hash));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(`\nKlick auf die Meldung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
