// Mitarbeiter endgültig löschen — Oberfläche (Alex, 28.09.2026).
//
// Papierkorb → Mitarbeiter, geklickt wie ein Admin:
//   * Der Dialog nennt, was verschwindet und was bleibt (mit Zahlen), die Taste ist rot.
//   * Falscher Name → Hinweis, der Dialog bleibt offen, nichts gelöscht. Richtiger Name → weg, Meldung.
//   * Abgerechnetes Konto → Hinweis „nicht möglich" mit nur einer Taste, nichts gelöscht.
//   * Der Chef sieht den Knopf gar nicht (er kann nur ausstellen).
//
//   node tests/konto-loeschen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3350, DB = '/tmp/konto-loeschen-ui.db', LOG = '/tmp/konto-loeschen-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const JAHR = new Date().getFullYear() - 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const tag = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const id = {}, t = {};
    for (const [u, n, rolle] of [['ada', 'Ada Admin', 'admin'], ['carla', 'Carla Chef', 'chef'], ['tina', 'Tina Test', 'mitarbeiter'], ['paul', 'Paul Abgerechnet', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: rolle, hours_mon: 8 })).body.user.id;
      t[u] = (await req('POST', '/api/auth/login', null, { username: u, password: 'Test1234!' })).body.token;
    }
    const soll = (u, ab) => req('POST', `/api/statistics/targets/${id[u]}`, t.carla, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: ab });
    await soll('tina', tag(-30));
    for (const n of [-20, -19, -18]) await req('POST', '/api/entries', t.tina, { date: tag(n), time_from: '07:00', time_to: '12:00', break_minutes: 0 });
    await req('POST', '/api/bulletin', t.carla, { title: 'Nur zum Füllen', text: '' });
    await req('POST', '/api/orders', t.tina, { product: 'Kabelbinder', quantity: 1 });
    await soll('paul', `${JAHR}-01-01`);
    await req('POST', '/api/entries', admin, { date: `${JAHR}-01-15`, time_from: '07:00', time_to: '15:00', break_minutes: 30, user_id: id.paul });
    await req('POST', '/api/closure/bis', t.carla, { month: `${JAHR}-01` });
    for (const u of ['tina', 'paul']) await req('POST', `/api/users/${id[u]}/deactivate`, admin, { employed_until: tag(-1) });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(u + ': ' + e.message));
      await p.setViewport({ width: 1100, height: 900 });
      p.setDefaultTimeout(15000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(400);
      await p.evaluate(() => { location.hash = '/deleted-users'; });
      await p.waitForFunction(() => /Tina Test/.test(document.body.innerText)); await sleep(300);
      return p;
    };
    const dialog = (p) => p.evaluate(() => { const d = document.querySelector('.dialog-modal'); return d ? {
      titel: d.querySelector('h3').textContent, text: d.querySelector('.modal-body p').textContent,
      fehler: (d.querySelector('#pm-error') || {}).textContent || '', fehlerSichtbar: !!(d.querySelector('#pm-error') && d.querySelector('#pm-error').style.display !== 'none'),
      knoepfe: [...d.querySelectorAll('.modal-footer button')].map(b => ({ t: b.textContent, rot: b.classList.contains('btn-danger') })) } : null; });
    const klickLoeschen = async (p, uid) => { await p.click(`.purge-user[data-id="${uid}"]`); await p.waitForSelector('.dialog-modal'); await sleep(200); };

    console.log('Chef');
    const C = await seite('carla');
    ok('der Chef sieht keinen „Endgültig löschen"-Knopf (nur „Wiedereinstellen")',
      await C.evaluate(() => !document.querySelector('.purge-user') && !!document.querySelector('.reactivate-user')));

    console.log('Admin: Tina (Testkonto)');
    const A = await seite('ada');
    await klickLoeschen(A, id.tina);
    let d = await dialog(A);
    ok('Dialog nennt, was weg ist: 3 Zeiteinträge und das Konto', /3 Zeiteinträge \(auch im Papierkorb\)/.test(d.text) && /das Konto mit Zugang/.test(d.text), d.text);
    ok('… und was bleibt: 1 Bestellung (als „Gelöschtes Konto")', /Es bleibt \(als „Gelöschtes Konto"\):\n· 1 Bestellung/.test(d.text), d.text);
    ok('Bestätigen nur mit Name, rote Taste „Endgültig löschen"', /Namen eintippen/.test(d.text) && d.knoepfe.some(k => k.t === 'Endgültig löschen' && k.rot), JSON.stringify(d.knoepfe));
    await A.type('#pm-input', 'Tina');
    await A.click('.dialog-modal [data-act="ok"]'); await sleep(300);
    d = await dialog(A);
    ok('falscher Name: Hinweis, Dialog bleibt offen', d && d.fehlerSichtbar && /Der Name stimmt nicht — bitte genau „Tina Test" eintippen/.test(d.fehler), JSON.stringify(d));
    ok('… und nichts ist gelöscht', (await req('GET', `/api/users/${id.tina}/loeschen-vorschau`, admin)).status === 200);
    await A.evaluate(() => { document.getElementById('pm-input').value = ''; });
    await A.type('#pm-input', 'Tina Test');
    await A.click('.dialog-modal [data-act="ok"]');
    await A.waitForFunction(() => !document.querySelector('.dialog-modal'));
    await A.waitForFunction(() => /„Tina Test" endgültig gelöscht/.test(document.body.innerText));
    await A.waitForFunction(() => !/Tina Test\s/.test([...document.querySelectorAll('tbody tr')].map(r => r.innerText).join('\n')));
    ok('richtiger Name: Meldung „endgültig gelöscht", Zeile weg', true);
    ok('… und auf dem Server wirklich weg', (await req('GET', `/api/users/${id.tina}/loeschen-vorschau`, admin)).status === 404);

    console.log('Admin: Paul (abgerechnet)');
    await klickLoeschen(A, id.paul);
    d = await dialog(A);
    ok('Hinweis „nicht möglich" mit Grund, nur EINE Taste „Verstanden", kein Eingabefeld',
      d.titel === 'Endgültig löschen nicht möglich' && /abgeschlossenen Abrechnung/.test(d.text) && d.knoepfe.length === 1 && d.knoepfe[0].t === 'Verstanden'
        && !(await A.$('#pm-input')), JSON.stringify(d));
    await A.click('.dialog-modal [data-act="ok"]');
    await A.waitForFunction(() => !document.querySelector('.dialog-modal'));
    ok('Paul steht weiter in der Liste', await A.evaluate(() => /Paul Abgerechnet/.test(document.body.innerText)));
    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nKonto endgültig löschen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
