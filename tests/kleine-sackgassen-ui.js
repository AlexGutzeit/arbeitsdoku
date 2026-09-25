// Kleine Sackgassen: Downloads, abgelaufener Zwei-Faktor-Schritt, Abmelden, neue Rechte
// (R18, R13, R7, R8 — 26.09.2026).
//
//   R18  Zehn Download-Stellen, sieben gaben die Datei sofort nach dem Klick frei (Safari/iPhone kann
//        dann abbrechen). Jetzt EIN Baustein, Freigabe nach 60 s. Die Sicherung speicherte außerdem
//        jede Antwort — auch eine Fehlermeldung — unter dem Namen einer Sicherung.
//   R13  Nach 5 Minuten scheiterte jeder Zwei-Faktor-Code mit „abgelaufen", heraus nur über
//        „Abbrechen". Jetzt geht es von selbst zurück zur Passworteingabe.
//   R7   Lief der Hintergrunddienst der App nicht, wartete „Abmelden" ewig — der Knopf tat nichts.
//   R8   Neu vergebene Bestell- und Lagerrechte zeigten sich erst nach einem Seitenwechsel.
//
//   node tests/kleine-sackgassen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3334, DB = '/tmp/kleine-sackgassen.db', LOG = '/tmp/kleine-sackgassen.log';
const BASIS = 'http://localhost:' + PORT;
const APP = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang', BACKUP_EMPFAENGER: '' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR8 — Rechte');
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: 1 });
    const maxLogin = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;
    ok('Anmelde-Antwort nennt ALLE Rechte, auch das Einlernrecht', maxLogin.user.can_products_add === true
      && ['can_order', 'can_products_edit', 'can_plan'].every(k => k in maxLogin.user), JSON.stringify(Object.keys(maxLogin.user).filter(k => k.startsWith('can_'))));
    await req('PUT', `/api/users/${maxId}`, admin, { can_products_add: 0 });
    await req('POST', '/api/orders', maxLogin.token, { product: 'Kabelbinder', quantity: 1 });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async (name, vorher) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage(); await p.setViewport({ width: 1200, height: 900 }); p.setDefaultTimeout(30000);
      if (vorher) await p.evaluateOnNewDocument(vorher);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', name); await p.type('#login-pass', pw(name));
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(700);
      return p;
    };
    const m = await neueSeite('max');
    await m.evaluate(() => { location.hash = '/orders'; }); await m.waitForSelector('#order-list'); await sleep(700);
    ok('ohne Bestellrecht: kein „Bestellt"-Knopf', !(await m.$('.order-mark-btn')));
    await req('PUT', `/api/users/${maxId}`, admin, { can_order: 1 });
    // Wie im Alltag: zurück zum Tab — die App holt die Rechte nach (visibilitychange)
    await m.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const erschienen = await m.waitForSelector('.order-mark-btn', { timeout: 6000 }).then(() => true, () => false);
    ok('Bestellrecht vergeben: „Bestellt" erscheint ohne Seitenwechsel', erschienen);
    await req('PUT', `/api/users/${maxId}`, admin, { can_order: 0 });

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR13 — Zwei-Faktor-Schritt abgelaufen');
    const jwt = require(path.join(APP, 'node_modules', 'jsonwebtoken'));
    const alt = jwt.sign({ userId: maxId, pending2fa: true }, 'test-secret-mindestens-32-zeichen-lang', { expiresIn: -10 });
    const api13 = await req('POST', '/api/auth/login/2fa', null, { zwischen_token: alt, code: '123456' });
    ok('Server kennzeichnet den abgelaufenen Zwischenschritt', api13.status === 401 && api13.body.code === 'ZWISCHENSCHRITT_ABGELAUFEN', api13.text);
    const z = await browser.createBrowserContext(); const zp = await z.newPage(); await zp.setViewport({ width: 1000, height: 800 });
    await zp.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await zp.waitForSelector('#login-user');
    await zp.evaluate((t) => renderLoginCode(t, false), alt);
    await zp.waitForSelector('#login-code'); await zp.type('#login-code', '123456');
    await zp.click('#code-form button[type="submit"]');
    const zurueck = await zp.waitForSelector('#login-user', { timeout: 6000 }).then(() => true, () => false);
    const hinweis = await zp.evaluate(() => (document.querySelector('.login-hinweis') || {}).textContent || '');
    ok('Code zu spät: von selbst zurück zur Passworteingabe', zurueck && !(await zp.$('#login-code')));
    ok('… mit Hinweis, warum', /zu spät/.test(hinweis), hinweis);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR18 — Downloads');
    // Klicks auf Download-Links und Freigaben mitschreiben, statt wirklich herunterzuladen
    const mitschreiben = () => {
      window.__downloads = []; window.__freigaben = [];
      const klick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__downloads.push({ name: this.download, zeit: Date.now() }); return; }
        return klick.call(this);
      };
      const frei = URL.revokeObjectURL;
      URL.revokeObjectURL = function (u) { window.__freigaben.push(Date.now()); return frei.call(URL, u); };
    };
    const a = await neueSeite('admin', mitschreiben);
    const ablauf = async (hash, knopf) => {
      await a.evaluate((h) => { location.hash = h; }, hash); await a.waitForSelector(knopf); await sleep(700);
      await a.evaluate((k) => document.querySelector(k).click(), knopf);
      await a.waitForFunction(() => window.__downloads.length > 0, { timeout: 10000 }).catch(() => {});
      await sleep(1500);
      return a.evaluate(() => { const d = window.__downloads.slice(); const f = window.__freigaben.slice(); window.__downloads = []; window.__freigaben = []; return { d, f }; });
    };
    const pdf = await ablauf('/pdf', '#pdf-form button[type="submit"]');
    ok('PDF-Nachweis wird heruntergeladen', pdf.d.length === 1 && /\.pdf$/.test(pdf.d[0].name), JSON.stringify(pdf.d));
    ok('… und die Datei 1,5 s später noch NICHT freigegeben (vorher sofort)', pdf.f.length === 0, JSON.stringify(pdf.f));
    const sicherung = await ablauf('/settings', '#backup-download');
    ok('Sicherung wird heruntergeladen, Name vom Server', sicherung.d.length === 1 && /^arbeitsdoku_backup_.*\.zip$/.test(sicherung.d[0].name), JSON.stringify(sicherung.d));
    ok('… ebenfalls nicht sofort freigegeben', sicherung.f.length === 0, JSON.stringify(sicherung.f));
    const protokoll = await ablauf('/audit', '#audit-export');
    ok('Protokoll-Export: Dateiname mit Ortsdatum', protokoll.d.length === 1 && protokoll.d[0].name === `audit-log-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })}.csv`, JSON.stringify(protokoll.d));
    // Sicherung, wenn der Server einen Fehler meldet: KEINE Datei unter falschem Namen
    await a.setRequestInterception(true);
    a.on('request', r => r.url().includes('/api/backup/download')
      ? r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Testfehler: Sicherung ging nicht' }) }).catch(() => {})
      : r.continue().catch(() => {}));
    const kaputt = await ablauf('/settings', '#backup-download');
    const meldung = await a.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
    ok('Server-Fehler: keine Fehlermeldung als „Sicherung" gespeichert', kaputt.d.length === 0, JSON.stringify(kaputt.d));
    ok('… sondern der Fehler wird gemeldet', /Testfehler/.test(meldung), meldung);
    // Nur noch EINE Stelle im Code darf Downloads auslösen und Dateien freigeben
    const quellen = fs.readdirSync(path.join(APP, 'public', 'js')).filter(f => f.endsWith('.js'))
      .map(f => [f, fs.readFileSync(path.join(APP, 'public', 'js', f), 'utf8')]);
    const downloadStellen = quellen.flatMap(([f, s]) => (s.match(/\.download\s*=/g) || []).map(() => f));
    ok('das Download-Muster steht nur noch im Baustein (app-1-core)', downloadStellen.length === 1 && downloadStellen[0] === 'app-1-core.js', JSON.stringify(downloadStellen));

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nR7 — Abmelden ohne Hintergrunddienst');
    // Der Hintergrunddienst wird nie „bereit" — wie in einem Browser, in dem er nicht läuft
    const ohneDienst = () => {
      Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => new Promise(() => {}), configurable: true });
    };
    const h = await neueSeite('max', ohneDienst);
    const t0 = Date.now();
    await h.evaluate(() => document.getElementById('logout-btn').click());
    const abgemeldet = await h.waitForSelector('#login-user', { timeout: 15000 }).then(() => true, () => false);
    const dauer = Date.now() - t0;
    ok('„Abmelden" führt zur Anmeldeseite — nach der Zeitgrenze, nicht nie', abgemeldet && dauer < 4500, `${dauer} ms`);
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nKleine Sackgassen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
