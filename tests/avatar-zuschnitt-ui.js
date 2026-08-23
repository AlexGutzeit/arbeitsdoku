// Das Zuschnitt-Fenster im Browser: schieben, zoomen, mit dem Finger bedienen (Alex, 23.08.2026).
//
// Der Server nimmt das Rechteck entgegen (avatar-zuschnitt.js beweist das an den Bildpunkten).
// Hier geht es um die Frage davor: Kommt aus dem, was der Nutzer im Kreis sieht, auch wirklich
// das heraus, was er sieht?
//
// Geprüft wird mit einem Bild aus vier verschiedenfarbigen Vierteln. Wird das Bild so geschoben,
// dass ein bestimmtes Viertel im Kreis steht, MUSS der Avatar danach diese Farbe haben — das ist
// an der Farbe ablesbar und nicht Auslegungssache.
//
// Der Handy-Fall ist kein Nebenschauplatz: `touch-action: none` auf der Bühne entscheidet
// darüber, ob der Finger das Bild verschiebt oder die Seite scrollt. Ohne das wäre der Dialog
// am Handy unbedienbar — deshalb steht das hier als eigene Zeile.
//
//   node tests/avatar-zuschnitt-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3274, DB = '/tmp/avatar-zuschnitt-ui.db', BASIS = `http://localhost:${PORT}`;
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
function holen(p, t) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'GET', headers: t ? { Authorization: 'Bearer ' + t } : {} },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(teile) })); });
    r.on('error', rej); r.end();
  });
}

const BREITE = 900, HOEHE = 900;
const VIERTEL = {
  'links oben':   { r: 220, g: 30,  b: 30,  x: 0,        y: 0 },
  'rechts oben':  { r: 30,  g: 120, b: 220, x: BREITE/2, y: 0 },
  'links unten':  { r: 240, g: 200, b: 20,  x: 0,        y: HOEHE/2 },
  'rechts unten': { r: 30,  g: 170, b: 90,  x: BREITE/2, y: HOEHE/2 },
};
const DATEI = '/tmp/avatar-zuschnitt-ui-quelle.png';
async function testbildSchreiben() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BREITE}" height="${HOEHE}">${
    Object.values(VIERTEL).map(v => `<rect x="${v.x}" y="${v.y}" width="${BREITE/2}" height="${HOEHE/2}" fill="rgb(${v.r},${v.g},${v.b})"/>`).join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(DATEI);
}
async function farbeInDerMitte(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
  let beste = null, abstand = 1e9;
  for (const [name, v] of Object.entries(VIERTEL)) {
    const d = Math.abs(p.r - v.r) + Math.abs(p.g - v.g) + Math.abs(p.b - v.b);
    if (d < abstand) { abstand = d; beste = name; }
  }
  return { name: beste, pixel: p };
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  await testbildSchreiben();
  const lg = fs.openSync('/tmp/avatar-zuschnitt-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/avatar-zuschnitt-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 460, height: 950, hasTouch: true });
    page.setDefaultTimeout(30000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);

    const konto = async () => {
      await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#avatar-datei'); await sleep(1800);
    };
    const dialogOeffnen = async () => {
      await (await page.$('#avatar-datei')).uploadFile(DATEI);
      await page.waitForSelector('#zs-buehne img', { timeout: 20000 });
      await page.waitForFunction(() => !document.getElementById('zs-ok').disabled, { timeout: 20000 });
      await sleep(400);
    };
    // Schieben ueber echte Zeiger-Ereignisse; `zeigerTyp` unterscheidet Maus und Finger.
    const schieben = (dx, dy, zeigerTyp = 'mouse') => page.evaluate((dx, dy, typ) => {
      const b = document.getElementById('zs-buehne');
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const bau = (art, cx, cy) => new PointerEvent(art, { pointerId: 1, pointerType: typ, isPrimary: true,
        clientX: cx, clientY: cy, bubbles: true, cancelable: true });
      b.dispatchEvent(bau('pointerdown', x, y));
      for (let i = 1; i <= 10; i++) b.dispatchEvent(bau('pointermove', x + dx * i / 10, y + dy * i / 10));
      b.dispatchEvent(bau('pointerup', x + dx, y + dy));
    }, dx, dy, zeigerTyp);
    const uebernehmen = async () => {
      await page.click('.zuschnitt-modal [data-act="ok"]');
      await sleep(2600);
    };

    console.log('── Das Fenster geht auf, bevor irgendetwas hochgeladen wird ──');
    await konto();
    await dialogOeffnen();
    ok('die Bühne mit dem Bild ist da', !!(await page.$('#zs-buehne img')));
    ok('der runde Rahmen liegt darüber', !!(await page.$('.zuschnitt-maske')));
    ok('es gibt eine große und eine kleine Vorschau',
      !!(await page.$('#zs-vorschau-gross')) && !!(await page.$('#zs-vorschau-klein')));
    ok('… und beide zeigen schon etwas',
      await page.evaluate(() => /^url\(/.test(getComputedStyle(document.getElementById('zs-vorschau-gross')).backgroundImage)));
    ok('am Handy schiebt der Finger das Bild statt die Seite (touch-action: none)',
      (await page.evaluate(() => getComputedStyle(document.getElementById('zs-buehne')).touchAction)) === 'none');
    ok('bis hierher wurde NICHTS gespeichert',
      Object.keys((await req('GET', '/api/avatare', max.token)).body.stand).length === 0);

    console.log('\n── Abbrechen lädt nichts hoch ──');
    await page.click('.zuschnitt-modal [data-act="cancel"]');
    await sleep(900);
    ok('das Fenster ist zu', !(await page.$('#zs-buehne')));
    ok('… und es gibt weiterhin kein Bild',
      Object.keys((await req('GET', '/api/avatare', max.token)).body.stand).length === 0);

    console.log('\n── Ohne Schieben: die Mitte des Bildes ──');
    await dialogOeffnen();
    await uebernehmen();
    let f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    // Genau im Kreuzungspunkt der vier Viertel — welches gewinnt, ist Rundung. Geprüft wird
    // deshalb nur, dass ÜBERHAUPT gespeichert wurde; die Richtungsprobe kommt gleich.
    ok('ein Bild ist gespeichert', !!(await req('GET', '/api/avatare', max.token)).body.stand[String(max.user.id)]);
    const ohneSchieben = f.name;
    console.log(`     (Mitte trifft: ${ohneSchieben})`);

    console.log('\n── Mit der Maus nach LINKS UNTEN schieben ──');
    // Bewusst ein Viertel, das die Mitte NICHT trifft — sonst waere die Zeile gruen, ohne dass
    // das Schieben irgendetwas bewirkt haette. Das Bild nach rechts und oben ziehen heisst:
    // der Kreis wandert nach links und unten.
    await konto();
    await dialogOeffnen();
    await page.evaluate(() => { const r = document.getElementById('zs-zoom'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    await schieben(400, -400, 'mouse');
    await sleep(300);
    await uebernehmen();
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('„links unten" steht im Kreis', f.name === 'links unten', `${f.name} ${JSON.stringify(f.pixel)}`);
    ok('… und das ist ein ANDERES Viertel als ohne Schieben', f.name !== ohneSchieben,
      `ohne Schieben: ${ohneSchieben}, danach: ${f.name}`);

    console.log('\n── Und mit dem Finger nach links oben ──');
    await konto();
    await dialogOeffnen();
    await page.evaluate(() => { const r = document.getElementById('zs-zoom'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    await schieben(400, 400, 'touch');
    await sleep(300);
    await uebernehmen();
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('„links oben" steht im Kreis', f.name === 'links oben', `${f.name} ${JSON.stringify(f.pixel)}`);

    console.log('\n── Ausschnitt später ändern, ohne das Foto zu suchen ──');
    await konto();
    ok('der Knopf ist da, weil ein Bild vorliegt', !!(await page.$('#avatar-ausschnitt')));
    await page.click('#avatar-ausschnitt');
    await page.waitForSelector('#zs-buehne img', { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('zs-ok').disabled, { timeout: 20000 });
    await sleep(500);
    ok('das Original wird geladen (die Bühne zeigt das ganze Bild)',
      await page.evaluate(() => { const i = document.getElementById('zs-bild'); return i.naturalWidth === i.naturalHeight && i.naturalWidth > 400; }),
      await page.evaluate(() => { const i = document.getElementById('zs-bild'); return `${i.naturalWidth}x${i.naturalHeight}`; }));
    await page.evaluate(() => { const r = document.getElementById('zs-zoom'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(300);
    await schieben(-400, 400, 'mouse');
    await sleep(300);
    await uebernehmen();
    f = await farbeInDerMitte((await holen(`/api/avatare/${max.user.id}`, max.token)).buf);
    ok('jetzt steht „rechts oben" im Kreis', f.name === 'rechts oben', `${f.name} ${JSON.stringify(f.pixel)}`);

    console.log('\n── Die Sicherheitsrichtlinie beschwert sich nicht ──');
    const meckern = [];
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) meckern.push(m.text()); });
    await konto();
    await page.click('#avatar-ausschnitt');
    await page.waitForSelector('#zs-buehne img'); await sleep(1200);
    ok('keine CSP-Verletzung in der Konsole', meckern.length === 0, meckern.join(' | ').slice(0, 140));
    await page.click('.zuschnitt-modal [data-act="cancel"]');

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.unlinkSync(DATEI); } catch (_) {}
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nZuschnitt-Fenster: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
