// Die Oberfläche: Seite „Mein Konto", Code-Abfrage beim Anmelden, Einrichtungs-Zwang.
//
// Der wichtigste Punkt in diesem Test ist unscheinbar: Der QR-Code muss WIRKLICH ANKOMMEN. Die
// Sicherheitsrichtlinie der App erlaubt Bilder nur von der eigenen Herkunft (`img-src 'self'`) —
// ein QR als data:-Bild würde der Browser stumm verwerfen, ohne Fehlermeldung im Code. Deshalb
// wird hier geprüft, dass ein <svg> im Baum steht UND dass die Browser-Konsole dabei keine
// Richtlinien-Verletzung meldet.
//
//   node tests/twofa-konto-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const totp = require('../totp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3251, DB = '/tmp/twofa-konto-ui.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function frischesFenster() {
  const start = totp.schrittFuer(Date.now());
  while (totp.schrittFuer(Date.now()) === start) await sleep(500);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/twofa-konto-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/twofa-konto-ui-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seiteMachen = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 420, height: 900 });
      page.setDefaultTimeout(45000);
      page.__meldungen = [];
      page.on('console', m => { if (m.type() === 'error') page.__meldungen.push(m.text()); });
      page.on('pageerror', e => page.__meldungen.push('Seitenfehler: ' + String(e)));
      return page;
    };
    const anmelden = async (page, user, passwort) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', user); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
      await sleep(1800);
    };

    console.log('── Menüpunkt „Mein Konto" gibt es für JEDE Rolle ──');
    for (const [rolle, name] of [['max', 'Mitarbeiter'], ['buchhalter', 'Buchhalter'], ['chef', 'Chef']]) {
      const page = await seiteMachen();
      await anmelden(page, rolle, pw(rolle));
      const da = await page.$('a[href="#/konto"]');
      ok(`${name} sieht den Menüpunkt`, !!da);
      await page.close();
    }

    console.log('\n── Passwort ändern über die Seite ──');
    let page = await seiteMachen();
    await anmelden(page, 'max', pw('max'));
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#konto-pw-form'); await sleep(800);
    ok('die Passwort-Karte ist da', !!(await page.$('#pw-alt')));
    ok('… mit der Live-Prüfliste', !!(await page.$('#pw-neu-reqs')));
    await page.type('#pw-neu', 'Ab1!');
    await sleep(300);
    const listeGefuellt = await page.$eval('#pw-neu-reqs', el => el.children.length);
    ok('… und die Prüfliste füllt sich beim Tippen (sie ist wirklich verdrahtet)', listeGefuellt > 0, String(listeGefuellt));
    await page.$eval('#pw-neu', el => { el.value = ''; });
    // Falsches altes Passwort → Fehlermeldung, nichts passiert
    await page.type('#pw-alt', 'Falsch1234!');
    await page.type('#pw-neu', 'Frisch2026!');
    await page.type('#pw-neu2', 'Frisch2026!');
    await page.click('#konto-pw-form button[type="submit"]');
    await sleep(1200);
    const fehlerText = await page.$eval('#pw-fehler', el => el.textContent);
    ok('falsches aktuelles Passwort → Meldung', /stimmt nicht/i.test(fehlerText), fehlerText);
    // Richtig
    await page.$eval('#pw-alt', el => { el.value = ''; });
    await page.type('#pw-alt', pw('max'));
    await page.click('#konto-pw-form button[type="submit"]');
    await sleep(1500);
    ok('mit richtigem alten Passwort klappt es',
      (await req('POST', '/api/auth/login', null, { username: 'max', password: 'Frisch2026!' })).status === 200);
    await page.close();

    console.log('\n── Zwei-Faktor einrichten: der QR-Code muss WIRKLICH ankommen ──');
    page = await seiteMachen();
    await anmelden(page, 'max', 'Frisch2026!');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    if (!(await page.$('#zfa-start'))) {
      const lage = await page.evaluate(() => ({
        hash: location.hash,
        angemeldet: !!localStorage.getItem('token'),
        text: (document.querySelector('.main') || document.body).innerText.slice(0, 200),
      }));
      ok('Einrichten-Knopf ist da', false, JSON.stringify(lage) + ' | Konsole: ' + page.__meldungen.slice(0, 2).join(' | '));
      throw new Error('Abbruch: ' + JSON.stringify(lage));
    }
    await page.click('#zfa-start');
    await page.waitForSelector('#zfa-qr', { timeout: 20000 }); await sleep(600);
    const qr = await page.evaluate(() => {
      const b = document.querySelector('#zfa-qr');
      const svg = b ? b.querySelector('svg') : null;
      const r = svg ? svg.getBoundingClientRect() : null;
      return { svgDa: !!svg, breite: r ? Math.round(r.width) : 0, hoehe: r ? Math.round(r.height) : 0,
               sichtbar: !!(svg && svg.checkVisibility && svg.checkVisibility()) };
    });
    ok('ein <svg> steht im Baum', qr.svgDa, JSON.stringify(qr));
    ok('… es hat eine echte Fläche (nicht 0×0)', qr.breite > 100 && qr.hoehe > 100, JSON.stringify(qr));
    ok('… und ist sichtbar', qr.sichtbar, JSON.stringify(qr));
    const csp = page.__meldungen.filter(m => /Content Security Policy|Refused to load/i.test(m));
    ok('die Browser-Konsole meldet KEINE Verletzung der Sicherheitsrichtlinie',
      csp.length === 0, csp.slice(0, 2).join(' | '));
    const geheimText = await page.$eval('#zfa-einrichtung code', el => el.textContent.trim());
    ok('der Schlüssel steht zum Abtippen da', /^[A-Z2-7]{32}$/.test(geheimText), geheimText);

    // Falscher Code
    await page.type('#zfa-code', '000000');
    await page.click('#zfa-verify button[type="submit"]');
    await sleep(1200);
    ok('falscher Code → Meldung, noch nicht aktiv',
      /stimmt nicht/i.test(await page.$eval('#zfa-fehler', el => el.textContent)));
    // Richtiger Code
    await page.$eval('#zfa-code', el => { el.value = ''; });
    await page.type('#zfa-code', totp.code(geheimText));
    await page.click('#zfa-verify button[type="submit"]');
    await sleep(1800);
    const nachher = await page.$eval('#konto-2fa', el => el.innerText);
    ok('nach dem richtigen Code steht die Karte auf „Aktiv"', /Aktiv/.test(nachher), nachher.slice(0, 90));
    await page.close();

    console.log('\n── Anmelden mit Code ──');
    const adminToken = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('PUT', '/api/settings', adminToken, { twofa_mitarbeiter: 'immer' });
    await frischesFenster();
    page = await seiteMachen();
    await anmelden(page, 'max', 'Frisch2026!');
    ok('die Anmeldemaske fragt nach dem Code', !!(await page.$('#login-code')));
    ok('… und bei „jedes Mal" gibt es kein „Gerät merken"', !(await page.$('#login-geraet-merken')));
    await page.type('#login-code', '000000');
    await page.click('#code-form button[type="submit"]');
    await sleep(1500);
    ok('falscher Code → Meldung, man bleibt in der Maske',
      !!(await page.$('#login-code')) && /stimmt nicht/i.test(await page.$eval('#login-error', el => el.textContent)));
    await page.type('#login-code', totp.code(geheimText));
    await page.click('#code-form button[type="submit"]');
    await sleep(2500);
    ok('richtiger Code → man ist drin',
      await page.evaluate(() => !!localStorage.getItem('token')));
    ok('… und landet auf der Willkommensseite',
      /#\/welcome/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
    await page.close();

    console.log('\n── Einrichtungs-Zwang: der Chef kommt nur noch auf „Mein Konto" ──');
    await req('PUT', '/api/settings', adminToken, { twofa_chef: 'woechentlich' });
    page = await seiteMachen();
    await anmelden(page, 'chef', pw('chef'));
    await sleep(1200);
    ok('landet auf „Mein Konto"', /#\/konto/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash));
    ok('… mit einer Erklärung, warum', /vorgeschrieben|einrichten/i.test(await page.$eval('.welcome-page', el => el.innerText)));
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    ok('… und der Versuch, woandershin zu gehen, führt zurück',
      /#\/konto/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
    ok('… er wird dabei NICHT abgemeldet', await page.evaluate(() => !!localStorage.getItem('token')));
    await page.close();

    console.log('\n── Einstellungs-Karte beim Admin ──');
    page = await seiteMachen();
    await anmelden(page, 'admin', pw('admin'));
    await page.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#twofa-form'); await sleep(600);
    for (const rolle of ['admin', 'chef', 'buchhalter', 'mitarbeiter']) {
      ok(`Auswahlfeld für ${rolle} ist da`, !!(await page.$('#s-twofa-' + rolle)));
    }
    const optionen = await page.$$eval('#s-twofa-chef option', els => els.map(e => e.value));
    ok('… mit allen sechs Möglichkeiten',
      ['aus', 'immer', 'geraet', 'taeglich', 'woechentlich', 'monatlich'].every(m => optionen.includes(m)), optionen.join(','));
    ok('… und die gespeicherten Werte stehen drin',
      (await page.$eval('#s-twofa-mitarbeiter', el => el.value)) === 'immer');
    ok('ein Warnhinweis erklärt die Folgen',
      /kommt vorher nicht weiter/i.test(await page.$eval('#twofa-form', el => el.parentElement.innerText)));
    ok('für den Admin ist das Admin-Feld bedienbar',
      !(await page.$eval('#s-twofa-admin', el => el.disabled)));
    await page.close();

    console.log('\n── … und beim Chef ist das Admin-Feld gesperrt ──');
    // Chef braucht dafuer erst seinen Authenticator (sonst greift der Zwang).
    await req('PUT', '/api/settings', adminToken, { twofa_chef: 'aus' });
    page = await seiteMachen();
    await anmelden(page, 'chef', pw('chef'));
    await page.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#twofa-form'); await sleep(600);
    ok('das Admin-Feld ist für den Chef gesperrt',
      await page.$eval('#s-twofa-admin', el => el.disabled));
    ok('… die anderen darf er bedienen',
      !(await page.$eval('#s-twofa-mitarbeiter', el => el.disabled)));
    await page.close();

    console.log('\n── Der Schlüssel überlebt das Abschalten (Buchhalter, Rolle „aus") ──');
    page = await seiteMachen();
    await anmelden(page, 'buchhalter', pw('buchhalter'));
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#zfa-start'); await sleep(600);
    await page.click('#zfa-start');
    await page.waitForSelector('#zfa-qr'); await sleep(700);
    const buGeheim = await page.$eval('#zfa-einrichtung code', el => el.textContent.trim());
    await page.type('#zfa-code', totp.code(buGeheim));
    await page.click('#zfa-verify button[type="submit"]');
    await sleep(2000);
    ok('nach der Einrichtung steht „Aktiv"', /Aktiv/.test(await page.$eval('#konto-2fa', el => el.innerText)));
    ok('… und es gibt den Knopf „Neuen Schlüssel erzeugen"', !!(await page.$('#zfa-neu')));

    // Abschalten
    await frischesFenster();
    await page.type('#zfa-aus-code', totp.code(buGeheim));
    await page.click('#konto-2fa-aus button[type="submit"]');
    await sleep(2000);
    const nachAus = await page.$eval('#konto-2fa', el => el.innerText);
    ok('nach dem Abschalten steht dort NICHT „Einrichten", sondern „Wieder aktivieren"',
      /Wieder aktivieren/.test(nachAus) && !/^\s*Einrichten\s*$/m.test(nachAus), nachAus.slice(0, 140));
    ok('… mit dem Hinweis, dass der Authenticator noch bekannt ist',
      /bereits einen Authenticator/i.test(nachAus), nachAus.slice(0, 140));
    ok('… und einem Code-Feld statt eines QR-Codes',
      !!(await page.$('#zfa-code')) && !(await page.$('#zfa-qr')));

    // Mit dem ALTEN Code reaktivieren
    await frischesFenster();
    await page.type('#zfa-code', totp.code(buGeheim));
    await page.click('#zfa-verify button[type="submit"]');
    await sleep(2000);
    ok('der alte Code reaktiviert — kein neues Einlernen nötig',
      /Aktiv/.test(await page.$eval('#konto-2fa', el => el.innerText)));

    console.log('\n── „Neuen Schlüssel erzeugen" warnt deutlich ──');
    await page.click('#zfa-neu');
    await page.waitForSelector('.modal-overlay'); await sleep(400);
    const warnung = await page.$eval('.modal-overlay .modal-body', el => el.innerText);
    ok('ein Dialog erscheint', warnung.length > 0);
    ok('… er sagt, dass die App NEU eingelernt werden muss', /neu einlernen/i.test(warnung), warnung.slice(0, 120));
    ok('… und beruhigt, dass man sich nicht aussperrt', /nicht aus/i.test(warnung), warnung.slice(0, 200));
    // Abbrechen ändert nichts
    await page.click('.modal-overlay [data-act="cancel"]'); await sleep(700);
    ok('Abbrechen lässt alles, wie es war',
      /Aktiv/.test(await page.$eval('#konto-2fa', el => el.innerText)) && !(await page.$('#zfa-qr')));
    // Bestätigen liefert einen neuen QR
    await page.click('#zfa-neu');
    await page.waitForSelector('.modal-overlay'); await sleep(300);
    await page.click('.modal-overlay [data-act="ok"]');
    await page.waitForSelector('#zfa-qr', { timeout: 20000 }); await sleep(700);
    const neuGeheim = await page.$eval('#zfa-einrichtung code', el => el.textContent.trim());
    ok('ein neuer QR-Code erscheint', !!(await page.$('#zfa-qr svg')));
    ok('… mit einem anderen Schlüssel', neuGeheim !== buGeheim, `${buGeheim.slice(0, 8)}… → ${neuGeheim.slice(0, 8)}…`);
    ok('… und einem Hinweis, dass bis zur Bestätigung der alte gilt',
      /bisheriger/i.test(await page.$eval('#zfa-einrichtung', el => el.innerText)));
    await page.close();

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
