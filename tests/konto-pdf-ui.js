// Der PDF-Nachweis ist für Mitarbeiter nach „Mein Konto" gezogen (Alex, 23.08.2026).
//
// Begründung: Für einen Mitarbeiter war die Seite #/pdf nur der Download SEINER eigenen Zeiten —
// eine persönliche Sache, die auf die persönliche Seite gehört. Für Chef, Admin und Buchhaltung
// steht dort zusätzlich Lohn-CSV und der Abrechnungs-Abschluss; das hat auf einer persönlichen
// Seite nichts zu suchen, deshalb bleibt für sie alles, wie es war.
//
// Der heikle Teil ist die Trennung: Das Formular steht jetzt an zwei Orten, darf aber nur EINMAL
// im Code existieren, und die Mitarbeiter-Auswahl darf auf der Konto-Karte NICHT auftauchen —
// sonst könnte dort jemand fremde Zeiten anfordern. Serverseitig ist das ohnehin gesperrt; hier
// wird beides geprüft.
//
//   node tests/konto-pdf-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3271, DB = '/tmp/konto-pdf.db', BASIS = `http://localhost:${PORT}`;
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
  const lg = fs.openSync('/tmp/konto-pdf-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/konto-pdf-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maxId = (await req('GET', '/api/users', admin)).body.users.find(u => u.username === 'max').id;
    // Ein Projekt und ein paar Zeiten, damit das PDF nicht leer ist und der Projektfilter etwas hat.
    await req('POST', '/api/projects', admin, { name: 'Baustelle Nord' });
    const heute = new Date().toLocaleDateString('sv-SE');
    await req('POST', '/api/entries', admin,
      { user_id: maxId, date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'Montage' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const anmelden = async (page, u, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', u); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await sleep(2500);
    };
    const menue = (page) => page.evaluate(() =>
      [...document.querySelectorAll('.sidebar a')].map(a => ({ ziel: a.getAttribute('href'), text: a.textContent.trim() })));

    console.log('── Mitarbeiter: die Karte sitzt auf „Mein Konto" ──');
    const ma = await browser.newPage(); await ma.setViewport({ width: 500, height: 980 });
    ma.setDefaultTimeout(30000);
    await anmelden(ma, 'max', pw('max'));
    const maMenue = await menue(ma);
    ok('kein eigener Menuepunkt mehr', !maMenue.some(e => e.ziel === '#/pdf'),
      JSON.stringify(maMenue.map(e => e.ziel)));
    ok('„Mein Konto" steht weiterhin im Menue', maMenue.some(e => e.ziel === '#/konto'));

    await ma.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await ma.waitForSelector('#konto-pdf', { timeout: 20000 }); await sleep(2500);
    ok('die Karte ist da', /Zeitnachweis als PDF/.test(await ma.$eval('#konto-pdf', el => el.innerText)));
    ok('… mit dem Formular', !!(await ma.$('#konto-pdf #pdf-form')));
    ok('… OHNE Mitarbeiter-Auswahl', !(await ma.$('#pdf-user')),
      'sonst koennte man dort fremde Zeiten anfordern');
    ok('… aber MIT Projektfilter', /Baustelle Nord/.test(await ma.$eval('#pdf-project', el => el.innerText)),
      await ma.$eval('#pdf-project', el => el.innerText));

    console.log('\n── Die alte Adresse fuehrt dorthin (Lesezeichen) ──');
    ok('#/pdf leitet auf #/konto um', await ma.evaluate(async () => {
      location.hash = '#/pdf';
      await new Promise(r => setTimeout(r, 1600));
      return location.hash === '#/konto';
    }));

    console.log('\n── Der Knopf laedt wirklich ein PDF ──');
    await ma.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await ma.waitForSelector('#konto-pdf #pdf-form'); await sleep(2200);
    const antwort = new Promise((res) => {
      ma.on('response', (r) => { if (r.url().includes('/api/pdf/export')) res(r); });
    });
    await ma.evaluate(() => {
      const f = document.querySelector('#konto-pdf #pdf-form');
      f.scrollIntoView({ block: 'center' });
      f.querySelector('button[type="submit"]').click();
    });
    const r = await Promise.race([antwort, sleep(15000).then(() => null)]);
    ok('die Anfrage geht raus und kommt mit 200 zurueck', !!r && r.status() === 200,
      r ? String(r.status()) : 'keine Anfrage beobachtet');
    ok('… und liefert wirklich ein PDF', !!r && /application\/pdf/.test(r.headers()['content-type'] || ''),
      r ? String(r.headers()['content-type']) : '—');
    // Ohne Nutzer-Kennung: Der Server liefert dem Mitarbeiter ohnehin nur die eigenen Zeiten.
    ok('… ohne fremde Nutzer-Kennung in der Adresse', !!r && !/user_id=/.test(r.url()), r ? r.url() : '—');
    await ma.close();

    console.log('\n── Chef: alles bleibt, wie es war ──');
    const chef = await browser.newPage(); await chef.setViewport({ width: 700, height: 900 });
    chef.setDefaultTimeout(30000);
    await anmelden(chef, 'chef', pw('chef'));
    const chefMenue = await menue(chef);
    const punkt = chefMenue.find(e => e.ziel === '#/pdf');
    ok('der Menuepunkt ist da', !!punkt, JSON.stringify(chefMenue.map(e => e.ziel)));
    ok('… und heisst „Abrechnung"', !!punkt && /Abrechnung/.test(punkt.text), punkt && punkt.text);
    await chef.goto(BASIS + '/#/pdf', { waitUntil: 'domcontentloaded' }); await sleep(2800);
    ok('die Seite oeffnet sich (keine Umleitung)', (await chef.evaluate(() => location.hash)) === '#/pdf');
    ok('… mit dem PDF-Formular', !!(await chef.$('#pdf-form')));
    ok('… MIT Mitarbeiter-Auswahl', !!(await chef.$('#pdf-user')));
    ok('… und dem Lohn-Export', !!(await chef.$('#lohn-form')));
    ok('… und dem Abrechnungs-Abschluss', !!(await chef.$('#abschluss-karte')));
    await chef.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' }); await sleep(2500);
    ok('auf seinem Konto gibt es die Karte NICHT', !(await chef.$('#konto-pdf')),
      'dort haette sie neben Lohn und Abschluss keinen Sinn');

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nPDF-Nachweis auf „Mein Konto": ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
