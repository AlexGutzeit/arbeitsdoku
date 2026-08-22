// Gratulation für das Geburtstagskind selbst (Alex, 08.08.2026).
//
// Bis dahin sahen nur Chef/Admin/Buchhalter, WER Geburtstag hat — die betroffene Person selbst
// bekam nichts. Jetzt gibt es eine dezente Karte auf der eigenen Willkommensseite, ohne Alter und
// ohne Absender („das ganze Team wünscht dir" wäre unwahr, das Team sieht den Geburtstag ja nicht).
//
// Geprüft wird vor allem, was NICHT passieren darf:
//   * ein Mitarbeiter sieht seine Gratulation, aber weiterhin KEINE fremden Geburtstage
//   * wer heute keinen Geburtstag hat, sieht nichts
//   * die Karte nennt KEIN Alter und kein Geburtsdatum
//   * der Chef sieht seine eigene Gratulation UND steht weiterhin nicht in der Liste der anderen
//   * am 29. Februar Geborene werden in Nicht-Schaltjahren am 28. gefeiert (Uhr gestellt)
//   * der geschützte Endpunkt bleibt geschützt (Mitarbeiter bekommt 403)
//
//   node tests/geburtstag-eigener-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3243, DB = '/tmp/geburtstag-eigener.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const heute = new Date();
const iso = d => d.toLocaleDateString('sv-SE');
const heuteMD = iso(heute).slice(5);                       // MM-TT von heute
const morgen = new Date(heute); morgen.setDate(heute.getDate() + 1);
const morgenMD = iso(morgen).slice(5);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/geburtstag-eigener-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/geburtstag-eigener-srv.log', 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;

    // Drei Mitarbeiter: heute Geburtstag / morgen / am 29. Februar geboren.
    const anlegen = async (username, name, gebMD, gebJahr) => {
      const r = await req('POST', '/api/users', admin.token, { username, password: 'Test1234!', name, role: 'mitarbeiter', birth_date: `${gebJahr}-${gebMD}` });
      if (r.status >= 300) throw new Error(username + ': ' + r.text);
      return r.body.user;
    };
    await anlegen('gebheute', 'Geburtstagskind Heute', heuteMD, 1990);
    await anlegen('gebmorgen', 'Erika Unauffaellig', morgenMD, 1988);   // Name OHNE das Wort „Geburtstag" — sonst prueft die Zeile unten den eigenen Namen
    await anlegen('gebschalt', 'Schalttagskind', '02-29', 1992);
    // Der Chef hat heute ebenfalls Geburtstag — fuer die Gegenprobe „steht nicht in der eigenen Liste".
    const chefId = ((await req('GET', '/api/users', admin.token)).body.users || []).find(u => u.username === 'chef').id;
    await req('PUT', `/api/users/${chefId}`, admin.token, { birth_date: `1975-${heuteMD}` });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const anmelden = async (page, user, passwort) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', user); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]');
      await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.welcome-page'); await sleep(1600);
    };
    const seite = async (page) => page.evaluate(() => {
      const eigen = document.getElementById('welcome-eigener-geburtstag');
      const alleTexte = document.querySelector('.welcome-page').innerText;
      return { eigenDa: !!eigen, eigenText: eigen ? eigen.innerText : '', seite: alleTexte };
    });

    console.log('── Mitarbeiter mit Geburtstag heute ──');
    let page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    page.setDefaultTimeout(45000);
    await anmelden(page, 'gebheute', 'Test1234!');
    let z = await seite(page);
    ok('sieht seine Gratulation', z.eigenDa && /Alles Gute zum Geburtstag/.test(z.eigenText), JSON.stringify(z.eigenText));
    ok('… ohne Alter', !/\b3[0-9]\b|\bwird heute\b/.test(z.eigenText), JSON.stringify(z.eigenText));
    ok('… und ohne Geburtsdatum', !/\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/.test(z.eigenText), JSON.stringify(z.eigenText));
    ok('… sieht aber KEINE fremden Geburtstage', !/Geburtstag heute/.test(z.seite), 'Abschnitt „Geburtstag heute" darf für Mitarbeiter nicht da sein');
    // GEAENDERT am 22.08.2026: Der Endpunkt ist nicht mehr gesperrt, sondern gefiltert — ein
    // Mitarbeiter sieht nur Kollegen, die sich selbst freigegeben haben. Ohne Freigabe ist die
    // Liste leer, das Ergebnis fuer ihn also unveraendert.
    const offen = await req('GET', '/api/users/geburtstage',
      (await req('POST', '/api/auth/login', null, { username: 'gebheute', password: 'Test1234!' })).body.token);
    ok('… und über den Endpunkt sieht er keine fremden Geburtstage',
      offen.status === 200 && (offen.body.geburtstage || []).length === 0, `${offen.status} ${offen.text.slice(0, 80)}`);
    await page.close();

    console.log('\n── Mitarbeiter ohne Geburtstag heute ──');
    page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    await anmelden(page, 'gebmorgen', 'Test1234!');
    z = await seite(page);
    ok('sieht keine Gratulation', !z.eigenDa, JSON.stringify(z.eigenText));
    const stelle = (z.seite.match(/.{0,60}Geburtstag.{0,60}/) || ['—'])[0];
    ok('… und auch sonst nichts von Geburtstagen', !/Geburtstag/.test(z.seite), 'gefunden: ' + JSON.stringify(stelle));
    await page.close();

    console.log('\n── Chef hat selbst Geburtstag ──');
    page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    await anmelden(page, 'chef', pw('chef'));
    z = await seite(page);
    ok('sieht seine eigene Gratulation', z.eigenDa && /Alles Gute zum Geburtstag/.test(z.eigenText), JSON.stringify(z.eigenText));
    ok('… sieht das Geburtstagskind aus dem Team', /Geburtstagskind Heute wird heute/.test(z.seite));
    ok('… steht aber selbst NICHT in dieser Liste', !/Chef wird heute/.test(z.seite), 'der eigene Name darf in „Geburtstag heute" nicht auftauchen');
    await page.close();

    console.log('\n── 29. Februar in einem Nicht-Schaltjahr (Uhr auf den 28.02.2027 gestellt) ──');
    page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    // Nur die BROWSER-Uhr stellen: Die Karte wird ausschliesslich im Browser berechnet, es wird
    // dafuer nichts vom Server geholt. Verschoben wird um einen Abstand, nicht auf einen festen
    // Zeitpunkt — eine eingefrorene Uhr laesst die Sekundenanzeige der Seite stehen.
    const ziel = new Date(2027, 1, 28, 10, 30, 0).getTime();
    await page.evaluateOnNewDocument((zielZeit) => {
      const EchtDate = Date; const versatz = zielZeit - EchtDate.now();
      function FakeDate(...a) { return a.length ? new EchtDate(...a) : new EchtDate(EchtDate.now() + versatz); }
      FakeDate.prototype = EchtDate.prototype;
      FakeDate.now = () => EchtDate.now() + versatz;
      FakeDate.parse = EchtDate.parse; FakeDate.UTC = EchtDate.UTC;
      window.Date = FakeDate;
    }, ziel);
    await anmelden(page, 'gebschalt', 'Test1234!');
    z = await seite(page);
    ok('das Schalttagskind wird am 28. gefeiert', z.eigenDa && /Alles Gute zum Geburtstag/.test(z.eigenText), JSON.stringify(z.eigenText));
    ok('… mit Erklärung, warum heute', /29\. Februar/.test(z.eigenText), JSON.stringify(z.eigenText));
    await page.screenshot({ path: '/tmp/claude-1000/-home-alex-zeug-arbeitsdoku/84cc3a6c-bbc9-43b1-ae98-766adee26b4e/scratchpad/gratulation.png' });
    await page.close();

    console.log('\n── Gegenprobe: dieselbe Person an einem anderen Tag ──');
    page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    const ziel2 = new Date(2027, 2, 3, 10, 30, 0).getTime();   // 03.03.2027
    await page.evaluateOnNewDocument((zielZeit) => {
      const EchtDate = Date; const versatz = zielZeit - EchtDate.now();
      function FakeDate(...a) { return a.length ? new EchtDate(...a) : new EchtDate(EchtDate.now() + versatz); }
      FakeDate.prototype = EchtDate.prototype;
      FakeDate.now = () => EchtDate.now() + versatz;
      FakeDate.parse = EchtDate.parse; FakeDate.UTC = EchtDate.UTC;
      window.Date = FakeDate;
    }, ziel2);
    await anmelden(page, 'gebschalt', 'Test1234!');
    z = await seite(page);
    ok('am 3. März bekommt dasselbe Konto KEINE Gratulation', !z.eigenDa, JSON.stringify(z.eigenText));
    await page.close();

    console.log('\n── Gegenprobe: 29.02. im Schaltjahr selbst ──');
    page = await browser.newPage(); await page.setViewport({ width: 420, height: 900 });
    const ziel3 = new Date(2028, 1, 29, 10, 30, 0).getTime();  // 29.02.2028 gibt es wirklich
    await page.evaluateOnNewDocument((zielZeit) => {
      const EchtDate = Date; const versatz = zielZeit - EchtDate.now();
      function FakeDate(...a) { return a.length ? new EchtDate(...a) : new EchtDate(EchtDate.now() + versatz); }
      FakeDate.prototype = EchtDate.prototype;
      FakeDate.now = () => EchtDate.now() + versatz;
      FakeDate.parse = EchtDate.parse; FakeDate.UTC = EchtDate.UTC;
      window.Date = FakeDate;
    }, ziel3);
    await anmelden(page, 'gebschalt', 'Test1234!');
    z = await seite(page);
    ok('am echten 29. Februar wird gratuliert', z.eigenDa, JSON.stringify(z.eigenText));
    ok('… und dann OHNE den Ersatz-Hinweis', !/29\. Februar/.test(z.eigenText), JSON.stringify(z.eigenText));
    await page.close();

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nEigene Gratulation: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
