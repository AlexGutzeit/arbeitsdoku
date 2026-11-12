// Ablage (Dokumente): In jedem Ordner steht, dass alle Mitarbeiter sie sehen — und wer ablegen darf, liest, was nicht hineingehört.
//
// Warum (Sicherheitsprüfung 10.11.2026, P11): Die Ablage kennt keine Rechte je Ordner. Jeder Angemeldete sieht jeden
// Ordner und lädt jede Datei herunter. Das ist so gewollt, stand aber nur im README — wer einen Ordner „Personal"
// anlegt und Lohnzettel hineinlegt, erfährt es in der Oberfläche nicht. Der Hinweis steht deshalb dort, wo abgelegt wird.
//
// Geprüft wird im Browser, je Rolle: Mitarbeiter ohne Recht (nur der erste Satz), Mitarbeiter mit „Dateien hochladen",
// Chef und Admin (beide Sätze) — im Hauptordner und in einem Unterordner. Dazu: Dass wirklich alle alles sehen,
// misst der Test an der Schnittstelle mit; stimmte das nicht mehr, wäre der Hinweis falsch.
//   node tests/ablage-hinweis-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const CHROME = require('./hilfen/chrome');
const PORT = 3408, DB = '/tmp/ablage-hinweis-ui.db', LOG = '/tmp/ablage-hinweis-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, token, b) {
  return new Promise((res) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', () => res({ status: 0 })); if (d) r.write(d); r.end(); });
}

const ALLE = 'Diese Ablage sehen alle Mitarbeiter.';
const NICHT = 'Bitte keine Lohnunterlagen, Verträge oder Krankmeldungen ablegen.';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: adminPw })).body?.token;
    ok('Server startet, Admin-Anmeldung', !!admin);

    const PW = 'Test1234!';
    const konto = (username, role, extra) => req('POST', '/api/users', admin, { username, password: PW, name: 'Ablage ' + username, role,
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, ...extra });
    const angelegt = [await konto('ablageleser', 'mitarbeiter'), await konto('ablagelader', 'mitarbeiter', { can_upload: true }), await konto('ablagechef', 'chef')];
    ok('drei Konten angelegt (Leser, Hochlader, Chef)', angelegt.every(r => r.status === 200 || r.status === 201), angelegt.map(r => r.status).join(','));
    const ordner = (await req('POST', '/api/documents/folders', admin, { name: 'Personal', parent_id: null })).body || {};
    const ordnerId = ordner.id || ordner.folder?.id;
    ok('Ordner „Personal" angelegt', !!ordnerId, JSON.stringify(ordner));

    console.log('── Die Aussage stimmt: Der Mitarbeiter ohne jedes Recht sieht den Ordner ──');
    const leser = (await req('POST', '/api/auth/login', null, { username: 'ablageleser', password: PW })).body?.token;
    const liste = (await req('GET', '/api/documents', leser)).body || {};
    ok('GET /api/documents als Mitarbeiter → Ordner „Personal" ist dabei', (liste.folders || []).some(f => f.name === 'Personal'), JSON.stringify(liste.folders));
    ok('… und er kommt hinein', (await req('GET', '/api/documents?folder_id=' + ordnerId, leser)).status === 200);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const fehler = [];
    const ansehen = async (username, passwort) => {
      const kontext = await browser.createBrowserContext();
      const page = await kontext.newPage(); await page.setViewport({ width: 1100, height: 900 });
      page.setDefaultTimeout(30000);
      page.on('pageerror', e => fehler.push(username + ': ' + String(e && e.message || e)));
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', username); await page.type('#login-pass', passwort);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/documents"]');
      const lesen = async (hash) => {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await page.waitForFunction((h) => location.hash === h && !!document.querySelector('.doc-breadcrumb'), {}, hash);
        // Im Unterordner erst weiterlesen, wenn der Brotkrumen den Ordner nennt — sonst stünde noch die alte Seite da.
        if (/\d+$/.test(hash)) await page.waitForFunction(() => /Personal/.test(document.querySelector('.doc-crumb-current')?.textContent || ''));
        return page.evaluate(() => { const el = document.getElementById('doc-hinweis');
          const karte = document.querySelector('.main .card');
          return { text: el ? el.textContent.trim() : null, sichtbar: !!el && el.checkVisibility() && el.getBoundingClientRect().height > 0,
            vorListe: !!el && !!(el.compareDocumentPosition(document.querySelector('.doc-list')) & Node.DOCUMENT_POSITION_FOLLOWING),
            darfAblegen: !!document.getElementById('doc-upload-btn'),
            breit: !!el && el.scrollWidth <= el.clientWidth + 1 && karte.scrollWidth <= karte.clientWidth + 1 }; });
      };
      const haupt = await lesen('#/documents'), unter = await lesen('#/documents/' + ordnerId);
      // Schmal wie ein Handy: Der Hinweis bricht um, statt die Seite breiter zu machen.
      await page.setViewport({ width: 360, height: 800 });
      const schmal = await lesen('#/documents');
      await kontext.close();
      return { haupt, unter, schmal };
    };

    for (const [username, passwort, rolle, ablegen] of [
      ['ablageleser', PW, 'Mitarbeiter ohne Recht', false], ['ablagelader', PW, 'Mitarbeiter mit „Dateien hochladen"', true],
      ['ablagechef', PW, 'Chef', true], ['admin', adminPw, 'Admin', true]]) {
      console.log(`── ${rolle} ──`);
      const s = await ansehen(username, passwort);
      const soll = ablegen ? `${ALLE} ${NICHT}` : ALLE;
      ok(`Vorbedingung: ${ablegen ? 'hat' : 'hat keinen'} Knopf „Datei hochladen"`, s.haupt.darfAblegen === ablegen, String(s.haupt.darfAblegen));
      ok(`Hauptordner: „${soll}"`, s.haupt.text === soll && s.haupt.sichtbar, JSON.stringify(s.haupt));
      ok('… steht über der Liste', s.haupt.vorListe);
      ok(`Unterordner „Personal": derselbe Hinweis`, s.unter.text === soll && s.unter.sichtbar, JSON.stringify(s.unter));
      if (!ablegen) ok('… ohne den Satz zum Ablegen (er kann nichts ablegen)', !/Lohnunterlagen/.test(s.haupt.text || '') && !/Lohnunterlagen/.test(s.unter.text || ''));
      ok('360 px breit: sichtbar, nichts läuft über', s.schmal.text === soll && s.schmal.sichtbar && s.schmal.breit, JSON.stringify(s.schmal));
    }
    ok('keine Skriptfehler im Browser', fehler.length === 0, fehler.join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAblage-Hinweis: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
