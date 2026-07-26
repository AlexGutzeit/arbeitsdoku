// Puppeteer-Test: „Zurück" nach dem Übernehmen einer Planung führt dorthin zurück, wo das
// Übernehmen ausgelöst wurde.
//   Willkommensseite → Übernehmen → Zurück  ⇒  Willkommensseite
//   Planung          → Übernehmen → Zurück  ⇒  Planung
//   (nach einem Neuladen ohne Merker: wie bisher zur Planung)
// Start: node tests/uebernahme-zurueck-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3153, DB = '/tmp/uebernahme.db', BASE = 'http://localhost:' + PORT;
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
const heute = new Date().toLocaleDateString('sv-SE');
const hash = p => p.evaluate(() => location.hash);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/uebernahme-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/uebernahme-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: apw })).body.token;
    const mapw = 'Test1234!';
    const ma = (await req('POST', '/api/users', admin, { username: 'ueberma', password: mapw, name: 'Übernahme MA', role: 'mitarbeiter' })).body.user;
    // Zwei Planungen für heute, damit sowohl Willkommensseite als auch Planung etwas anzeigen
    for (const k of ['Kunde Eins', 'Kunde Zwei']) {
      await req('POST', '/api/planning', admin, {
        days: [{ date: heute, time_from: '08:00', time_to: '15:00' }],
        client: k, address: 'Musterweg 1', assigned_user_ids: [ma.id],
      });
    }

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1100, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'ueberma'); await p.type('#login-pass', mapw);
    await p.click('#login-form button[type="submit"]');
    await p.waitForSelector('a[href="#/planning"]'); await sleep(800);

    // ── Von der Willkommensseite ──────────────────────────────────────────
    console.log('Von der Willkommensseite:');
    await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(2500);
    const knopfDa = await p.evaluate(() => !!document.querySelector('.accept-welcome-plan'));
    ok('„Übernehmen" ist auf der Willkommensseite da', knopfDa);
    await p.evaluate(() => document.querySelector('.accept-welcome-plan').click());
    await sleep(2500);
    ok('landet im Zeiteintrag', /#\/planning\/accept\//.test(await hash(p)), await hash(p));
    ok('Zurück-Knopf vorhanden', await p.evaluate(() => !!document.getElementById('back-btn')));
    await p.evaluate(() => document.getElementById('back-btn').click());
    await sleep(2000);
    ok('„Zurück" führt zur Willkommensseite', (await hash(p)) === '#/welcome', await hash(p));
    ok('die Willkommensseite ist wirklich aufgebaut',
      await p.evaluate(() => !!document.getElementById('welcome-clock')));

    // ── Von der Planung ───────────────────────────────────────────────────
    console.log('Von der Planung:');
    await p.evaluate(() => { location.hash = '#/planning'; }); await sleep(2800);
    const planDa = await p.evaluate(() => !!document.querySelector('.tl-plan-entry[data-planning-id]'));
    ok('Planungstermin ist da', planDa);
    await p.evaluate(() => document.querySelector('.tl-plan-entry[data-planning-id]').click());
    await sleep(2500);
    ok('landet im Zeiteintrag', /#\/planning\/accept\//.test(await hash(p)), await hash(p));
    await p.evaluate(() => document.getElementById('back-btn').click());
    await sleep(2000);
    ok('„Zurück" führt zur Planung', (await hash(p)) === '#/planning', await hash(p));

    // ── Nach einem Neuladen (kein Merker) ─────────────────────────────────
    console.log('Nach einem Neuladen der Seite:');
    const planId = (await req('GET', '/api/planning?from=' + heute + '&to=' + heute, admin)).body.entries[0].id;
    await p.goto(`${BASE}/#/planning/accept/${planId}`, { waitUntil: 'networkidle2' });
    await sleep(2500);
    ok('Formular nach Neuladen offen', await p.evaluate(() => !!document.getElementById('back-btn')));
    await p.evaluate(() => document.getElementById('back-btn').click());
    await sleep(2000);
    ok('ohne Merker wie bisher zur Planung', (await hash(p)) === '#/planning', await hash(p));

    // ── Ein normaler neuer Eintrag geht weiterhin zum Zeitnachweis ────────
    console.log('Normaler Eintrag (keine Übernahme):');
    await p.evaluate(() => { location.hash = '#/welcome'; }); await sleep(2000);
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(2500);
    await p.evaluate(() => document.getElementById('back-btn').click());
    await sleep(1800);
    ok('„Zurück" führt zum Zeitnachweis', (await hash(p)) === '#/' || (await hash(p)) === '', await hash(p));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nÜbernahme-Zurück: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
