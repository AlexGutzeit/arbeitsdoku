// Die Benachrichtigungen sind von ihrer eigenen Seite nach „Mein Konto" umgezogen (Alex,
// 22.08.2026: „Die Benachrichtigungen sollen bei jedem user natürlich weiterhin so eingestellt
// sein, wie sie aktuell sind, nur eben in 'mein Konto' verschoben.").
//
// Der Umzug betrifft nur die Oberfläche — gespeichert wird nach wie vor über /api/push. Genau
// deshalb ist der gefährliche Fall nicht „die Einstellungen sind weg", sondern „die neue Seite
// schreibt beim Aufbauen ihre Vorgabewerte zurück". Das würde niemandem auffallen, bis eines
// Morgens die halbe Belegschaft wieder alle Meldungen bekommt.
//
// Geprüft wird deshalb: Einstellungen setzen → Konto-Seite besuchen → Einstellungen sind Zeichen
// für Zeichen dieselben. Dazu die alte Adresse (Lesezeichen) und die Erreichbarkeit auch dann,
// wenn der Nutzer gerade zur Zwei-Faktor-Einrichtung festgehalten wird — sonst stünde er vor
// einer halb kaputten Seite.
//
//   node tests/benachrichtigungen-umzug.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3267, DB = '/tmp/benachrichtigungen-umzug.db', BASIS = `http://localhost:${PORT}`;
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
  const lg = fs.openSync('/tmp/benachrichtigungen-umzug-srv.log', 'w');
  // Mit VAPID-Schluesseln starten: Ohne sie meldet die Karte „auf diesem Server nicht
  // eingerichtet" und zeigt ihre Schalter gar nicht erst — der interessante Teil bliebe ungeprueft.
  const vapid = require('web-push').generateVAPIDKeys();
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      VAPID_PUBLIC: vapid.publicKey, VAPID_PRIVATE: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.org' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/benachrichtigungen-umzug-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('POST', '/api/users', admin, { username: 'nina', password: 'Test1234!', name: 'Nina Wolter', role: 'mitarbeiter' });
    const nina = (await req('POST', '/api/auth/login', null, { username: 'nina', password: 'Test1234!' })).body.token;

    console.log('── Nina stellt ihre Benachrichtigungen ein (wie bisher) ──');
    // Bewusst NICHT alles an und nicht alles aus — sonst waere ein Zuruecksetzen auf die Vorgabe
    // (alles an) von einem erhaltenen Zustand nicht zu unterscheiden.
    const gewuenscht = { orders: false, bulletin: true, notes: false, absences: true, planning: true };
    const gesetzt = await req('PUT', '/api/push/prefs', nina, gewuenscht);
    ok('Kategorien gespeichert', gesetzt.status === 200, `${gesetzt.status} ${gesetzt.text.slice(0, 80)}`);
    ok('… und so zurueckgemeldet, wie gewuenscht',
      JSON.stringify(gesetzt.body) === JSON.stringify(gewuenscht), JSON.stringify(gesetzt.body));

    const plan = await req('POST', '/api/push/summaries', nina,
      // 'planning' ist ein Schalter fuer Sofort-Meldungen, aber KEINE Digest-Kategorie
      // (routes/push.js: CATEGORIES kennt orders/bulletin/notes/absences).
      { name: 'Wochenstart', weekdays: [1], time: '07:30', cats: ['bulletin', 'absences'] });
    ok('Zusammenfassung angelegt', plan.status === 201, `${plan.status} ${plan.text.slice(0, 90)}`);
    await req('PUT', '/api/push/summaries/pause-all', nina, { paused: false });

    const vorher = {
      prefs: (await req('GET', '/api/push/prefs', nina)).body,
      summaries: (await req('GET', '/api/push/summaries', nina)).body,
    };
    // Ohne diese Zeile waere der Vergleich weiter unten wertlos: Zwei leere Listen sind auch
    // dann gleich, wenn die Seite alles geloescht haette.
    ok('Ausgangsstand steht fest — und ist nicht die Vorgabe',
      vorher.prefs.orders === false && vorher.prefs.notes === false && vorher.summaries.schedules.length === 1,
      JSON.stringify(vorher));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 460, height: 950 });
    page.setDefaultTimeout(30000);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'nina'); await page.type('#login-pass', 'Test1234!');
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);

    console.log('\n── Die Karte steht jetzt auf „Mein Konto" ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#push-card'); await sleep(2500);
    ok('die Karte „Benachrichtigungen" ist da',
      /Benachrichtigungen/.test(await page.$eval('#push-card', el => el.innerText)),
      (await page.$eval('#push-card', el => el.innerText)).slice(0, 80));
    ok('der alte Menuepunkt ist weg', !(await page.$('a[href="#/notifications"]')));
    ok('… die alte Adresse fuehrt aber nach „Mein Konto" (Lesezeichen bleiben heil)',
      await page.evaluate(async () => { location.hash = '#/notifications'; await new Promise(r => setTimeout(r, 1400)); return location.hash === '#/konto'; }));

    console.log('\n── Und das Wichtigste: der Besuch aendert nichts ──');
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' }); await sleep(2500);
    await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
    const nachher = {
      prefs: (await req('GET', '/api/push/prefs', nina)).body,
      summaries: (await req('GET', '/api/push/summaries', nina)).body,
    };
    ok('die Kategorien sind Zeichen fuer Zeichen dieselben',
      JSON.stringify(nachher.prefs) === JSON.stringify(vorher.prefs),
      `${JSON.stringify(vorher.prefs)} → ${JSON.stringify(nachher.prefs)}`);
    ok('die geplante Zusammenfassung ebenso',
      JSON.stringify(nachher.summaries) === JSON.stringify(vorher.summaries),
      `${JSON.stringify(vorher.summaries)} → ${JSON.stringify(nachher.summaries)}`);

    console.log('\n── Die Karte mit ihren Schaltern — endlich einmal wirklich gesehen ──');
    // Die Kategorie-Schalter erscheinen NUR bei aktivem Push-Abo. Ein Testbrowser hat keines,
    // deshalb war dieser Teil der Karte bisher in keinem Test zu sehen — obwohl genau er in
    // dieser Runde umgezogen ist. Erlaubnis erteilen und das Abo vortaeuschen, dann zeigt sie
    // sich; der Rest ist echte App.
    await browser.defaultBrowserContext().overridePermissions(BASIS, ['notifications']);
    await page.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#push-card'); await sleep(2000);
    await page.evaluate(async () => {
      // Zwei Dinge werden gestellt, mehr nicht: die Browser-Erlaubnis (headless gibt sie nicht
      // her, auch nicht ueber overridePermissions) und das Vorhandensein eines Abos. Alles
      // Weitere — Laden der Einstellungen, Aufbau der Karte, Speichern — ist echte App.
      Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
      window.getPushSubscription = async () => ({ endpoint: 'https://push.invalid/abo-fuer-den-test' });
      await initPushCard();
    });
    await sleep(1200);
    const schalter = await page.$$eval('#push-card input[data-cat]',
      els => els.map(e => ({ cat: e.dataset.cat, an: e.checked })));
    ok('die Kategorie-Schalter sind da', schalter.length >= 4, JSON.stringify(schalter));
    // Und zwar mit NINAS Werten, nicht mit den Vorgabewerten — sonst zeigte die Karte etwas
    // anderes an, als gespeichert ist, und der erste Klick wuerde es festschreiben.
    const erwartet = { orders: false, bulletin: true, notes: false, absences: true, planning: true };
    const abweichung = schalter.filter(s => s.an !== erwartet[s.cat]);
    ok('… und zeigen den GESPEICHERTEN Stand, nicht die Vorgabe',
      schalter.length >= 4 && abweichung.length === 0,
      JSON.stringify({ gezeigt: schalter, erwartet }));
    ok('„Test-Benachrichtigung" und „Ausschalten" sind da',
      !!(await page.$('#push-test')) && !!(await page.$('#push-disable')));

    console.log('\n── Ein Klick auf einen Schalter speichert wirklich ──');
    await page.evaluate(() => {
      const cb = document.querySelector('#push-card input[data-cat="notes"]');
      cb.click();
    });
    await sleep(1600);
    const nachKlick = (await req('GET', '/api/push/prefs', nina)).body;
    ok('„Notizen" steht jetzt auf an', nachKlick.notes === true, JSON.stringify(nachKlick));
    ok('… und sonst hat sich nichts bewegt',
      nachKlick.orders === false && nachKlick.bulletin === true && nachKlick.absences === true && nachKlick.planning === true,
      JSON.stringify(nachKlick));
    // Zuruecksetzen, damit der naechste Abschnitt wieder vom Ausgangsstand ausgeht.
    await req('PUT', '/api/push/prefs', nina, { notes: false });

    console.log('\n── Auch waehrend des Zwei-Faktor-Zwangs erreichbar ──');
    // Wer zur Einrichtung festgehalten wird, sieht dieselbe Seite. Waere /api/push gesperrt,
    // stuende er vor einer Karte, die ewig laedt.
    await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'immer' });
    ok('Daten-Routen sind jetzt gesperrt', (await req('GET', '/api/users', nina)).status === 403);
    ok('… die Benachrichtigungen bleiben aber lesbar',
      (await req('GET', '/api/push/prefs', nina)).status === 200);
    ok('… und die Einstellungen sind immer noch unveraendert',
      JSON.stringify((await req('GET', '/api/push/prefs', nina)).body) === JSON.stringify(vorher.prefs));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nBenachrichtigungen nach dem Umzug: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
