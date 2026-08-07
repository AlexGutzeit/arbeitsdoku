// UI-Test (Puppeteer) Urlaubskonto:
//  1) Mitarbeiter-Formular: Urlaubsanspruch-Zeile anlegen → erscheint in Tabelle + Stand-Anzeige.
//  2) Abwesenheit (Manager): Reiter „Urlaubsübersicht" rendert Tabelle je MA + Suche filtert.
//  3) Mitarbeiter-Eigensicht: Header zeigt „genommen · geplant · verbleibend".
// Start: node tests/vacation-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3186;
const DB = '/tmp/vacation-ui.db';
const BASE = 'http://localhost:' + PORT;
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

// UHR FESTGEHALTEN. Der Urlaubsanspruch ist JAHRESBEZOGEN, und „genommen" gegen „geplant"
// entscheidet sich am heutigen Datum. Feste Zeitraeume im Test wandern deshalb mit der Zeit von
// „Zukunft" nach „Vergangenheit" — am 07.08.2026 ist genau das passiert: „2026-08-03 bis
// 2026-08-07" war beim Schreiben Zukunft und zaehlte ploetzlich als genommen.
//
// Die Zeitraeume relativ zu heute zu waehlen hilft nicht: Sie muessen ALLE IM SELBEN JAHR liegen
// wie der Anspruch, und in einem Januar oder Dezember gibt es nicht auf beiden Seiten Platz.
// Deshalb laeuft der Server hier mit einer festgehaltenen Uhr (Mitte des Testjahres); die
// Zeitraeume bleiben fest und der Test veraltet nie.
const TESTJAHR = 2026;
const UHR_PRELOAD = path.join(os.tmpdir(), 'vacation-uhr-' + process.pid + '.js');
fs.writeFileSync(UHR_PRELOAD, `const E = Date; const ziel = new E('${TESTJAHR}-07-15T12:00:00').getTime();
const v = ziel - E.now();
function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC;
globalThis.Date = G;`);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/vacation-ui-srv.log', 'w');
  const srv = spawn('node', ['-r', UHR_PRELOAD, 'server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const pw = (fs.readFileSync('/tmp/vacation-ui-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const uwe = (await req('POST', '/api/users', admin, { username: 'uwe', password: 'Test1234!', name: 'Uwe Urlauber', role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
    // genehmigten Urlaub anlegen (Vergangenheit + Zukunft relativ zu heute)
    const mk = async (from, to) => (await req('POST', '/api/absences', admin, { type: 'urlaub', date_from: from, date_to: to, target_user_id: uwe.id })).body.absence.id;
    await req('POST', `/api/absences/${await mk('2026-06-01', '2026-06-05')}/approve`, admin);
    await req('POST', `/api/absences/${await mk('2026-08-03', '2026-08-07')}/approve`, admin);
    ok('Setup: Admin, MA, genehmigter Urlaub', !!admin && !!uwe);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 860 });

    // Login Admin
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');

    // --- 0) Vor jeder Konfiguration: Manager sieht KEINE Urlaubs-Reiter (alte Ansicht bleibt) ---
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(900);
    await p.waitForSelector('.card', { timeout: 8000 });
    ok('vor Konfiguration: keine Manager-Reiter', await p.$$eval('.absence-tab', els => els.length) === 0);

    // --- 1) Mitarbeiter-Formular: Urlaubsanspruch anlegen ---
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(900);
    await p.waitForSelector('.edit-user');
    await p.evaluate((id) => document.querySelector(`.edit-user[data-id="${id}"]`).click(), uwe.id);
    await p.waitForSelector('#um-vac-list', { timeout: 8000 });
    // Das Element ist da, BEVOR sein Inhalt nachgeladen ist — ohne dieses Warten liest der Test
    // gelegentlich ins Leere und meldet einen Fehler, den es nicht gibt (etwa jeder dritte Lauf).
    await p.waitForFunction(() => {
      const el = document.getElementById('um-vac-list');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 8000 });
    let emptyTxt = await p.evaluate(() => document.getElementById('um-vac-list').textContent);
    ok('Anfangs kein Anspruch (Hinweis „mit 0")', /mit 0/.test(emptyTxt), emptyTxt.trim().slice(0, 40));

    // Warten bis Stand gerendert ist → dann ist auch der „Hinzufügen"-Handler angehängt.
    await p.waitForFunction(() => { const s = document.getElementById('um-vac-stand'); return s && /Stand/.test(s.textContent); }, { timeout: 8000 });
    await p.evaluate(() => { document.getElementById('um-vac-days').value = '30'; document.getElementById('um-vac-from').value = '2026-01-01'; });
    await p.evaluate(() => document.getElementById('um-vac-add').click());
    await p.waitForSelector('#um-vac-list tr[data-vac-id]', { timeout: 6000 }); await sleep(300);
    const vacRow = await p.evaluate(() => {
      const tr = document.querySelector('#um-vac-list tr[data-vac-id]');
      return { days: tr.querySelector('.vac-days').value, hasMode: !!tr.querySelector('.vac-mode') };
    });
    ok('Anspruch-Zeile angelegt (30 Tage, Verfall-Select)', vacRow.days === '30' && vacRow.hasMode, JSON.stringify(vacRow));
    const standTxt = await p.evaluate(() => document.getElementById('um-vac-stand').textContent);
    ok('Stand-Anzeige zeigt genommen/verbleibend', /genommen/.test(standTxt) && /noch zu planen/.test(standTxt), standTxt.replace(/\s+/g, ' ').trim().slice(0, 80));
    await p.evaluate(() => document.getElementById('um-cancel')?.click()); await sleep(200);

    // --- 2) Abwesenheit: Manager-Reiter „Urlaubsübersicht" ---
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(900);
    await p.waitForSelector('.absence-tabs', { timeout: 8000 });
    ok('Manager sieht Reiter (Liste + Urlaubsübersicht)', await p.$$eval('.absence-tab', els => els.length) === 2);
    await p.evaluate(() => document.querySelector('.absence-tab[data-tab="vacation"]').click());
    await p.waitForSelector('.vac-ov-table', { timeout: 8000 }); await sleep(400);
    const row = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('.vac-ov-table tbody tr[data-name]')].find(t => /uwe/i.test(t.dataset.name));
      if (!tr) return null;
      const c = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      return { name: c[0], anspruch: c[1], gesamt: c[3], genommen: c[4], geplant: c[5], nochZuPlanen: c[6] };
    });
    ok('Übersichtszeile für MA vorhanden', !!row, JSON.stringify(row));
    ok('Spalten: Anspruch 30, genommen 5, geplant 5, noch 20', row && row.anspruch === '30' && row.genommen === '5' && row.geplant === '5' && row.nochZuPlanen === '20', JSON.stringify(row));

    // Suche filtert
    await p.type('#vac-ov-search', 'zzzzzz'); await sleep(300);
    const hidden = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('.vac-ov-table tbody tr[data-name]')].find(t => /uwe/i.test(t.dataset.name));
      return tr ? tr.style.display : 'weg';
    });
    ok('Suche „zzz" blendet MA-Zeile aus', hidden === 'none', 'display=' + hidden);

    // --- 3) Mitarbeiter-Eigensicht: Header (isolierter Kontext, sonst teilt sich das Admin-Token) ---
    const ctx2 = await browser.createBrowserContext();
    const p2 = await ctx2.newPage(); await p2.setViewport({ width: 1000, height: 800 });
    await p2.goto(BASE, { waitUntil: 'networkidle2' });
    await p2.waitForSelector('#login-user'); await p2.type('#login-user', 'uwe'); await p2.type('#login-pass', 'Test1234!');
    await p2.click('#login-form button[type="submit"]'); await p2.waitForSelector('a[href="#/absences"]', { timeout: 8000 });
    await p2.evaluate(() => { location.hash = '#/absences'; }); await sleep(900);
    await p2.waitForSelector('.absence-counter', { timeout: 8000 });
    const counter = await p2.evaluate(() => document.querySelector('.absence-counter').textContent);
    ok('MA-Header zeigt genommen · geplant · verbleibend', /genommen/.test(counter) && /geplant/.test(counter) && /verbleibend/.test(counter), counter.replace(/\s+/g, ' ').trim());
    ok('MA sieht KEINE Manager-Reiter', await p2.$$eval('.absence-tab', els => els.length) === 0);

  } catch (e) { fail++; fails.push('EXCEPTION: ' + e.message); console.log('  ✗ EXCEPTION: ' + e.message); }
  finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nVacation-UI: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
