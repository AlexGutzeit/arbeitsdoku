// Puppeteer-Test: globaler Doppel-Submit-Schutz.
//  Ebene 1 (api-Coalescing): 5 GLEICHZEITIGE identische POSTs → nur 1 Request verlässt den Browser, 1 Eintrag.
//  Ebene 3 (Backend-Dedup):  5 NACHEINANDER (≤10s) identische POSTs → 5 Requests, aber nur 1 Eintrag.
//  Gegenprobe: ein ABWEICHENDER Eintrag wird normal angelegt (kein Dauer-Blockieren).
// Start: node tests/double-submit-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3123, DB = '/tmp/double-submit.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, x => { let s = ''; x.on('data', d => s += d); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
const DAY = '2026-08-03'; // fester Testtag
const countEntries = async (token) => ((await req('GET', `/api/planning/?date_from=${DAY}&date_to=${DAY}`, token)).body.entries || []).length;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/double-submit-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/double-submit-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = await tok('admin', apw);
    const ma = (await req('POST', '/api/users', admin, { username: 'planziel', password: 'Test1234!', name: 'Plan Ziel', role: 'mitarbeiter' })).body.user;
    ok('Setup: MA angelegt', !!ma);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 850 });
    let planningPosts = 0;
    p.on('request', r => { if (r.method() === 'POST' && /\/api\/planning\/?(\?|$)/.test(r.url())) planningPosts++; });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'chef'); await p.type('#login-pass', cpw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ── Ebene 1: 5 GLEICHZEITIGE identische POSTs über die echte api()-Funktion des Frontends ──
    console.log('Ebene 1 — gleichzeitige Mehrfach-Submits:');
    const body1 = { date: DAY, time_from: '08:00', time_to: '12:00', assigned_user_ids: [ma.id] };
    planningPosts = 0;
    const r1 = await p.evaluate(async (b) => {
      const rs = await Promise.allSettled(Array.from({ length: 5 }, () => api('POST', '/api/planning', b)));
      return rs.filter(x => x.status === 'fulfilled').length;
    }, body1);
    await sleep(400);
    ok('5 gleichzeitige api()-Aufrufe erfüllt', r1 === 5, 'erfüllt=' + r1);
    ok('nur 1 POST verlässt den Browser (Coalescing)', planningPosts === 1, 'posts=' + planningPosts);
    ok('nur 1 Planungseintrag angelegt', (await countEntries(admin)) === 1);

    // ── Ebene 3: 5 NACHEINANDER (Backend-Dedup, da nicht gleichzeitig) ──
    console.log('Ebene 3 — sequentielle Mehrfach-Submits (Backend-Riegel):');
    const body2 = { date: DAY, time_from: '13:00', time_to: '17:00', assigned_user_ids: [ma.id] };
    planningPosts = 0;
    const r2 = await p.evaluate(async (b) => {
      let okc = 0;
      for (let i = 0; i < 5; i++) { try { await api('POST', '/api/planning', b); okc++; } catch (_) {} }
      return okc;
    }, body2);
    await sleep(300);
    ok('5 sequ. Requests erreichten den Server', planningPosts === 5, 'posts=' + planningPosts);
    ok('trotzdem nur 1 zusätzlicher Eintrag (Dedup)', (await countEntries(admin)) === 2, 'gesamt=' + (await countEntries(admin)));

    // ── Gegenprobe: abweichender Eintrag geht normal durch ──
    console.log('Gegenprobe — abweichender Eintrag:');
    const body3 = { date: DAY, time_from: '18:00', time_to: '19:00', assigned_user_ids: [ma.id] };
    await p.evaluate(async (b) => { await api('POST', '/api/planning', b); }, body3);
    await sleep(300);
    ok('abweichender Eintrag wird angelegt (kein Dauer-Block)', (await countEntries(admin)) === 3);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nDouble-Submit-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
