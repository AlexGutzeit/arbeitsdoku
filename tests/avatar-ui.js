// Profilbilder in der Oberfläche: hochladen, in der Kopfzeile sehen, wieder entfernen.
//
// Der unscheinbare, aber entscheidende Prüfpunkt: Die Bilder liegen hinter der Anmeldung und
// werden per fetch geholt — angezeigt werden sie als blob:-Adresse. Das erlaubt die
// Sicherheitsrichtlinie nur, weil `blob:` dort ausdrücklich steht. Fehlt es, verwirft der Browser
// das Bild STUMM: kein Fehler im Code, nur ein leerer Kreis. Deshalb wird hier geprüft, dass die
// Konsole keine Verletzung meldet UND dass wirklich ein Bild gesetzt wurde.
//
// Zweiter Punkt: Wer kein Bild hat, bekommt Initialen in seiner Personenfarbe — die Oberfläche
// darf also nie leer wirken, auch wenn niemand ein Bild hochlädt.
//
//   node tests/avatar-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3258, DB = '/tmp/avatar-ui.db', BASIS = `http://localhost:${PORT}`;
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  const bildDatei = '/tmp/avatar-ui-testbild.png';
  fs.writeFileSync(bildDatei, await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 220, g: 60, b: 60 } } }).png().toBuffer());

  const lg = fs.openSync('/tmp/avatar-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/avatar-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 900 });
    page.setDefaultTimeout(45000);
    const meldungen = [];
    page.on('console', m => { if (m.type() === 'error') meldungen.push(m.text()); });
    page.on('pageerror', e => meldungen.push('Seitenfehler: ' + String(e)));

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2200);

    console.log('── Ohne Bild: Initialen in der Personenfarbe ──');
    const anfang = await page.evaluate(() => {
      const a = document.querySelector('#kopf-avatar .avatar');
      if (!a) return null;
      const st = getComputedStyle(a);
      return { text: a.textContent.trim(), farbe: st.backgroundColor, bild: st.backgroundImage,
               rund: st.borderRadius, breite: Math.round(a.getBoundingClientRect().width) };
    });
    ok('in der Kopfzeile steht ein Avatar', !!anfang, JSON.stringify(anfang));
    ok('… mit den Initialen', anfang.text === 'MM', JSON.stringify(anfang));   // Max Mustermann
    ok('… farbig hinterlegt (nicht durchsichtig)', !/rgba\(0, 0, 0, 0\)/.test(anfang.farbe), anfang.farbe);
    ok('… rund', /50%|\d+px/.test(anfang.rund) && anfang.breite > 10, JSON.stringify(anfang));
    ok('… und ohne Bild', anfang.bild === 'none', anfang.bild);

    console.log('\n── Bild hochladen ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatar-waehlen'); await sleep(800);
    const eingabe = await page.$('#avatar-datei');
    await eingabe.uploadFile(bildDatei);
    await sleep(3000);
    const nachher = await page.evaluate(() => {
      const v = document.querySelector('#avatar-vorschau .avatar');
      const k = document.querySelector('#kopf-avatar .avatar');
      const lies = el => el ? { bild: getComputedStyle(el).backgroundImage, text: el.textContent.trim() } : null;
      return { vorschau: lies(v), kopf: lies(k) };
    });
    ok('die Vorschau zeigt ein Bild', /blob:/.test((nachher.vorschau || {}).bild || ''), JSON.stringify(nachher.vorschau));
    ok('… und die Initialen sind daraus verschwunden', (nachher.vorschau || {}).text === '', JSON.stringify(nachher.vorschau));
    ok('die Kopfzeile zieht sofort mit', /blob:/.test((nachher.kopf || {}).bild || ''), JSON.stringify(nachher.kopf));

    const verstoss = meldungen.filter(m => /Content Security Policy|Refused to load/i.test(m));
    ok('die Sicherheitsrichtlinie erlaubt das Bild (keine Verletzung in der Konsole)',
      verstoss.length === 0, verstoss.slice(0, 2).join(' | '));

    console.log('\n── Nach einem Neuladen ist es immer noch da ──');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const nachReload = await page.evaluate(() => {
      const k = document.querySelector('#kopf-avatar .avatar');
      return k ? getComputedStyle(k).backgroundImage : null;
    });
    ok('Bild in der Kopfzeile', /blob:/.test(nachReload || ''), String(nachReload));

    console.log('\n── Entfernen ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#avatar-weg'); await sleep(700);
    await page.click('#avatar-weg');
    await sleep(2200);
    const weg = await page.evaluate(() => {
      const v = document.querySelector('#avatar-vorschau .avatar');
      const k = document.querySelector('#kopf-avatar .avatar');
      return { vorschau: v ? { bild: getComputedStyle(v).backgroundImage, text: v.textContent.trim() } : null,
               kopf: k ? k.textContent.trim() : null };
    });
    ok('die Vorschau zeigt wieder Initialen', (weg.vorschau || {}).text === 'MM' && (weg.vorschau || {}).bild === 'none',
      JSON.stringify(weg.vorschau));
    ok('… und die Kopfzeile ebenfalls', weg.kopf === 'MM', String(weg.kopf));
    ok('der Knopf heißt wieder „Bild hochladen"',
      /Bild hochladen/.test(await page.$eval('#avatar-waehlen', el => el.textContent)));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(bildDatei); } catch (_) {}
  }
  console.log(`\nProfilbilder (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
