// Geburtstags-Einblendung auf der Willkommensseite.
//
// Zwei Dinge lassen sich nicht "einfach so" prüfen und bekommen deshalb eigene Vorkehrungen:
//
//  1. Wer die Anzeige sehen DARF. Der Endpunkt gibt Geburtstage nur an Chef/Admin/Buchhalter heraus —
//     für die Belegschaft wäre die Anzeige einwilligungspflichtig. Ein Test, der nur die Oberfläche
//     ansieht, würde ein Leck im Endpunkt nicht bemerken, deshalb wird beides geprüft.
//  2. Der 29. Februar. Den gibt es in drei von vier Jahren nicht. Dafür wird ein zweiter Server mit
//     VORGESTELLTER UHR gestartet (2027 = kein Schaltjahr, 2028 = Schaltjahr als Gegenprobe) —
//     sonst wäre dieser Zweig nur alle vier Jahre prüfbar.
//
//   node tests/geburtstag-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3207, DB = '/tmp/geburtstag-ui.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, port = PORT) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Server mit verschobener Uhr: Der Versatz bleibt ein Versatz (kein eingefrorener Zeitpunkt),
// damit Zeitgeber und Token-Laufzeiten weiter funktionieren.
function zeitreisePreload(zielIso) {
  return `const E = Date; const ziel = new E('${zielIso}').getTime(); const v = ziel - E.now();
function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC;
globalThis.Date = G;`;
}

function starteServer(port, db, logDatei, preload) {
  const lg = fs.openSync(logDatei, 'w');
  const argv = preload ? ['-r', preload, 'server.js'] : ['server.js'];
  return { proc: spawn('node', argv, { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_PATH: db, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] }), logDatei };
}
async function warten(port, logDatei) {
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health', null, null, port)).status === 200) break; } catch (_) {} await sleep(200); }
  let log = '';
  for (let i = 0; i < 150; i++) { log = fs.readFileSync(logDatei, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
  return n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
}

const MA = { role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const s1 = starteServer(PORT, DB, '/tmp/geburtstag-srv.log');
  let browser;
  try {
    const pw = await warten(PORT, '/tmp/geburtstag-srv.log');
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const admin = await an('admin'), chef = await an('chef'), max = await an('max');

    // Heutiger Tag/Monat, aber andere Jahre — so hat der Test an JEDEM Kalendertag dieselbe Aussage.
    const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    const [jahr, mm, tt] = heute.split('-');
    const amGeburtstag = j => `${j}-${mm}-${tt}`;
    const jahrZahl = Number(jahr);

    const anlegen = async (username, name, gb, extra) => {
      const r = await req('POST', '/api/users', admin.token,
        { username, password: 'Start!2345', name, ...MA, ...(gb ? { birth_date: gb } : {}), ...(extra || {}) });
      if (r.status >= 300) throw new Error('Anlegen ' + username + ': ' + r.text);
      return r.body.user;
    };

    const kind = await anlegen('kind', 'Tina Torte', amGeburtstag(jahrZahl - 36));
    await anlegen('anderer', 'Otto Anders', amGeburtstag(jahrZahl - 30).replace(`-${mm}-`, mm === '01' ? '-02-' : '-01-'));
    await anlegen('ohnedatum', 'Sven Ohne', null);
    const raus = await anlegen('ausgestellt', 'Rita Raus', amGeburtstag(jahrZahl - 41));
    await req('POST', `/api/users/${raus.id}/deactivate`, admin.token, { end_date: heute });
    // Der Chef selbst hat auch heute Geburtstag — er darf sich NICHT selbst gratulieren.
    await req('PUT', `/api/users/${chef.user.id}`, admin.token, { birth_date: amGeburtstag(jahrZahl - 50) });
    const buch = await req('POST', '/api/users', admin.token,
      { username: 'buchi', password: 'Start!2345', name: 'Bea Buch', role: 'buchhalter', target_hours_per_week: 40 });
    if (buch.status >= 300) throw new Error('Buchhalter: ' + buch.text);

    console.log('\n── Endpunkt ────────────────────────────────────────────');
    const alsChef = await req('GET', '/api/users/geburtstage', chef.token);
    const namen = (alsChef.body?.geburtstage || []).map(g => g.name);
    ok('Chef sieht das Geburtstagskind', namen.includes('Tina Torte'), JSON.stringify(namen));
    ok('… mit dem richtigen Alter (36)',
      (alsChef.body?.geburtstage || []).some(g => g.name === 'Tina Torte' && g.alter === 36),
      JSON.stringify(alsChef.body?.geburtstage));
    ok('Der Chef gratuliert sich nicht selbst', !namen.includes(chef.user.name), JSON.stringify(namen));
    ok('Anderes Datum taucht nicht auf', !namen.includes('Otto Anders'), JSON.stringify(namen));
    ok('Ohne Geburtsdatum taucht nicht auf', !namen.includes('Sven Ohne'), JSON.stringify(namen));
    ok('Ausgestellte tauchen nicht auf', !namen.includes('Rita Raus'), JSON.stringify(namen));
    ok('Kein Geburtsdatum im Antwortkörper', !alsChef.text.includes(amGeburtstag(jahrZahl - 36)), alsChef.text);

    // Der Buchhalter wurde über die API angelegt, sein Passwort steht also NICHT im Seed-Protokoll.
    const buchAn = (await req('POST', '/api/auth/login', null, { username: 'buchi', password: 'Start!2345' })).body;
    const alsBuch = await req('GET', '/api/users/geburtstage', buchAn.token);
    ok('Buchhalter darf es sehen', alsBuch.status === 200 &&
      (alsBuch.body.geburtstage || []).some(g => g.name === 'Tina Torte'), alsBuch.status + ' ' + alsBuch.text);

    // GEAENDERT am 22.08.2026: Der Endpunkt ist nicht mehr gesperrt, sondern GEFILTERT. Ein
    // Mitarbeiter darf ihn abfragen, bekommt aber nur Kollegen zu sehen, die sich SELBST
    // freigegeben haben (tests/geburtstag-freigabe.js). Ohne Freigabe ist die Liste leer — das
    // Ergebnis ist fuer ihn also dasselbe wie vorher, nur ohne Fehlermeldung.
    const alsMa = await req('GET', '/api/users/geburtstage', max.token);
    ok('Mitarbeiter darf fragen, sieht aber nichts Fremdes',
      alsMa.status === 200 && (alsMa.body.geburtstage || []).length === 0, alsMa.status + ' ' + alsMa.text);
    ok('… insbesondere nicht Tina Torte, die nichts freigegeben hat',
      !(alsMa.body.geburtstage || []).some(g => g.name === 'Tina Torte'), alsMa.text.slice(0, 90));

    console.log('\n── Willkommensseite ────────────────────────────────────');
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);

    const anmelden = async (n, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', n); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
      await page.goto(BASIS + '/#/welcome', { waitUntil: 'networkidle0' });
      await page.waitForSelector('.welcome-page'); await sleep(900);
    };

    await anmelden('chef', pw('chef'));
    const text = await page.evaluate(() => document.querySelector('.welcome-page').innerText);
    ok('Chef sieht „Geburtstag heute"', /Geburtstag heute/.test(text), text.slice(0, 200));
    ok('… mit Name und Alter im Satz', /Tina Torte wird heute 36/.test(text), text.slice(0, 300));
    ok('… der eigene Geburtstag fehlt', !text.includes(chef.user.name + ' wird heute'), text.slice(0, 300));

    // Position: Der Geburtstag steht VOR der Wochenübersicht.
    const vorher = await page.evaluate(() => {
      const abschnitte = [...document.querySelectorAll('.welcome-section')];
      const g = abschnitte.findIndex(a => /Geburtstag heute/.test(a.innerText));
      const w = abschnitte.findIndex(a => a.id === 'welcome-week-container');
      return { g, w };
    });
    ok('… und steht vor der Wochenübersicht', vorher.g >= 0 && vorher.w >= 0 && vorher.g < vorher.w, JSON.stringify(vorher));

    await anmelden('max', pw('max'));
    const maText = await page.evaluate(() => document.querySelector('.welcome-page').innerText);
    ok('Mitarbeiter sieht nichts davon', !/Geburtstag heute/.test(maText), maText.slice(0, 200));

    await browser.close(); browser = null;
    s1.proc.kill('SIGTERM'); await sleep(800);

    // ── 29. Februar ────────────────────────────────────────────────────────────────────────
    // Ohne Zeitreise wäre dieser Zweig nur am 28./29. Februar prüfbar — also praktisch nie.
    console.log('\n── 29. Februar (Server mit vorgestellter Uhr) ──────────');
    const preload = '/tmp/geburtstag-zeitreise.js';
    for (const fall of [
      { iso: '2027-02-28T10:00:00', jahr: 2027, schalt: false, erwartet: true,  titel: '2027 (kein Schaltjahr): am 28. wird gefeiert' },
      { iso: '2028-02-28T10:00:00', jahr: 2028, schalt: true,  erwartet: false, titel: '2028 (Schaltjahr): am 28. NICHT — erst am 29.' },
      { iso: '2028-02-29T10:00:00', jahr: 2028, schalt: true,  erwartet: true,  titel: '2028: am 29. selbst schon' },
    ]) {
      const db2 = '/tmp/geburtstag-schalt.db';
      try { fs.unlinkSync(db2); } catch (_) {}
      fs.writeFileSync(preload, zeitreisePreload(fall.iso));
      const s2 = starteServer(PORT, db2, '/tmp/geburtstag-schalt.log', preload);
      try {
        const pw2 = await warten(PORT, '/tmp/geburtstag-schalt.log');
        const admin2 = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw2('admin') })).body;
        const chef2 = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw2('chef') })).body;
        const r = await req('POST', '/api/users', admin2.token,
          { username: 'schalt', password: 'Start!2345', name: 'Felix Schalt', birth_date: '2008-02-29', ...MA });
        if (r.status >= 300) throw new Error('Schaltjahrkind: ' + r.text);
        const liste = (await req('GET', '/api/users/geburtstage', chef2.token)).body?.geburtstage || [];
        const treffer = liste.find(g => g.name === 'Felix Schalt');
        ok(fall.titel, !!treffer === fall.erwartet, JSON.stringify(liste));
        if (fall.erwartet && treffer) {
          const vermerkNoetig = !fall.schalt;
          ok(`   Vermerk „29. Februar" ${vermerkNoetig ? 'gesetzt' : 'NICHT gesetzt'}`,
            !!treffer.am_29_februar === vermerkNoetig, JSON.stringify(treffer));
          ok(`   Alter ${fall.jahr - 2008}`, treffer.alter === fall.jahr - 2008, JSON.stringify(treffer));
        }
      } finally { s2.proc.kill('SIGTERM'); await sleep(700); try { fs.unlinkSync(db2); } catch (_) {} }
    }
    try { fs.unlinkSync(preload); } catch (_) {}

  } finally {
    if (browser) await browser.close();
    try { s1.proc.kill('SIGTERM'); } catch (_) {}
    await sleep(600);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nGeburtstags-Einblendung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
