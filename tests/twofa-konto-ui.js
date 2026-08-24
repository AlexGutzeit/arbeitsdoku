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

// Seit dem 23.08.2026 verlangt das Scharfschalten einer Rolle (von „aus" auf eine Pflicht) einen
// gueltigen Code des Aufrufers — siehe tests/twofa-scharfschalten.js. Das erledigt hier ein
// EIGENER Admin: Ein eingerichteter Authenticator aendert das Anmeldeverhalten seines Besitzers,
// und genau darum geht es in diesem Test beim Haupt-Admin nicht.
//
// Der Wiederverwendungs-Riegel nimmt nur STEIGENDE Zeitschritte. Deshalb wartet der Helfer
// notfalls auf ein frisches Fenster (hoechstens 30 Sekunden) — genau wie ein Mensch es muesste.
let _sTok = null, _sGeheim = null, _sSchritt = -1;
async function scharfSchalten(adminToken, werte) {
  if (!_sTok) {
    await req('POST', '/api/users', adminToken,
      { username: 'scharfschalter', password: 'Test1234!', name: 'Scharf Schalter', role: 'admin' });
    _sTok = (await req('POST', '/api/auth/login', null, { username: 'scharfschalter', password: 'Test1234!' })).body.token;
    _sGeheim = (await req('POST', '/api/auth/2fa/setup', _sTok, {})).body.geheim;
    await req('POST', '/api/auth/2fa/verify', _sTok, { code: totp.code(_sGeheim) });
    _sSchritt = Math.floor(Date.now() / 30000);
  }
  while (Math.floor(Date.now() / 30000) + 1 <= _sSchritt) await sleep(1000);
  _sSchritt = Math.floor(Date.now() / 30000) + 1;
  return req('PUT', '/api/settings', _sTok, { ...werte, twofa_code: totp.code(_sGeheim, Date.now() + 30000) });
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
    // Klicken, aber vorher mittig scrollen.
    //
    // Puppeteer scrollt ein Element von sich aus nur so weit in den Sichtbereich, dass es gerade
    // hineinragt — bei dieser App landet es damit UNTER der klebenden Kopfzeile, und der Klick
    // trifft den Kopf statt den Knopf. Genau daran ist dieser Abschnitt beim ersten Lauf
    // gescheitert: kein Absende-Ereignis, keine Anfrage, keine Fehlermeldung.
    const klick = async (page, sel) => {
      await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
      await sleep(250);
      await page.click(sel);
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
    await klick(page, '#konto-pw-form button[type="submit"]');
    await sleep(1200);
    const fehlerText = await page.$eval('#pw-fehler', el => el.textContent);
    ok('falsches aktuelles Passwort → Meldung', /stimmt nicht/i.test(fehlerText), fehlerText);
    // Richtig
    await page.$eval('#pw-alt', el => { el.value = ''; });
    await page.type('#pw-alt', pw('max'));
    await klick(page, '#konto-pw-form button[type="submit"]');
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
    await klick(page, '#zfa-start');
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
    await klick(page, '#zfa-verify button[type="submit"]');
    await sleep(1200);
    ok('falscher Code → Meldung, noch nicht aktiv',
      /stimmt nicht/i.test(await page.$eval('#zfa-fehler', el => el.textContent)));
    // Richtiger Code
    await page.$eval('#zfa-code', el => { el.value = ''; });
    await page.type('#zfa-code', totp.code(geheimText));
    await klick(page, '#zfa-verify button[type="submit"]');
    await sleep(1800);
    const nachher = await page.$eval('#konto-2fa', el => el.innerText);
    ok('nach dem richtigen Code steht die Karte auf „Aktiv"', /Aktiv/.test(nachher), nachher.slice(0, 90));
    await page.close();

    console.log('\n── Anmelden mit Code ──');
    const adminToken = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await scharfSchalten(adminToken, { twofa_mitarbeiter: 'immer' });
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
    await scharfSchalten(adminToken, { twofa_chef: 'woechentlich' });
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

    // Und wenn er eingerichtet hat, waehrend die Pflicht steht: Was sagt ihm die Karte ueber das
    // Abschalten? Frueher stand dort „Abschalten kann nur ein Administrator." — das stimmt so
    // nicht. Ein Admin kann nur ZURUECKSETZEN; danach steht der Nutzer sofort wieder vor der
    // Einrichtung. Der Satz versprach einen Ausweg, den es nicht gibt (Alex, 23.08.2026).
    const cTok = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;
    const cSetupR = await req('POST', '/api/auth/2fa/setup', cTok, {});
    ok('der Chef bekommt einen Schlüssel', !!(cSetupR.body && cSetupR.body.geheim),
      `${cSetupR.status} ${cSetupR.text.slice(0, 90)}`);
    const cVerify = await req('POST', '/api/auth/2fa/verify', cTok, { code: totp.code(cSetupR.body.geheim) });
    ok('… und bestätigt ihn', cVerify.status === 200, `${cVerify.status} ${cVerify.text.slice(0, 90)}`);
    // Neu LADEN, nicht nur den Anker setzen: Die Seite steht bereits auf #/konto, und ein goto
    // auf denselben Anker feuert kein hashchange — die Karte bliebe der alte Stand von vor der
    // Einrichtung. (Genau daran ist diese Pruefung beim ersten Versuch gescheitert.)
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#konto-2fa'); await sleep(2500);
    const karte = await page.$eval('#konto-2fa', el => el.innerText.replace(/\s+/g, ' '));
    ok('die Karte zeigt den Authenticator als aktiv', /Aktiv/i.test(karte), karte.slice(0, 120));
    ok('bei bestehender Pflicht gibt es KEIN Abschalten-Formular', !(await page.$('#konto-2fa-aus')),
      karte.slice(0, 120));
    ok('… die Karte sagt, dass es nicht abschaltbar ist', /nicht abschalten/i.test(karte), karte.slice(0, 160));
    ok('… und verspricht NICHT, ein Administrator koenne es abschalten',
      !/Abschalten kann nur ein Administrator/i.test(karte), karte.slice(0, 160));
    ok('… nennt aber das Zuruecksetzen als das, was ein Admin wirklich kann',
      /zurücksetzen/i.test(karte), karte.slice(0, 200));
    // Ausgangszustand wiederherstellen: Der Chef hat jetzt einen Authenticator, und der wuerde
    // im naechsten Abschnitt die Anmeldung um eine Code-Abfrage erweitern — der Test liefe dort
    // in eine Zeitueberschreitung, ohne dass an der App etwas waere.
    const chefId = (await req('GET', '/api/users', adminToken)).body.users.find(u => u.username === 'chef').id;
    ok('der Admin setzt den Chef wieder zurueck',
      (await req('POST', `/api/users/${chefId}/twofa-reset`, adminToken, {})).status === 200);
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
    await klick(page, '#zfa-start');
    await page.waitForSelector('#zfa-qr'); await sleep(700);
    const buGeheim = await page.$eval('#zfa-einrichtung code', el => el.textContent.trim());
    await page.type('#zfa-code', totp.code(buGeheim));
    await klick(page, '#zfa-verify button[type="submit"]');
    await sleep(2000);
    ok('nach der Einrichtung steht „Aktiv"', /Aktiv/.test(await page.$eval('#konto-2fa', el => el.innerText)));
    ok('… und es gibt den Knopf „Neuen Schlüssel erzeugen"', !!(await page.$('#zfa-neu')));

    // Abschalten
    await frischesFenster();
    await page.type('#zfa-aus-code', totp.code(buGeheim));
    await klick(page, '#konto-2fa-aus button[type="submit"]');
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
    await klick(page, '#zfa-verify button[type="submit"]');
    await sleep(2000);
    ok('der alte Code reaktiviert — kein neues Einlernen nötig',
      /Aktiv/.test(await page.$eval('#konto-2fa', el => el.innerText)));

    console.log('\n── „Neuen Schlüssel erzeugen" warnt deutlich ──');
    await klick(page, '#zfa-neu');
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
    await klick(page, '#zfa-neu');
    await page.waitForSelector('.modal-overlay'); await sleep(300);
    await page.click('.modal-overlay [data-act="ok"]');
    await page.waitForSelector('#zfa-qr', { timeout: 20000 }); await sleep(700);
    const neuGeheim = await page.$eval('#zfa-einrichtung code', el => el.textContent.trim());
    ok('ein neuer QR-Code erscheint', !!(await page.$('#zfa-qr svg')));
    ok('… mit einem anderen Schlüssel', neuGeheim !== buGeheim, `${buGeheim.slice(0, 8)}… → ${neuGeheim.slice(0, 8)}…`);
    ok('… und einem Hinweis, dass bis zur Bestätigung der alte gilt',
      /bisheriger/i.test(await page.$eval('#zfa-einrichtung', el => el.innerText)));
    await page.close();

    console.log('\n── „Mein Konto" versammelt alles Persönliche ──');
    // Bewusst der Chef: „max" hat inzwischen einen aktiven Authenticator und wuerde nach einem
    // Code gefragt (auch bei Rolle „aus" — wer freiwillig einrichtet, wird gefragt). Beim Chef ist
    // er weiter oben abgeschaltet worden, er kommt also direkt hinein.
    page = await seiteMachen();
    await anmelden(page, 'chef', pw('chef'));
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#konto-stammdaten'); await sleep(2500);
    const karten = await page.evaluate(() => ({
      avatar: !!document.querySelector('#konto-avatar h3'),
      geburtstag: !!document.querySelector('#konto-geburtstag h3'),
      passwort: !!document.querySelector('#konto-passwort h3'),
      zweiFaktor: !!document.querySelector('#konto-2fa h3'),
      benachrichtigungen: !!document.querySelector('#push-card h3'),
      stammdaten: !!document.querySelector('#konto-stammdaten h3'),
      sicherheit: !!document.querySelector('#konto-sicherheit h3'),
    }));
    for (const [name, da] of Object.entries(karten)) ok(`Karte „${name}" ist da`, da, JSON.stringify(karten));

    console.log('\n── Was die Karten ueber das Intervall sagen ──');
    // Der Zustand wird hier SELBST hergestellt. Beim ersten Versuch haben sich beide Pruefungen
    // uebersprungen, weil sie darauf hofften, dass zufaellig ein passendes Konto vorliegt — und
    // ein uebersprungener Test prueft nichts.
    //
    // Gebraucht wird: ein Nutzer mit eigenem Authenticator, eigenem Intervall „woechentlich" und
    // einem gemerkten Geraet. Das sind mehrere Codes hintereinander; der Wiederverwendungs-Riegel
    // nimmt nur steigende Zeitschritte, deshalb vor jedem ein frisches Fenster.
    // Zuerst die Pflicht herausnehmen: Weiter oben wurde die Mitarbeiter-Rolle scharf geschaltet,
    // und solange sie das ist, GEWINNT sie — der eigene Wunsch waere hier gar nicht einstellbar.
    // (Genau daran ist dieser Abschnitt beim ersten Versuch gescheitert.) Abschalten geht ohne Code.
    await req('PUT', '/api/settings', adminToken, { twofa_mitarbeiter: 'aus' });
    const uNutzer = 'kartenprobe';
    await req('POST', '/api/users', adminToken,
      { username: uNutzer, password: 'Test1234!', name: 'Karten Probe', role: 'mitarbeiter' });
    const uTok = (await req('POST', '/api/auth/login', null, { username: uNutzer, password: 'Test1234!' })).body.token;
    const uSetup = (await req('POST', '/api/auth/2fa/setup', uTok, {})).body;
    await frischesFenster();
    ok('Authenticator bestaetigt',
      (await req('POST', '/api/auth/2fa/verify', uTok, { code: totp.code(uSetup.geheim) })).status === 200);
    await frischesFenster();
    ok('eigenes Intervall auf „wöchentlich" gestellt',
      (await req('POST', '/api/auth/2fa/eigener-modus', uTok, { modus: 'woechentlich', code: totp.code(uSetup.geheim) })).status === 200);

    // Anmelden und dabei das Geraet merken lassen — im Browser, damit das Cookie dort landet.
    const kp = await seiteMachen();
    await kp.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await kp.evaluate(() => localStorage.clear());
    await kp.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await kp.waitForSelector('#login-user');
    await kp.type('#login-user', uNutzer); await kp.type('#login-pass', 'Test1234!');
    await kp.click('#login-form button[type="submit"]');
    await sleep(1800);
    ok('die Anmeldung verlangt einen Code', !!(await kp.$('#login-code')));
    await frischesFenster();
    await kp.type('#login-code', totp.code(uSetup.geheim));
    await kp.click('#code-form button[type="submit"]');
    await sleep(2600);
    ok('… und danach ist er drin', !(await kp.$('#login-code')) && !(await kp.$('#login-user')));

    await kp.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await kp.waitForSelector('#konto-2fa'); await sleep(2600);
    const zweiTxt = (await kp.$eval('#konto-2fa', el => el.innerText)).replace(/\s+/g, ' ');
    ok('die 2FA-Karte nennt „wöchentlich" — den geltenden Wert, nicht den Rollen-Modus „aus"',
      /Abfrage: wöchentlich/i.test(zweiTxt), zweiTxt.slice(0, 120));
    ok('… und schreibt es dem Nutzer zu', /von dir gewählt/i.test(zweiTxt), zweiTxt.slice(0, 140));

    const gTxt = (await kp.$eval('#konto-geraete', el => el.innerText)).replace(/\s+/g, ' ');
    // Ohne diese Zeile ist alles darunter wertlos: Eine leere Karte enthaelt auch kein
    // „ohne Code-Abfrage" und bestuende die Pruefung, ohne dass je ein Geraet gemerkt wurde.
    ok('die Geräte-Karte ist gefüllt (das Gerät wurde wirklich gemerkt)', gTxt.length > 20, `„${gTxt}"`);
    ok('sie verspricht KEIN „ohne Code-Abfrage" mehr', !/ohne Code-Abfrage/i.test(gTxt), gTxt.slice(0, 100));
    ok('… sondern heißt neutral „Gemerkte Geräte"', /Gemerkte Geräte/.test(gTxt), gTxt.slice(0, 100));
    ok('… und sagt, was dort wirklich gilt: höchstens einmal pro Woche',
      /höchstens einmal pro Woche/i.test(gTxt), gTxt.slice(0, 200));
    await kp.close();

    console.log('\n── Zwei Wege nach „Mein Konto" (Alex, 23.08.2026) ──');
    // Beides ist gewollt: der Menuepunkt UND die Kopfzeile. Wer oben auf seinen Namen tippt,
    // erwartet dort sein Konto — das ist die Gewohnheit aus jeder anderen App.
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(1800);
    ok('der Menuepunkt fuehrt hin', !!(await page.$('.sidebar a[href="#/konto"]')));
    const kopf = await page.$('.header .konto-link');
    ok('Bild und Name in der Kopfzeile sind ein Link', !!kopf);
    ok('… mit einer Beschriftung fuer Screenreader',
      /Mein Konto/i.test(await page.$eval('.header .konto-link', el => el.getAttribute('aria-label') || '')));
    const masse = await page.$eval('.header .konto-link', el => {
      const r = el.getBoundingClientRect(); return { b: Math.round(r.width), h: Math.round(r.height) };
    });
    ok('… und gross genug zum Antippen (mind. 44 px)', masse.b >= 44 && masse.h >= 44, JSON.stringify(masse));
    await page.click('.header .konto-link');
    await sleep(1800);
    ok('… ein Klick darauf fuehrt nach „Mein Konto"',
      (await page.evaluate(() => location.hash)) === '#/konto', await page.evaluate(() => location.hash));

    // Am Handy blendet die Oberflaeche den Namen aus — dann darf das Ziel nicht auf 28 px
    // zusammenschrumpfen. Genau deshalb steht die Mindestgroesse im Stylesheet.
    await page.setViewport({ width: 380, height: 800 }); await sleep(900);
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(1800);
    const klein = await page.$eval('.header .konto-link', el => {
      const r = el.getBoundingClientRect();
      const name = el.querySelector('.user-name');
      return { b: Math.round(r.width), h: Math.round(r.height),
               nameSichtbar: name ? getComputedStyle(name).display !== 'none' : false };
    });
    ok('am Handy ist der Name ausgeblendet', klein.nameSichtbar === false, JSON.stringify(klein));
    ok('… das Tippziel bleibt trotzdem mindestens 44 px', klein.b >= 44 && klein.h >= 44, JSON.stringify(klein));
    await page.click('.header .konto-link'); await sleep(1800);
    ok('… und der Weg funktioniert auch dort',
      (await page.evaluate(() => location.hash)) === '#/konto', await page.evaluate(() => location.hash));
    await page.setViewport({ width: 900, height: 950 });
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' }); await sleep(1800);

    ok('das eigene Geburtsdatum steht dort',
      /hinterlegt|kein Geburtsdatum/.test(await page.$eval('#konto-geburtstag', el => el.innerText)));
    ok('die Stammdaten zeigen die Soll-Stunden',
      /Soll-Stunden/.test(await page.$eval('#konto-stammdaten', el => el.innerText)));
    ok('„Auf allen Geräten abmelden" ist da', !!(await page.$('#alle-abmelden')));
    ok('„Meine Daten herunterladen" ist da', !!(await page.$('#daten-auskunft')));

    console.log('\n── Der Menüpunkt „Benachrichtigungen" ist verschwunden … ──');
    ok('… aus dem Menü', !(await page.$('a[href="#/notifications"]')));
    ok('… aber die alte Adresse führt nach „Mein Konto" (Lesezeichen bleiben heil)',
      await page.evaluate(async () => {
        location.hash = '#/notifications';
        await new Promise(r => setTimeout(r, 1200));
        return location.hash === '#/konto';
      }));
    await page.close();

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
