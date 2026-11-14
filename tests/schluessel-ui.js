// Zugangsschlüssel auf „Mein Konto": anlegen, einmal sehen, kopieren, widerrufen — im Browser.
//
// Warum (Alex, 14.11.2026): Den Schlüssel für Hermes legt Alex selbst in der Oberfläche an. Er darf nur EINMAL zu
// sehen sein (der Server hat ihn nicht im Klartext), muss sich kopieren lassen und tut danach wirklich etwas —
// gemessen wird deshalb auch mit dem angezeigten Schlüssel gegen die Schnittstelle. Der Admin sieht zusätzlich alle
// Schlüssel und das Zugriffsprotokoll; ein Mitarbeiter nicht.
//   node tests/schluessel-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const CHROME = require('./hilfen/chrome');
const PORT = 3412, DB = '/tmp/schluessel-ui.db', LOG = '/tmp/schluessel-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, token, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: adminPw })).body?.token;
    const PW = 'Test1234!';
    await req('POST', '/api/users', admin, { username: 'uima', password: PW, name: 'Uwe Ui', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 });
    ok('Server, Admin und Mitarbeiter', !!admin);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const seite = async (u, p) => {
      const kontext = await browser.createBrowserContext();
      await kontext.overridePermissions(BASIS, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
      const page = await kontext.newPage(); await page.setViewport({ width: 1100, height: 900 });
      page.setDefaultTimeout(30000);
      page.on('pageerror', e => fehler.push(u + ': ' + String(e && e.message || e)));
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', u); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/konto"]');
      await page.evaluate(() => { location.hash = '/konto'; });
      await page.waitForSelector('#konto-schluessel h3'); await sleep(300);
      return { page, kontext };
    };

    console.log('── Mitarbeiter ──');
    const { page: M } = await seite('uima', PW);
    const karte = await M.evaluate(() => { const k = document.getElementById('konto-schluessel');
      return { text: k.textContent, sichtbar: k.checkVisibility(), admin: /Alle Schlüssel|Zugriffsprotokoll/.test(k.textContent) }; });
    ok('Karte „Zugangsschlüssel für Programme" sichtbar, mit MCP-Adresse', karte.sichtbar && /Zugangsschlüssel für Programme/.test(karte.text) && karte.text.includes(BASIS + '/mcp'), karte.text.slice(0, 200));
    ok('… ohne Admin-Teil', !karte.admin);
    await M.click('.schluessel-anlegen summary');
    await M.type('#schluessel-name', 'Hermes Uwe');
    await M.type('#schluessel-pw', 'falsch');
    await M.click('#schluessel-form button[type="submit"]'); await sleep(500);
    const f1 = await M.evaluate(() => ({ fehler: document.getElementById('schluessel-fehler').textContent, angemeldet: !!document.getElementById('konto-schluessel') }));
    ok('falsches Passwort: Fehler in der Karte, man bleibt angemeldet', /Passwort stimmt nicht/.test(f1.fehler) && f1.angemeldet, JSON.stringify(f1));
    // Ein Dreifachklick markiert den Inhalt eines Passwortfelds nicht — leeren, dann tippen.
    await M.evaluate(() => { document.getElementById('schluessel-pw').value = ''; });
    await M.type('#schluessel-pw', PW);
    await M.click('#schluessel-form button[type="submit"]');
    await M.waitForSelector('#schluessel-wert'); await sleep(200);
    const neu = await M.evaluate(() => ({ wert: document.getElementById('schluessel-wert').value,
      hinweis: document.querySelector('.schluessel-neu').textContent, zeilen: document.querySelectorAll('.schluessel-zeile').length }));
    ok('angelegt: Schlüssel steht einmal da (adk_…), mit Hinweis „nur jetzt"', /^adk_/.test(neu.wert) && /nur jetzt/.test(neu.hinweis) && neu.zeilen === 1, JSON.stringify(neu));
    await M.click('#schluessel-kopieren'); await sleep(200);
    const kopiert = await M.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    ok('„Kopieren" legt genau den Schlüssel in die Zwischenablage', kopiert === neu.wert, kopiert.slice(0, 12));
    const wirkt = await req('GET', '/api/bulletin', neu.wert);
    ok('… und der angezeigte Schlüssel funktioniert', wirkt.status === 200, wirkt.status);
    await M.reload({ waitUntil: 'domcontentloaded' }); await M.waitForSelector('#konto-schluessel h3'); await sleep(400);
    const danach = await M.evaluate((w) => ({ weg: !document.getElementById('schluessel-wert') && !document.body.innerHTML.includes(w),
      zeile: document.querySelector('.schluessel-zeile')?.textContent || '' }), neu.wert);
    ok('nach dem Neuladen: Schlüssel nirgends mehr, nur Name + Anfang + „nie"/Zeit', danach.weg && /Hermes Uwe/.test(danach.zeile) && /lesen/.test(danach.zeile) && /aktiv/.test(danach.zeile), JSON.stringify(danach));
    await M.click('.schluessel-weg');
    await M.waitForSelector('.dialog-modal [data-act="ok"]'); await M.click('.dialog-modal [data-act="ok"]'); await sleep(600);
    const weg = await M.evaluate(() => ({ zeile: document.querySelector('.schluessel-zeile')?.textContent || '', knopf: !!document.querySelector('.schluessel-weg') }));
    ok('Widerrufen nach Rückfrage: Zeile „widerrufen", kein Knopf mehr', /widerrufen/.test(weg.zeile) && !weg.knopf, JSON.stringify(weg));
    ok('… der Schlüssel ist tot (401)', (await req('GET', '/api/bulletin', neu.wert)).status === 401);
    await M.setViewport({ width: 360, height: 800 }); await sleep(300);
    const schmal = await M.evaluate(() => ({ ueber: document.documentElement.scrollWidth > innerWidth + 1 }));
    ok('360 px: Seite läuft nicht über (Tabelle scrollt in sich)', !schmal.ueber, JSON.stringify(schmal));

    console.log('── Admin ──');
    const { page: A } = await seite('admin', adminPw);
    const ad = await A.evaluate(() => { const k = document.getElementById('konto-schluessel').textContent;
      return { alle: /Alle Schlüssel \(Admin\)/.test(k), uwe: /Uwe Ui/.test(k), protokoll: /Zugriffsprotokoll \/mcp/.test(k) }; });
    ok('Admin sieht „Alle Schlüssel" mit Uwes Schlüssel und das Zugriffsprotokoll', ad.alle && ad.uwe && ad.protokoll, JSON.stringify(ad));
    ok('keine Skriptfehler im Browser', fehler.length === 0, fehler.join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nZugangsschlüssel (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
