// Puppeteer-UI-Test (B2): Ein bösartiger Regie-Mitarbeitername darf im Eintrags-Tooltip NICHT als HTML landen.
// Der Name wird nur über esc() gerendert → kein <img>-Element, kein onerror-Script.
// Start: node tests/tooltip-escape-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3120, DB = '/tmp/tooltip-escape.db', BASE = 'http://localhost:' + PORT;
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
const tok = async (u, pw = 'Test1234!') => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
const XSS_NAME = '<img src=x onerror="window.__xss=true">';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/tooltip-escape-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/tooltip-escape-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = await tok('admin', apw);
    // Regie-MA mit bösartigem Namen + ein Betrachter-MA
    const evil = (await req('POST', '/api/users', admin, { username: 'evilregie', password: 'Test1234!', name: XSS_NAME, role: 'mitarbeiter' })).body.user;
    const viewer = (await req('POST', '/api/users', admin, { username: 'viewer', password: 'Test1234!', name: 'Betrachter', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    ok('Setup: bösartiger Regie-MA + Betrachter', !!(evil && viewer));

    // Eintrag des Betrachters HEUTE mit Regie = bösartiger MA
    const viewerTok = await tok('viewer');
    const today = new Date().toLocaleDateString('sv-SE');
    const created = await req('POST', '/api/entries', viewerTok, { date: today, time_from: '08:00', time_to: '12:00', project_text: 'XSS-Test', has_regie: 1, regie_user_id: evil.id });
    ok('Eintrag mit Regie angelegt (201)', created.status === 201, 'status=' + created.status);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 850 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'viewer'); await p.type('#login-pass', 'Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(() => { window.__xss = false; location.hash = '#/dashboard'; }); await sleep(1200);

    await p.waitForSelector('.tl-entry[data-entry-id]', { timeout: 6000 });
    // Hover auslösen → Tooltip rendern
    await p.evaluate(() => { const el = document.querySelector('.tl-entry[data-entry-id]'); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 200, clientY: 200 })); });
    await sleep(400);

    const r = await p.evaluate(() => {
      const tt = document.querySelector('.entry-tooltip');
      return {
        exists: !!tt,
        html: tt ? tt.innerHTML : '',
        text: tt ? tt.textContent : '',
        imgInTooltip: tt ? !!tt.querySelector('img') : false,
        xssFired: window.__xss === true,
      };
    });

    ok('Tooltip sichtbar', r.exists);
    ok('KEIN onerror-Script ausgeführt (window.__xss bleibt false)', r.xssFired === false);
    ok('KEIN <img>-Element im Tooltip (Name wurde escaped)', r.imgInTooltip === false, 'html=' + r.html.slice(0, 160));
    ok('Regie-Name als Text sichtbar (escaped)', /Regie: Ja/.test(r.text) && r.text.includes('<img'), 'text=' + r.text);
    ok('Tooltip-HTML enthält escapte Entität &lt;img', r.html.includes('&lt;img'), 'html=' + r.html.slice(0, 160));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nTooltip-Escape-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
