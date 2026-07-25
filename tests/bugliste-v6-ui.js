// Puppeteer-Test Bugliste v6 (Frontend):
//  A1  XSS über Abwesenheits-Kommentar (Bearbeiten-Dialog) — Code darf NICHT ausgeführt werden.
//  A1b esc() escapt jetzt auch Anführungszeichen (Attribut-Ausbruch).
//  A6  Ungültige Soll-Stunden/Start-Überstunden werden gemeldet statt still 0 zu speichern.
//  B1  .form-row stapelt auf schmalem Display wieder (Mobil-Layout).
//  B13 Erprobungs-Banner ist entfernt.
// Start: node tests/bugliste-v6-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3124, DB = '/tmp/bugliste-v6-ui.db', BASE = 'http://localhost:' + PORT;
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
const XSS = '</textarea><img src=x onerror="window.__xss=true">';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/bugliste-v6-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/bugliste-v6-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'v6ui', password: 'Test1234!', name: 'V6 UI', role: 'mitarbeiter' })).body.user;
    // Abwesenheit mit bösartigem Kommentar (als Admin für den MA)
    const abs = await req('POST', '/api/absences', admin, { type: 'krank', date_from: '2027-06-01', date_to: '2027-06-01', target_user_id: ma.id, comment: XSS });
    ok('Setup: Abwesenheit mit XSS-Kommentar', abs.status === 201 || abs.status === 200, 'status=' + abs.status);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);

    // ── A1: Bearbeiten-Dialog der Abwesenheit öffnen ──
    console.log('A1 — XSS im Abwesenheits-Kommentar:');
    await p.evaluate(() => { window.__xss = false; location.hash = '#/absences'; }); await sleep(1200);
    const editBtn = await p.$('.absence-edit');
    ok('Bearbeiten-Button gefunden', !!editBtn);
    if (editBtn) {
      await editBtn.click(); await sleep(700);
      const r = await p.evaluate(() => ({
        xss: window.__xss === true,
        injectedImg: !!document.querySelector('.absence-form-card img'),
        value: document.getElementById('abs-comment')?.value || '',
      }));
      ok('KEIN Script ausgeführt (window.__xss false)', r.xss === false);
      ok('KEIN <img> im Formular (escaped)', r.injectedImg === false);
      ok('Kommentar steht unverfälscht im Feld', r.value.includes('<img src=x'), JSON.stringify(r.value.slice(0, 40)));
      await p.evaluate(() => document.getElementById('abs-cancel')?.click()); await sleep(300);
    }

    // ── A1b: esc() escapt Anführungszeichen ──
    const escQ = await p.evaluate(() => esc('a" onmouseover="alert(1)'));
    ok('esc() escapt Anführungszeichen (&quot;)', escQ.includes('&quot;') && !escQ.includes('a" '), escQ);

    // ── A6: ungültige Soll-Stunden melden statt still 0 ──
    console.log('A6 — ungültige Zahlen werden gemeldet:');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(900);
    await p.waitForSelector('#add-user-btn'); await p.click('#add-user-btn'); await sleep(500);
    await p.waitForSelector('#um-start-overtime');
    const r6 = await p.evaluate(() => {
      const el = document.getElementById('um-start-overtime');
      const isText = el.type === 'text';                 // komma-fähig statt type=number
      el.value = '7,5';
      const komma = numFromField(el, 0);                 // deutsches Komma muss ankommen
      el.value = 'abc';
      const quatsch = numFromField(el, 0);               // unlesbar → null (nicht still 0)
      el.value = '';
      const leer = numFromField(el, 0);                  // leer → Default
      // Bereichsgrenze wie früher min/max
      const zuGross = numFromField(Object.assign(document.createElement('input'), { value: '30' }), 0, 0, 24);
      return { isText, komma, quatsch, leer, zuGross };
    });
    ok('Stunden-Feld ist komma-fähig (type=text)', r6.isText, 'type=' + r6.isText);
    ok('Komma-Eingabe 7,5 → 7.5', r6.komma === 7.5, 'wert=' + r6.komma);
    ok('unlesbare Eingabe → null (nicht still 0)', r6.quatsch === null, 'wert=' + r6.quatsch);
    ok('leeres Feld → Default 0', r6.leer === 0, 'wert=' + r6.leer);
    ok('Bereichsgrenze greift (30 h > 24 → null)', r6.zuGross === null, 'wert=' + r6.zuGross);
    await p.evaluate(() => document.getElementById('um-cancel')?.click()); await sleep(200);

    // ── B13: Erprobungs-Banner weg ──
    console.log('B13 — Erprobungs-Banner:');
    await p.evaluate(() => { location.hash = '#/notifications'; }); await sleep(900);
    ok('kein Erprobungs-Banner mehr', (await p.$('.erprobung-banner')) === null);

    // ── B1: Mobil-Layout — .form-row stapelt ──
    console.log('B1 — Mobiles Formularlayout:');
    await p.setViewport({ width: 380, height: 800 });
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1000);
    const stacked = await p.evaluate(() => {
      const row = document.querySelector('.form-row');
      if (!row) return null;
      const st = getComputedStyle(row);
      const kids = [...row.children].filter(c => c.offsetParent !== null);
      const tops = new Set(kids.map(c => Math.round(c.getBoundingClientRect().top)));
      return { display: st.display, cols: st.gridTemplateColumns, kids: kids.length, rows: tops.size };
    });
    ok('form-row ist Grid (nicht flex)', stacked && stacked.display === 'grid', JSON.stringify(stacked));
    ok('auf 380px untereinander gestapelt', stacked && stacked.kids > 1 && stacked.rows === stacked.kids, JSON.stringify(stacked));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBugliste-v6-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
