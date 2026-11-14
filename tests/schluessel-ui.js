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
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, can_mcp: 1 });
    const ohne = await req('POST', '/api/users', admin, { username: 'uiohne', password: PW, name: 'Olga Ohne', role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 });
    const ohneId = ohne.body?.id || ohne.body?.user?.id;
    ok('Server, Admin und zwei Mitarbeiter (einer mit Recht „nur lesen", einer ohne)', !!admin && !!ohneId);

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

    console.log('── Recht im Mitarbeiter-Dialog ──');
    const { page: O } = await seite('uiohne', PW);
    const o1 = await O.evaluate(() => ({ hinweis: !!document.querySelector('.schluessel-kein-recht'), form: !!document.getElementById('schluessel-form') }));
    ok('ohne Recht: Hinweis statt Formular', o1.hinweis && !o1.form, JSON.stringify(o1));
    await A.evaluate(() => { location.hash = '/users'; });
    await A.waitForSelector('.edit-user'); await sleep(600);
    await A.evaluate((id) => document.querySelector(`.edit-user[data-id="${id}"]`).click(), ohneId);
    await A.waitForSelector('#um-can-mcp'); await sleep(400);
    const d1 = await A.evaluate(() => ({ wert: document.getElementById('um-can-mcp').value, sichtbar: document.getElementById('um-mcp-group').checkVisibility(),
      optionen: [...document.getElementById('um-can-mcp').options].map(o => o.textContent.trim()) }));
    ok('Dialog: Auswahl „Zugangsschlüssel" sichtbar, steht auf „keine", drei Stufen', d1.sichtbar && d1.wert === '0' && d1.optionen.length === 3, JSON.stringify(d1));
    await A.select('#um-role', 'admin'); await sleep(100);
    const d2 = await A.evaluate(() => ({ gruppe: document.getElementById('um-mcp-group').checkVisibility(), hinweis: document.getElementById('um-mcp-role-hint').checkVisibility() }));
    ok('… Rolle Admin: Auswahl weg, Hinweis „per Rolle"', !d2.gruppe && d2.hinweis, JSON.stringify(d2));
    await A.select('#um-role', 'mitarbeiter'); await sleep(100);
    await A.select('#um-can-mcp', '1');
    await A.evaluate(() => document.querySelector('#um-can-mcp').closest('form').querySelector('button[type="submit"]').click());
    await sleep(1500);
    const gesp = ((await req('GET', '/api/users', admin)).body?.users || []).find(u => u.id === ohneId);
    ok('gespeichert: can_mcp = 1, Rolle unverändert', gesp && gesp.can_mcp === 1 && gesp.role === 'mitarbeiter', JSON.stringify(gesp && { can_mcp: gesp.can_mcp, role: gesp.role }));
    await O.reload({ waitUntil: 'domcontentloaded' }); await O.waitForSelector('#konto-schluessel h3'); await sleep(400);
    const o2 = await O.evaluate(() => ({ form: !!document.getElementById('schluessel-form'),
      rechte: [...document.querySelectorAll('#schluessel-recht option')].map(x => x.value) }));
    ok('danach: Formular da, nur „nur lesen" wählbar', o2.form && JSON.stringify(o2.rechte) === '["lesen"]', JSON.stringify(o2));
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
