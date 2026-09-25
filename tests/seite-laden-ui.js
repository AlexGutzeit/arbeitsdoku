// Seiten laden: Fehleranzeige und Veraltet-Waechter auf JEDER Seite (R4 + R5, 25.09.2026).
//
// Vorher dachten nur vier von ueber zwanzig Seiten an beides:
//   R4  Scheitert das Laden (Baustelle ohne Empfang), drehte der Kreisel ewig — oder, schlimmer,
//       die Seite zeigte eine LEERE Liste, als gaebe es nichts. Kein „Erneut versuchen".
//   R5  Eine langsame Antwort ueberschrieb die inzwischen geoeffnete Seite: Adresse und Menue
//       sagten „Mein Konto", zu sehen war das Auftrags-Board.
// Jetzt laufen alle Seiten ueber seiteLaden() (app-1-core.js). Dieser Test geht JEDE Seite durch:
//   A  Netz weg beim Laden → Fehleranzeige mit Knopf; Knopf laedt nach, sobald das Netz zurueck ist.
//   B  Langsame Antwort, man wechselt vorher die Seite → die neue Seite bleibt stehen.
//   C  Sitzung endet mitten im Laden → Anmeldeseite, keine halb gezeichnete Seite, kein Absturz.
//   D  Bestellungen: ohne Netz bewusst MIT Seite (Katalog-Spiegel), bei Serverfehler Fehleranzeige.
//
//   node tests/seite-laden-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3328, DB = '/tmp/seite-laden-ui.db', LOG = '/tmp/seite-laden-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const VERZ = 1500;   // so lange haelt Teil B die Antworten der ALTEN Seite zurueck
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
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;

    // ── Daten, damit auch die Seiten mit Kennung etwas zu laden haben ──
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Laden-Testauftrag' })).body.project;
    const eintrag = (await req('POST', '/api/entries', admin, { date: '2026-09-09', time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: maxId })).body.entry;
    await req('POST', '/api/planning', admin, { client: 'Laden-Test', assigned_user_ids: [maxId],
      days: [{ date: '2027-12-06', time_from: '07:00', time_to: '16:00' }, { date: '2027-12-07', time_from: '07:00', time_to: '16:00' }] });
    const plan = ((await req('GET', '/api/planning?from=2027-12-01&to=2027-12-31', admin)).body.entries || [])[0];
    const aushang = (await req('POST', '/api/bulletin', admin, { title: 'Laden-Aushang', text: 'x' })).body.entry;
    if (!projekt || !eintrag || !plan || !aushang) throw new Error('Testdaten fehlen: ' + JSON.stringify({ projekt: !!projekt, eintrag: !!eintrag, plan: !!plan, aushang: !!aushang }));

    // Jede Adresse, die der Router kennt und die etwas laedt (app-1-core.js, render()).
    const SEITEN = [
      '/welcome', '/dashboard',
      '/entry/new', '/entry/' + eintrag.id, '/entry/continue/' + eintrag.id, '/entry/from-project/' + projekt.id,
      '/planning', '/planning/new', '/planning/edit/' + plan.id, '/planning/replan/' + plan.id,
      '/planning/edit-group/' + plan.group_id, '/planning/accept/' + plan.id, '/planning/from-project/' + projekt.id,
      '/users', '/projects', '/settings', '/audit',
      '/deleted-entries', '/deleted-absences', '/deleted-projects', '/deleted-users',
      '/documents', '/pdf', '/statistics', '/produkte', '/tools', '/notes',
      '/absences', '/absences/urlaub', '/bulletin', '/bulletin/edit/' + aushang.id,
      '/impressum', '/datenschutz',
    ];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 900 });
    seite.setDefaultTimeout(30000);
    let jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));

    // Das „Netz" dieses Tests: Nur lesende API-Anfragen werden gestoert — die Live-Verbindung
    // (/api/events) bleibt, sonst misst man ihre Wiederverbindung mit.
    let modus = 'normal';
    await seite.setRequestInterception(true);
    seite.on('request', r => {
      const u = r.url();
      const betroffen = u.includes('/api/') && !u.includes('/api/events') && r.method() === 'GET';
      const weiter = () => r.continue().catch(() => {});
      if (!betroffen || modus === 'normal') return weiter();
      if (modus === 'abbrechen') return r.abort('internetdisconnected').catch(() => {});
      if (modus === 'fehler500') return r.respond({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: 'Testfehler vom Server' }) }).catch(() => {});
      if (modus === 'abgemeldet') return r.respond({ status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: 'Sitzung beendet', code: 'SITZUNG_BEENDET' }) }).catch(() => {});
      if (modus === 'verzoegern') { setTimeout(weiter, VERZ); return; }
      weiter();
    });

    const anmelden = async () => {
      // Eigene Adresse je Anmeldung: Ein goto, das sich nur im #-Teil unterscheidet, laedt nicht neu.
      await seite.goto(BASIS + '/?anmeldung=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
      await seite.waitForSelector('#login-user');
      await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pw('admin'));
      await seite.click('#login-form button[type="submit"]');
      const drin = await seite.waitForFunction(() => document.querySelector('.main'), { timeout: 10000 }).then(() => true, () => false);
      if (!drin) throw new Error('Anmeldung haengt: ' + JSON.stringify(await seite.evaluate(() => ({
        adresse: location.hash, text: document.body.innerText.slice(0, 200) }))));
      await sleep(800);
    };
    const hash = (r) => seite.evaluate((r) => { location.hash = r; }, r);
    // Ausgangspunkt: eine Seite, die NICHTS laedt. So feuert jeder Wechsel ein echtes hashchange.
    const START = '/bulletin/new';
    const zumStart = async () => {
      // Steht die Adresse schon dort, feuert kein hashchange — dann direkt neu zeichnen.
      await seite.evaluate((r) => { if (location.hash === '#' + r) render(); else location.hash = r; }, START);
      await seite.waitForFunction(() => !!document.getElementById('bulletin-form'), { timeout: 8000 });
      await sleep(150);
    };
    const warte = (fn, ms, ...args) => seite.waitForFunction(fn, { timeout: ms }, ...args).then(() => true, () => false);

    await anmelden();

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nA — Netz weg beim Laden: Fehleranzeige mit „Erneut versuchen" (R4)');
    for (const r of SEITEN) {
      modus = 'normal'; await zumStart(); jsFehler = [];
      modus = 'abbrechen';
      await hash(r);
      const fehlerDa = await warte(() => !!document.querySelector('.load-error'), 6000);
      const bild = await seite.evaluate(() => {
        const box = document.querySelector('.load-error');
        return {
          knopf: !!(box && [...box.querySelectorAll('button')].some(b => /Erneut versuchen/.test(b.textContent))),
          text: box ? box.innerText.replace(/\s+/g, ' ').trim() : '',
          kreisel: !!document.querySelector('.main .spinner, #legal-body .spinner'),
          adresse: location.hash,
        };
      });
      const lesbar = fehlerDa && bild.knopf && !bild.kreisel && bild.adresse === '#' + r
        && /Keine Verbindung/.test(bild.text) && !/gespeichert/.test(bild.text);
      // Netz zurueck → Knopf → die Seite muss wirklich kommen (kein Fehler, kein Kreisel, Inhalt)
      modus = 'normal';
      if (bild.knopf) await seite.evaluate(() => [...document.querySelectorAll('.load-error button')].find(b => /Erneut versuchen/.test(b.textContent)).click());
      const geladen = bild.knopf && await warte(() => {
        const m = document.getElementById('legal-body') || document.querySelector('.main');
        return m && !document.querySelector('.load-error') && !m.querySelector('.spinner') && m.innerText.trim().length > 10;
      }, 8000);
      ok(`${r}: Fehleranzeige + Knopf, danach geladen`, lesbar && geladen && !jsFehler.length,
        JSON.stringify({ fehlerDa, ...bild, geladen, jsFehler: jsFehler.slice(0, 2) }));
    }

    // Das Projektformular ist keine eigene Adresse, sondern wird vom Board aus geoeffnet.
    modus = 'normal'; await hash('/projects');
    await seite.waitForFunction(() => location.hash === '#/projects' && !document.querySelector('.main .spinner'));
    await sleep(300);
    modus = 'abbrechen';
    await seite.evaluate(() => { _boardUsers = []; _boardKategorien = []; renderProjectForm(null); });
    const pfFehler = await warte(() => !!document.querySelector('.load-error'), 6000);
    modus = 'normal';
    if (pfFehler) await seite.evaluate(() => document.querySelector('.load-error button').click());
    ok('Projektformular (vom Board aus): Fehleranzeige, danach das Formular',
      pfFehler && await warte(() => !!document.getElementById('projekt-form'), 6000));

    // Serverfehler statt Funkloch: dieselbe Anzeige, mit der Meldung des Servers
    modus = 'normal'; await zumStart();
    modus = 'fehler500'; await hash('/tools');
    const f500 = await warte(() => /Testfehler vom Server/.test((document.querySelector('.load-error') || {}).innerText || ''), 6000);
    ok('Serverfehler (500): Fehleranzeige mit der Meldung des Servers', f500);

    // Mein Konto baut sich kartenweise auf — dort darf nur nichts ewig kreiseln.
    modus = 'normal'; await zumStart();
    modus = 'abbrechen'; await hash('/konto');
    await sleep(3000);
    const kontoKreisel = await seite.evaluate(() => [...document.querySelectorAll('.main .spinner')].map(s => (s.closest('[id]') || {}).id));
    ok('Mein Konto ohne Netz: kein Kreisel dreht ewig', kontoKreisel.length === 0, JSON.stringify(kontoKreisel));
    modus = 'normal';

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nB — langsame Antwort, inzwischen andere Seite: die neue bleibt (R5)');
    for (const [i, r] of [...SEITEN, '/konto', '/orders'].entries()) {
      // Abwechselnd zwei Ziele: eines, das SELBST nichts laedt (nur der zentrale Zaehler in
      // render() schuetzt es), und eines, das selbst laedt.
      const ziel = i % 2 ? '/konto' : START;
      modus = 'normal'; await zumStart();
      if (ziel === START) { await hash('/welcome'); await warte(() => !document.querySelector('.main .spinner'), 6000); }
      jsFehler = [];
      modus = 'verzoegern';
      await hash(r);
      await sleep(250);
      modus = 'normal';
      await hash(ziel);
      await sleep(VERZ + 1500);   // jetzt sind die zurueckgehaltenen Antworten laengst da
      const bild = await seite.evaluate(() => ({
        adresse: location.hash,
        formular: !!document.getElementById('bulletin-form'),
        konto: !!document.getElementById('konto-2fa'),
        menue: ((document.querySelector('.nav-item.active, .sidebar a.active, nav a.active') || {}).textContent || '').trim(),
        fehler: !!document.querySelector('.load-error'),
      }));
      const stimmt = bild.adresse === '#' + ziel && !bild.fehler && (ziel === START ? bild.formular : bild.konto);
      ok(`${r} → ${ziel}: neue Seite bleibt stehen`, stimmt && !jsFehler.length, JSON.stringify({ ...bild, jsFehler: jsFehler.slice(0, 2) }));
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nC — Sitzung endet mitten im Laden');
    for (const r of ['/documents', '/pdf', '/entry/new', '/settings']) {
      modus = 'normal'; await zumStart(); jsFehler = [];
      modus = 'abgemeldet';
      await hash(r);
      const anmeldung = await warte(() => !!document.getElementById('login-user'), 6000);
      await sleep(1000);   // Zeit genug, dass eine halbe Seite noch nachgezeichnet haette
      const bild = await seite.evaluate(() => ({ login: !!document.getElementById('login-user'), main: !!document.querySelector('.main') }));
      ok(`${r}: Anmeldeseite, nichts drübergezeichnet, kein Absturz`, anmeldung && bild.login && !bild.main && !jsFehler.length,
        JSON.stringify({ ...bild, jsFehler: jsFehler.slice(0, 2) }));
      modus = 'normal';
      await anmelden();
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\nD — Bestellungen: ohne Netz mit Seite, bei Serverfehler Fehleranzeige');
    modus = 'normal'; await zumStart();
    modus = 'abbrechen'; await hash('/orders');
    const ohneNetz = await warte(() => !!document.getElementById('order-add-btn') && !document.querySelector('.load-error'), 8000);
    ok('ohne Netz: die Bestellseite erscheint trotzdem (Katalog-Spiegel), keine Fehleranzeige', ohneNetz);
    modus = 'normal'; await zumStart();
    modus = 'fehler500'; await hash('/orders');
    const mit500 = await warte(() => !!document.querySelector('.load-error'), 8000);
    modus = 'normal';
    if (mit500) await seite.evaluate(() => document.querySelector('.load-error button').click());
    ok('Serverfehler: Fehleranzeige, „Erneut versuchen" holt die Seite', mit500
      && await warte(() => !!document.getElementById('order-add-btn'), 8000));

  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
