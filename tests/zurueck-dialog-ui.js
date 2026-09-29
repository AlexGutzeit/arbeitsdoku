// Zurück schließt den Dialog (R28, 29.09.2026).
//
// Dialoge hängen an <body>. Die Zurück-Taste am Handy wechselte bisher die Seite DARUNTER, der Dialog blieb
// stehen. Jetzt (app-1-core.js, dialogImVerlauf): Zurück schließt den obersten Dialog wie „Abbrechen", die
// Seite bleibt; Formulare mit Entwurfs-Sicherung werden vorher gesichert. Alex: „Abbrechen verwirft,
// Zurück sichert". Geprüft, mit echtem history.back() wie die Handy-Taste:
//   1  Zurück schließt Bestätigen/Eingabe/Auswahl — Seite bleibt, das Ergebnis ist „abgebrochen".
//   2  Nach normalem Schließen wechselt das nächste Zurück wie gewohnt die Seite (kein toter Tastendruck).
//   3  OK, das auf eine andere Seite springt: Der Sprung bleibt (das Entfernen des Dialog-Schritts macht ihn
//      nicht rückgängig), und Zurück führt danach auf die Seite davor.
//   4  Dialog auf Dialog (Bestätigen → gleich danach Begründung): Zurück schließt nur den oberen.
//   5  Abwesenheits-Formular: Zurück sichert den Entwurf („Entwurf gesichert"), er wird beim nächsten Öffnen
//      angeboten; „Abbrechen" verwirft ihn — danach wird nichts mehr angeboten.
//   6  Seitenwechsel bei offenem Dialog (Link, Programm): Dialog geht zu; ein späteres Zurück landet in EINEM
//      Schritt auf der Seite davor (der liegengebliebene Dialog-Schritt wird übersprungen).
//   7  Werkzeug-Verlauf (liegt in der Seite): Zurück schließt ihn.
//   8  Produkt-Dialog: nach dem Schließen ist der Hintergrund wieder frei (aria-hidden fehlte beim Aufräumen).
//   9  Abgelaufene Entwürfe (> 24 h) verschwinden beim App-Start, frische bleiben.
//
//   node tests/zurueck-dialog-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3352, DB = '/tmp/zurueck-dialog-ui.db', LOG = '/tmp/zurueck-dialog-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

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
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    await req('POST', '/api/tools', admin, { name: 'Bohrhammer' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    seite.setDefaultTimeout(15000);
    seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pwAdmin);
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForFunction(() => document.querySelector('.main')); await sleep(800);

    const hin = async (r) => { await seite.evaluate((r) => { location.hash = r; }, r);
      await seite.waitForFunction((r) => location.hash === '#' + r && document.querySelector('.main') && !document.querySelector('.main .spinner'), {}, r); await sleep(500); };
    const zurueck = async () => { await seite.evaluate(() => history.back()); await sleep(700); };
    const offen = () => seite.evaluate(() => document.querySelectorAll('.dialog-modal, .absence-form-overlay').length);
    const adr = () => seite.evaluate(() => location.hash);

    console.log('1. Zurück schließt den Dialog, die Seite bleibt');
    for (const [art, aufruf] of [['Bestätigen', "confirmModal('Wirklich?')"], ['Eingabe', "promptModal('Grund?')"],
      ['Auswahl', "choiceModal('Welche?', [{ value: 'a', label: 'A' }])"]]) {
      await hin('/welcome'); await hin('/bulletin');
      await seite.evaluate((a) => { window._erg = 'offen'; eval(a).then(v => { window._erg = v; }); }, aufruf);
      await seite.waitForSelector('.dialog-modal');
      await zurueck();
      const erg = await seite.evaluate(() => window._erg);
      ok(`${art}: zu, Seite bleibt „Aushänge", Ergebnis „abgebrochen" (${JSON.stringify(erg)})`,
        (await offen()) === 0 && (await adr()) === '#/bulletin' && (erg === false || erg === null), JSON.stringify({ offen: await offen(), adr: await adr(), erg }));
    }

    console.log('2. Nach normalem Schließen wechselt Zurück wie gewohnt die Seite');
    await hin('/welcome'); await hin('/bulletin');
    await seite.evaluate(() => { confirmModal('Wirklich?'); });
    await seite.waitForSelector('.dialog-modal [data-act="cancel"]');
    await seite.click('.dialog-modal [data-act="cancel"]'); await sleep(600);
    await zurueck();
    ok('Abbrechen, dann Zurück → zurück auf die Willkommensseite (ein Tastendruck)', (await adr()) === '#/welcome', await adr());

    console.log('3. OK springt auf eine andere Seite — der Sprung bleibt');
    await hin('/welcome'); await hin('/bulletin');
    await seite.evaluate(() => { confirmModal('Weiter?', { danger: false }).then(ok => { if (ok) navigate('/konto'); }); });
    await seite.waitForSelector('.dialog-modal [data-act="ok"]');
    await seite.click('.dialog-modal [data-act="ok"]');
    await seite.waitForFunction(() => location.hash === '#/konto'); await sleep(1200);
    ok('nach OK auf „Mein Konto" — und dort geblieben (nicht vom Entfernen des Dialog-Schritts zurückgeholt)', (await adr()) === '#/konto', await adr());
    await zurueck();
    ok('Zurück von dort → „Aushänge" (die Seite davor)', (await adr()) === '#/bulletin', await adr());

    console.log('4. Dialog auf Dialog');
    await hin('/welcome'); await hin('/bulletin');
    await seite.evaluate(() => { window._zwei = 'offen';
      confirmModal('Wiederherstellen?', { danger: false }).then(ok => { if (ok) promptModal('Begründung?').then(v => { window._zwei = v; }); }); });
    await seite.waitForSelector('.dialog-modal [data-act="ok"]');
    await seite.click('.dialog-modal [data-act="ok"]');
    await seite.waitForSelector('#pm-input'); await sleep(600);
    await zurueck();
    ok('Zurück schließt die Begründung, Seite bleibt', (await offen()) === 0 && (await adr()) === '#/bulletin' && (await seite.evaluate(() => window._zwei)) === null,
      JSON.stringify({ offen: await offen(), adr: await adr() }));
    await zurueck();
    ok('nächstes Zurück → Willkommensseite', (await adr()) === '#/welcome', await adr());

    console.log('5. Abwesenheits-Formular: Zurück sichert, Abbrechen verwirft');
    const formAuf = async () => { await seite.click('#absence-new-btn'); await seite.waitForSelector('#abs-comment'); await sleep(300); };
    await hin('/welcome'); await hin('/absences');
    await formAuf();
    await seite.type('#abs-comment', 'Arzttermin');
    await zurueck();
    ok('Zurück: Formular zu, Seite bleibt, Meldung „Entwurf gesichert"', (await offen()) === 0 && (await adr()) === '#/absences'
      && /Entwurf gesichert/.test(await seite.evaluate(() => (document.getElementById('toast') || document.body).innerText)), JSON.stringify({ offen: await offen(), adr: await adr() }));
    await formAuf();
    ok('wieder geöffnet: der Entwurf wird angeboten', !!(await seite.$('.draft-bar')));
    await seite.click('#abs-cancel'); await sleep(400);
    await formAuf();
    ok('nach „Abbrechen" ist er weg: nichts mehr angeboten', !(await seite.$('.draft-bar')));
    await seite.click('#abs-cancel'); await sleep(400);

    console.log('6. Seitenwechsel bei offenem Dialog');
    await hin('/welcome'); await hin('/bulletin');
    await seite.evaluate(() => { promptModal('Grund?'); });
    await seite.waitForSelector('#pm-input');
    await seite.evaluate(() => { location.hash = '/konto'; });
    await seite.waitForFunction(() => location.hash === '#/konto' && document.getElementById('konto-avatar')); await sleep(600);
    ok('der Dialog geht mit dem Seitenwechsel zu', (await offen()) === 0);
    await zurueck(); await sleep(300);
    ok('ein Zurück → „Aushänge" (der liegengebliebene Dialog-Schritt wird übersprungen)', (await adr()) === '#/bulletin', await adr());
    await zurueck();
    ok('noch ein Zurück → Willkommensseite (kein toter Tastendruck)', (await adr()) === '#/welcome', await adr());

    console.log('7. Werkzeug-Verlauf');
    await hin('/welcome'); await hin('/tools');
    await seite.click('.tool-history'); await sleep(600);
    const sichtbar = () => seite.evaluate(() => getComputedStyle(document.getElementById('tool-history-modal')).display !== 'none');
    ok('Verlauf offen', await sichtbar());
    await zurueck();
    ok('Zurück schließt ihn, Seite bleibt „Werkzeuge"', !(await sichtbar()) && (await adr()) === '#/tools', await adr());

    console.log('8. Produkt-Dialog räumt auf');
    await hin('/produkte');
    await seite.evaluate(() => { const b = document.getElementById('pv-neu'); if (b) b.click(); });
    const produktDialog = await seite.waitForSelector('#pnp-name', { timeout: 5000 }).then(() => true, () => false);
    if (produktDialog) {
      await seite.click('.dialog-modal [data-act="cancel"]'); await sleep(400);
      ok('nach Abbrechen: Hintergrund wieder für Screenreader frei (kein aria-hidden)', await seite.evaluate(() => !document.getElementById('app').hasAttribute('aria-hidden')));
      await seite.evaluate(() => { document.getElementById('pv-neu').click(); }); await seite.waitForSelector('#pnp-name');
      await zurueck();
      ok('Zurück schließt ihn ebenso, Seite bleibt', (await offen()) === 0 && (await adr()) === '#/produkte' && await seite.evaluate(() => !document.getElementById('app').hasAttribute('aria-hidden')));
    } else ok('Produkt-Dialog ließ sich öffnen', false, 'kein #pv-neu / #pnp-name');

    console.log('9. Abgelaufene Entwürfe beim Start weg');
    await seite.evaluate(() => {
      const alt = Date.now() - 25 * 60 * 60 * 1000;
      localStorage.setItem(ENTWURF_PRAEFIX + S.user.id + ':probe-alt', JSON.stringify({ t: alt, f: { x: 'alt' } }));
      localStorage.setItem(ENTWURF_PRAEFIX + S.user.id + ':probe-frisch', JSON.stringify({ t: Date.now(), f: { x: 'frisch' } }));
    });
    await seite.goto(BASIS + '/?neu=' + Date.now() + '#/bulletin', { waitUntil: 'domcontentloaded' });
    await seite.waitForFunction(() => document.querySelector('.main')); await sleep(800);
    const reste = await seite.evaluate(() => Object.keys(localStorage).filter(k => k.includes(':probe-')));
    ok('nach dem Start: alter weg, frischer da', reste.length === 1 && reste[0].endsWith(':probe-frisch'), JSON.stringify(reste));
    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nZurück schließt den Dialog: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
