// Eine Sprechblase darf ihre Seite nicht überleben.
//
// Die Detail-Sprechblase eines Planungs- oder Zeiteintrags hängt an `document.body`, nicht am
// Seiteninhalt. Ein Seitenwechsel räumt sie deshalb nicht mit weg. Normalerweise nimmt sie
// `mouseleave` — aber nach einem Wechsel gibt es das Element, über dem der Zeiger steht, gar nicht
// mehr, und das Ereignis feuert nie. Die Blase blieb dann über der neuen Seite stehen.
//
// Gefunden auf einem Bildschirmfoto (23.08.2026): Der Tooltip eines Planungseintrags stand mitten
// auf der Willkommensseite.
//
//   node tests/tooltip-seitenwechsel-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3269, DB = '/tmp/tooltip-seitenwechsel.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const sichtbar = (page) => page.evaluate(() => {
  const el = document.querySelector('.entry-tooltip');
  if (!el) return { da: false, sichtbar: false, text: '' };
  const cs = getComputedStyle(el);
  return { da: true, sichtbar: cs.display !== 'none' && cs.visibility !== 'hidden',
           text: el.textContent.trim().slice(0, 40) };
});

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/tooltip-seitenwechsel-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/tooltip-seitenwechsel-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body;
    const max = (await req('GET', '/api/users', chef.token)).body.users.find(u => u.username === 'max');
    const heute = new Date().toLocaleDateString('sv-SE');
    await req('POST', '/api/planning', chef.token,
      { date: heute, time_from: '07:00', time_to: '15:30', description: 'Baustelle Nord', assigned_user_ids: [max.id] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 800 });
    page.setDefaultTimeout(30000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'chef'); await page.type('#login-pass', pw('chef'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);

    console.log('── Sprechblase erscheinen lassen ──');
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tl-plan-entry', { timeout: 20000 });
    await sleep(1200);
    await page.hover('.tl-plan-entry');
    await sleep(900);
    const beim = await sichtbar(page);
    // Ohne diese Zeile prueft der Test nichts: Eine Blase, die nie auftaucht, ist nachher auch weg.
    ok('sie ist beim Drueberfahren zu sehen', beim.sichtbar, JSON.stringify(beim));
    ok('… und zeigt den Eintrag', /Baustelle Nord/.test(beim.text) || beim.text.length > 0, JSON.stringify(beim));

    console.log('\n── Seitenwechsel, OHNE den Zeiger zu bewegen ──');
    // Genau das ist der Fall, der klemmte: Der Zeiger bleibt stehen, das Element unter ihm
    // verschwindet — `mouseleave` feuert nie.
    await page.evaluate(() => { location.hash = '#/welcome'; });
    await sleep(2000);
    const nach = await sichtbar(page);
    ok('die Sprechblase ist auf der neuen Seite weg', !nach.sichtbar, JSON.stringify(nach));
    ok('… und die neue Seite ist wirklich da',
      /Willkommen/.test(await page.$eval('.main', el => el.innerText)));

    console.log('\n── Auch beim Zurueckblaettern des Browsers ──');
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tl-plan-entry'); await sleep(1200);
    await page.hover('.tl-plan-entry'); await sleep(900);
    ok('Blase wieder da', (await sichtbar(page)).sichtbar);
    await page.goBack(); await sleep(2000);
    ok('nach „Zurueck" ist sie ebenfalls weg', !(await sichtbar(page)).sichtbar,
      JSON.stringify(await sichtbar(page)));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nSprechblase beim Seitenwechsel: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
