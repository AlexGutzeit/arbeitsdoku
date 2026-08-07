// Aushänge auf der Willkommensseite sind anklickbar (Alex, 07.08.2026).
//
// Zwei Wünsche in einem Test:
//   1. Antippen eines Aushangs führt zum Schwarzen Brett — und dort ZU DIESEM Eintrag, nicht
//      einfach an den Seitenanfang.
//   2. „Bearbeiten"/„Löschen" am Aushang sind dezente Symbole (✎ / ×) statt breiter Text-Knöpfe,
//      wie überall sonst in der App.
//
// Damit Punkt 1 überhaupt etwas aussagt, liegen MEHRERE Aushänge auf dem Brett und angetippt wird
// der UNTERSTE — bei nur einem wäre „richtig gesprungen" nicht von „zufällig oben gelandet" zu
// unterscheiden.
//
//   node tests/aushang-sprung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3229, DB = '/tmp/aushang-sprung.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const heute = () => new Date().toLocaleDateString('sv-SE');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/aushang-sprung-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/aushang-sprung-srv.log', 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body;

    // Drei Aushänge, alle von heute (nur dann zeigt die Willkommensseite sie an).
    const ids = [];
    for (const titel of ['Erster Aushang', 'Zweiter Aushang', 'Dritter Aushang']) {
      const r = await req('POST', '/api/bulletin', chef.token, { title: titel, text: 'Inhalt von ' + titel });
      if (r.status >= 300) throw new Error('Aushang: ' + r.text);
      ids.push((r.body.entry || r.body).id);
    }
    console.log(`   drei Aushänge angelegt (ids ${ids.join(', ')})\n`);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 500, height: 800 });  // Handy-Format
    page.setDefaultTimeout(45000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'chef'); await page.type('#login-pass', pw('chef'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);

    console.log('── Willkommensseite ──');
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.welcome-page'); await sleep(1200);
    const anzahl = await page.$$eval('[data-aushang]', els => els.length);
    ok('die Aushänge sind als anklickbare Felder gerendert', anzahl === 3, String(anzahl));
    const rolle = await page.$eval('[data-aushang]', el => ({ role: el.getAttribute('role'), tab: el.getAttribute('tabindex'), label: el.getAttribute('aria-label') }));
    ok('… mit Tastatur-Bedienbarkeit (role + tabindex + Beschriftung)',
      rolle.role === 'button' && rolle.tab === '0' && /Schwarzen Brett/.test(rolle.label || ''), JSON.stringify(rolle));

    console.log('\n── Antippen führt zum richtigen Eintrag ──');
    // Bewusst den UNTERSTEN antippen.
    const letzteId = await page.$$eval('[data-aushang]', els => els[els.length - 1].dataset.aushang);
    await page.evaluate(() => { const e = document.querySelectorAll('[data-aushang]'); e[e.length - 1].click(); });
    await page.waitForFunction(() => location.hash === '#/bulletin', { timeout: 15000 });
    await page.waitForSelector('.bulletin-card'); await sleep(1600);
    ok('Route ist jetzt das Schwarze Brett', (await page.evaluate(() => location.hash)) === '#/bulletin');

    const zustand = await page.evaluate((id) => {
      const k = document.querySelector(`.bulletin-card[data-id="${id}"]`);
      if (!k) return { da: false };
      const r = k.getBoundingClientRect();
      return { da: true, hervor: k.classList.contains('bulletin-card--hervor'),
               sichtbar: r.top >= 0 && r.bottom <= window.innerHeight + 5 };
    }, letzteId);
    ok('der angetippte Aushang ist hervorgehoben', zustand.hervor, JSON.stringify(zustand));
    ok('… und im Sichtbereich (es wurde wirklich hingescrollt)', zustand.sichtbar, JSON.stringify(zustand));

    // Gegenprobe: Ohne Sprung landet man oben — sonst wäre „sichtbar" nichtssagend.
    await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' }); await sleep(800);
    await page.goto(BASIS + '/#/bulletin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bulletin-card'); await sleep(1200);
    const ohneSprung = await page.evaluate((id) => {
      const k = document.querySelector(`.bulletin-card[data-id="${id}"]`);
      const r = k.getBoundingClientRect();
      return { hervor: k.classList.contains('bulletin-card--hervor'), oben: r.top >= 0 && r.bottom <= window.innerHeight + 5 };
    }, letzteId);
    ok('Gegenprobe: direkt aufgerufen ist derselbe Eintrag NICHT hervorgehoben', !ohneSprung.hervor, JSON.stringify(ohneSprung));

    console.log('\n── Dezente Symbole statt Text-Knöpfe ──');
    const knoepfe = await page.evaluate(() => {
      const b = document.querySelector('.bulletin-actions .edit-bulletin');
      const d = document.querySelector('.bulletin-actions .del-bulletin');
      const br = b.getBoundingClientRect();
      return { edit: b.textContent.trim(), del: d.textContent.trim(),
               titel: b.getAttribute('title'), breite: Math.round(br.width) };
    });
    ok('Bearbeiten ist ein Bleistift-Zeichen', knoepfe.edit === '✎', JSON.stringify(knoepfe));
    ok('Löschen ist ein ×', knoepfe.del === '×', JSON.stringify(knoepfe));
    ok('… mit Beschriftung fürs Antippen und für Screenreader', knoepfe.titel === 'Bearbeiten', JSON.stringify(knoepfe));
    ok('… und schmal statt breit (unter 60 px)', knoepfe.breite < 60, `${knoepfe.breite} px`);

    // Beide Symbole muessen SICHTBAR sein. Der Loeschen-Knopf trug frueher btn-danger: Die Regel
    // .bulletin-actions button nimmt den roten Hintergrund weg, die weisse Schrift blieb — weiss
    // auf weiss. Man sah ihn schlicht nicht. Deshalb hier die gerenderten Farben vergleichen.
    const sichtbarkeit = await page.evaluate(() => {
      const karte = getComputedStyle(document.querySelector('.bulletin-card')).backgroundColor;
      const werte = ['.edit-bulletin', '.del-bulletin'].map(sel => {
        const el = document.querySelector('.bulletin-actions ' + sel);
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { sel, farbe: st.color, hintergrund: st.backgroundColor, breit: r.width > 0, hoch: r.height > 0 };
      });
      return { karte, werte };
    });
    for (const w of sichtbarkeit.werte) {
      ok(`${w.sel}: hat eine Fläche`, w.breit && w.hoch, JSON.stringify(w));
      const durchsichtig = /rgba\(0, 0, 0, 0\)|transparent/.test(w.hintergrund);
      const eigenerHintergrund = !durchsichtig;
      ok(`${w.sel}: Schriftfarbe hebt sich von der Karte ab`,
        eigenerHintergrund || w.farbe !== sichtbarkeit.karte,
        `Schrift ${w.farbe} auf ${eigenerHintergrund ? w.hintergrund : sichtbarkeit.karte}`);
    }

    // Und beide stehen NEBEN dem Titel, nicht darunter (am Handy sah das aus wie eine zweite Zeile).
    const nebeneinander = await page.evaluate(() => {
      const t = document.querySelector('.bulletin-title').getBoundingClientRect();
      const a = document.querySelector('.bulletin-actions').getBoundingClientRect();
      return { titelMitte: t.top + t.height / 2, aktionenMitte: a.top + a.height / 2, abstand: Math.abs((t.top + t.height / 2) - (a.top + a.height / 2)) };
    });
    ok('Symbole stehen neben dem Titel, nicht darunter', nebeneinander.abstand < 20, JSON.stringify(nebeneinander));
    ok('das Wort „Bearbeiten" steht nicht mehr sichtbar in der Karte',
      !(await page.$eval('.bulletin-card', el => el.innerText)).includes('Bearbeiten'));

    console.log('\n── Der Knopf tut noch, was er soll ──');
    await page.click('.bulletin-actions .edit-bulletin');
    await page.waitForFunction(() => /#\/bulletin\/edit\//.test(location.hash), { timeout: 15000 });
    ok('Bleistift öffnet weiterhin das Bearbeiten-Formular', /#\/bulletin\/edit\//.test(await page.evaluate(() => location.hash)));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAushang-Sprung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
