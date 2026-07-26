// Puppeteer-Test (B7): Details per langem Druck auf dem Handy.
//  - lange gedrueckt  -> Sprechblase mit Kunde/Ort/Beschreibung, KEIN Formular
//  - kurz getippt     -> oeffnet wie bisher (Zeitnachweis: Bearbeiten, Planung: Uebernehmen)
//  - gewischt         -> nichts passiert (Scrollen darf nicht ausloesen)
//  - der Riegel sperrt nur den EINEN Klick nach dem langen Druck, nicht spaetere
// Start: node tests/longpress-details-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3134, DB = '/tmp/longpress.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const today = new Date().toLocaleDateString('sv-SE');

// Mitte eines Elements, ins Bild geholt
async function mitte(p, sel) {
  return p.evaluate(s => {
    const el = document.querySelector(s); if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);
}
const blase = p => p.evaluate(() => {
  const t = document.querySelector('.entry-tooltip');
  return (t && t.style.display !== 'none') ? t.textContent : '';
});
const route = p => p.evaluate(() => location.hash);

async function langerDruck(p, pt, ms = 800) {
  await p.touchscreen.touchStart(pt.x, pt.y);
  await sleep(ms);
  await p.touchscreen.touchEnd();
  await sleep(500);
}
async function kurzerTipp(p, pt) {
  await p.touchscreen.touchStart(pt.x, pt.y);
  await sleep(80);
  await p.touchscreen.touchEnd();
  await sleep(900);
}
async function wischen(p, pt) {
  await p.touchscreen.touchStart(pt.x, pt.y);
  await sleep(120);
  await p.touchscreen.touchMove(pt.x, pt.y - 60);
  await sleep(800);
  await p.touchscreen.touchEnd();
  await sleep(400);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/longpress-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/longpress-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'lpma', password: 'Test1234!', name: 'Longpress MA', role: 'mitarbeiter' })).body.user;
    const e1 = await req('POST', '/api/entries', admin, { date: today, time_from: '07:00', time_to: '16:00', break_minutes: 30,
      address: 'Ahornweg 7, Musterstadt', client: 'Bauer GmbH', description: 'Zaehlerschrank tauschen', user_id: ma.id });
    ok('Testeintrag angelegt', e1.status === 201 || e1.status === 200, e1.status + '');
    const p1 = await req('POST', '/api/planning', admin, { days: [{ date: today, time_from: '08:00', time_to: '15:00' }],
      address: 'Lindenstr. 3', client: 'Planungskunde AG', description: 'Unterverteilung setzen', assigned_user_ids: [ma.id] });
    ok('Testplanung angelegt', p1.status === 201 || p1.status === 200, p1.status + '');

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(600);
    ok('Touch-Geraet erkannt', await p.evaluate(() => matchMedia('(pointer: coarse)').matches));

    // ── Zeitnachweis ──────────────────────────────────────────────────────
    console.log('Zeitnachweis:');
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2200);
    let pt = await mitte(p, '.tl-entry[data-entry-id]');
    ok('Eintrag in der Zeitleiste da', !!pt, JSON.stringify(pt));

    await langerDruck(p, pt);
    const txt = await blase(p);
    ok('langer Druck zeigt die Details', /Bauer GmbH/.test(txt) && /Ahornweg/.test(txt), JSON.stringify(txt.slice(0, 90)));
    ok('… und die Beschreibung steht drin', /Zaehlerschrank|Zählerschrank/.test(txt), JSON.stringify(txt.slice(0, 120)));
    ok('… OHNE das Bearbeiten-Formular zu oeffnen', !/#\/entry\//.test(await route(p)), await route(p));

    // Sprechblase weg + der NAECHSTE Tipp muss wieder ganz normal wirken
    await p.evaluate(() => hideTooltip()); await sleep(1200);
    pt = await mitte(p, '.tl-entry[data-entry-id]');
    await kurzerTipp(p, pt);
    ok('kurzer Tipp oeffnet weiterhin das Bearbeiten', /#\/entry\//.test(await route(p)), await route(p));

    // Wischen (Scrollen) darf nichts ausloesen
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2200);
    // Erst positionieren, DANN die Sprechblase schliessen: das scrollIntoView des Testhelfers
    // laesst im Headless-Browser einen Phantom-Mauszeiger ueber den Eintrag gleiten und loest
    // dadurch selbst ein mouseenter aus. Auf einem echten Handy gibt es keinen Zeiger.
    pt = await mitte(p, '.tl-entry[data-entry-id]');
    await sleep(300);
    await p.evaluate(() => hideTooltip());
    await wischen(p, pt);
    ok('Wischen zeigt keine Sprechblase', (await blase(p)) === '', JSON.stringify((await blase(p)).slice(0, 60)));
    ok('Wischen oeffnet auch kein Formular', !/#\/entry\//.test(await route(p)), await route(p));

    // ── Planung: dort ging der Klick nach dem langen Druck bisher durch ────
    console.log('Planung:');
    await p.evaluate(() => { location.hash = '#/planning'; }); await sleep(2600);
    await p.evaluate(() => hideTooltip());
    pt = await mitte(p, '.tl-plan-entry[data-planning-id]');
    ok('Planungstermin da', !!pt, JSON.stringify(pt));
    await langerDruck(p, pt);
    const txtP = await blase(p);
    ok('langer Druck zeigt die Planungsdetails', /Planungskunde AG/.test(txtP), JSON.stringify(txtP.slice(0, 90)));
    ok('… und uebernimmt den Termin NICHT (war vorher der Fall)', !/accept/.test(await route(p)), await route(p));

    await p.evaluate(() => hideTooltip()); await sleep(1200);
    pt = await mitte(p, '.tl-plan-entry[data-planning-id]');
    await kurzerTipp(p, pt);
    ok('kurzer Tipp uebernimmt den Termin weiterhin', /accept/.test(await route(p)), await route(p));

    // ── Gegenprobe am Rechner: der Maus-Tooltip muss weiter funktionieren ──
    // Die Sperre gegen Maus-Ersatzereignisse darf echtes Drueberfahren nicht schlucken.
    console.log('Gegenprobe mit Maus:');
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1280, height: 800 });   // kein hasTouch -> echte Maus
    await p2.goto(BASE, { waitUntil: 'networkidle2' });
    // Gleicher Browser-Kontext -> die Anmeldung aus dem ersten Tab gilt schon.
    if (await p2.$('#login-user')) {
      await p2.type('#login-user', 'admin'); await p2.type('#login-pass', apw);
      await p2.click('#login-form button[type="submit"]');
    }
    await p2.waitForSelector('a[href="#/planning"]'); await sleep(600);
    await p2.evaluate(() => { location.hash = '#/'; }); await sleep(2200);
    await p2.evaluate(() => hideTooltip());
    const ptM = await mitte(p2, '.tl-entry[data-entry-id]');
    ok('Eintrag am Rechner da', !!ptM, JSON.stringify(ptM));
    await p2.mouse.move(ptM.x - 40, ptM.y - 40);
    await p2.mouse.move(ptM.x, ptM.y);
    await sleep(500);
    const txtM = await blase(p2);
    ok('Maus: Drueberfahren zeigt die Details weiterhin', /Bauer GmbH/.test(txtM), JSON.stringify(txtM.slice(0, 80)));
    await p2.mouse.move(5, 5); await sleep(400);
    ok('Maus: Wegfahren blendet wieder aus', (await blase(p2)) === '', JSON.stringify((await blase(p2)).slice(0, 60)));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLanger Druck (B7): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
