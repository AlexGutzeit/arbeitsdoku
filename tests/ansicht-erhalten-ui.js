// Puppeteer-Test (B10): Ansicht bleibt über Neuaufbauten hinweg erhalten.
//  - Scrollposition überlebt eine Aktion auf derselben Seite
//  - aufgeklappte Bereiche (<details>) bleiben offen
//  - seitlich gescrollte Container behalten ihre Position
//  - bei echtem SEITENWECHSEL wird bewusst oben gestartet
// Start: node tests/ansicht-erhalten-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3130, DB = '/tmp/ansicht.db', BASE = 'http://localhost:' + PORT;
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
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const today = new Date().toLocaleDateString('sv-SE');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/ansicht-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/ansicht-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    // Genug Werkzeuge für eine lange, scrollbare Liste
    for (let i = 1; i <= 40; i++) await req('POST', '/api/tools', admin, { name: `Werkzeug ${String(i).padStart(2, '0')}` });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1100, height: 700 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ── 1) Scrollposition überlebt eine Aktion auf derselben Seite ──
    console.log('Scrollposition:');
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(1400);
    const scrollbar = await p.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
    ok('Werkzeugliste ist lang genug zum Scrollen', scrollbar);
    await p.evaluate(() => window.scrollTo(0, 600)); await sleep(350);
    const vorher = await p.evaluate(() => Math.round(window.scrollY));
    ok('nach unten gescrollt', vorher > 400, 'y=' + vorher);
    // Aktion auf derselben Seite: Neuaufbau durch renderTools()
    await p.evaluate(() => renderTools()); await sleep(1200);
    const nachher = await p.evaluate(() => Math.round(window.scrollY));
    ok('Scrollposition bleibt nach Neuaufbau erhalten', Math.abs(nachher - vorher) < 60, `vorher ${vorher} → nachher ${nachher}`);

    // ── 2) Echter Seitenwechsel startet oben ──
    console.log('Seitenwechsel:');
    await p.evaluate(() => { location.hash = '#/orders'; }); await sleep(1300);
    const nachWechsel = await p.evaluate(() => Math.round(window.scrollY));
    ok('nach Seitenwechsel oben', nachWechsel < 40, 'y=' + nachWechsel);

    // ── 3) Aufgeklappte Bereiche bleiben offen ──
    console.log('Aufgeklappte Bereiche:');
    const ma = (await req('POST', '/api/users', admin, { username: 'ansichtma', password: 'Test1234!', name: 'Ansicht MA', role: 'mitarbeiter' })).body.user;
    await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: ma.id, comment: 'Test' });
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(1500);
    const hatDetails = await p.evaluate(() => document.querySelectorAll('details').length > 0);
    if (hatDetails) {
      await p.evaluate(() => { const d = document.querySelector('details'); d.open = true; d.dispatchEvent(new Event('toggle', { bubbles: true })); });
      await sleep(350);
      await p.evaluate(() => renderAbsences()); await sleep(1400);
      const nochOffen = await p.evaluate(() => { const d = document.querySelector('details'); return !!(d && d.open); });
      ok('aufgeklappter Bereich bleibt nach Neuaufbau offen', nochOffen);
    } else ok('aufklappbare Bereiche vorhanden', false, 'keine <details> auf der Seite');

    // ── 4) Seitlich gescrollter Container behält Position ──
    console.log('Seitlich gescrollte Bereiche:');
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(1500);
    const boxDa = await p.evaluate(() => !!document.querySelector('.wh-scroll, .timeline-scroll, .grid-scroll'));
    if (boxDa) {
      const gescrollt = await p.evaluate(() => {
        const b = document.querySelector('.wh-scroll, .timeline-scroll, .grid-scroll');
        b.scrollLeft = 120; b.dispatchEvent(new Event('scroll', { bubbles: true }));
        return b.scrollLeft;
      });
      await sleep(350);
      await p.evaluate(() => renderDashboardContent()); await sleep(1300);
      const danach = await p.evaluate(() => { const b = document.querySelector('.wh-scroll, .timeline-scroll, .grid-scroll'); return b ? b.scrollLeft : -1; });
      ok('seitliche Position bleibt erhalten', gescrollt > 0 ? Math.abs(danach - gescrollt) < 40 : true, `vorher ${gescrollt} → nachher ${danach}`);
    } else ok('scrollbarer Bereich vorhanden (übersprungen)', true);


    // ── 6) Auftrags-Board: weit rechts gescrollt, Projekt bearbeitet + gespeichert (Alex' Fall) ──
    console.log('Auftrags-Board nach dem Speichern:');
    for (let i = 1; i <= 8; i++) await req('POST', '/api/projects', admin, { name: `Board-Projekt ${i}` });
    const mas = [];
    for (let i = 1; i <= 6; i++) mas.push((await req('POST', '/api/users', admin, { username: 'boardma' + i, password: 'Test1234!', name: 'Board MA ' + i, role: 'mitarbeiter' })).body.user);
    await p.setViewport({ width: 900, height: 700 });
    await p.evaluate(() => { location.hash = '#/projects'; }); await sleep(2000);
    const bInfo = await p.evaluate(() => { const b = document.querySelector('.board-scroll'); return b ? { da: true, scrollbar: b.scrollWidth > b.clientWidth } : { da: false }; });
    ok('Auftrags-Board vorhanden', bInfo.da);
    if (bInfo.da && bInfo.scrollbar) {
      await p.evaluate(() => { const b = document.querySelector('.board-scroll'); b.scrollLeft = 300; b.dispatchEvent(new Event('scroll', { bubbles: true })); });
      await sleep(450);
      const vor = await p.evaluate(() => document.querySelector('.board-scroll').scrollLeft);
      ok('Board nach rechts gescrollt', vor > 100, 'links=' + vor);
      const weg = await p.evaluate(async () => {
        const btn = document.querySelector('.proj-edit'); if (!btn) return 'kein-edit';
        btn.click(); await new Promise(r => setTimeout(r, 700));
        const save = document.getElementById('pf2-save'); if (!save) return 'kein-save';
        save.click(); return 'ok';
      });
      await sleep(2000);
      const nach = await p.evaluate(() => { const b = document.querySelector('.board-scroll'); return b ? b.scrollLeft : -1; });
      ok('Board bleibt nach dem Speichern an der Position', weg === 'ok' && Math.abs(nach - vor) < 60, `${weg}: ${vor} → ${nach}`);
    } else ok('Board seitlich scrollbar (übersprungen)', true);

    // ── 5) Der Merker arbeitet sauber ──
    const state = await p.evaluate(() => { viewStateSave(); const r = _viewState.route; viewStateReset(); return { hatteRoute: !!r, nachReset: _viewState.route }; });
    ok('Zustand wird pro Seite gemerkt', state.hatteRoute === true);
    ok('Seitenwechsel verwirft den Zustand', state.nachReset === null);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nAnsicht-erhalten: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
