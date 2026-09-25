// Meldungen auf Deutsch und ohne Innereien — Server und Oberfläche (R9, 25.09.2026).
//
// Vorher kamen an: „ENOSPC: no space left on device, open '/home/…'" (englisch UND mit Serverpfad),
// „Unexpected field", „Feld 'personal_note' ist zu lang", „Interner Serverfehler" für eine bloß zu
// große Anfrage, „User nicht gefunden", Browserfehler wie „Registration failed – push service error"
// und nach Programmfehlern „Cannot read properties of null (reading 'folders')".
// Jeder Fall wird hier ECHT ausgelöst — die Schreibrechte-Probe mit einem schreibgeschützten Ordner.
//
//   node tests/meldungen-deutsch.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3331, DB = '/tmp/meldungen-deutsch.db', LOG = '/tmp/meldungen-deutsch.log';
const BASIS = 'http://localhost:' + PORT;
const APP = path.join(__dirname, '..');
const DOKUMENTE = path.join(APP, 'storage', 'documents');
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
// Innereien, die in keiner Meldung stehen dürfen
const INNEREIEN = /(ENOSPC|EACCES|EPERM|ENOENT|\/home\/|\/tmp\/|Unexpected field|MulterError|personal_note|Cannot read|undefined)/;

function roh(m, p, t, body, kopf = {}) {
  return new Promise((res, rej) => {
    const d = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: {
      'Content-Type': 'application/json', ...kopf, ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': d.length } : {}) } },
    x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
function hochladen(p, t, feld, name, inhalt) {
  const g = '----meld' + Date.now();
  const body = Buffer.concat([Buffer.from(`--${g}\r\nContent-Disposition: form-data; name="${feld}"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.from(inhalt), Buffer.from(`\r\n--${g}--\r\n`)]);
  return roh('POST', p, t, body, { 'Content-Type': 'multipart/form-data; boundary=' + g });
}
const fehler = r => (r.body && r.body.error) || r.text;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  const zurueck = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await roh('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const token = async n => (await roh('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body.token;
    const admin = await token('admin'), max = await token('max');

    console.log('\nServer: Anfragen');
    const lang = await roh('POST', '/api/entries', max, { date: '2026-09-09', time_from: '07:00', time_to: '12:00', break_minutes: 0, personal_note: 'x'.repeat(2001) });
    ok('zu langes Feld: Beschriftung statt interner Name', lang.status === 400 && fehler(lang) === 'Die persönliche Notiz ist zu lang (höchstens 2000 Zeichen).', lang.status + ' ' + fehler(lang));
    const gross = await roh('POST', '/api/entries', max, { date: '2026-09-09', time_from: '07:00', time_to: '12:00', description: 'x'.repeat(150 * 1024) });
    ok('zu große Anfrage: 413 mit Erklärung statt „Interner Serverfehler"', gross.status === 413 && /zu groß/.test(fehler(gross)), gross.status + ' ' + fehler(gross));
    const kaputt = await roh('POST', '/api/entries', max, '{kaputt');
    ok('kaputtes JSON: 400 „ungültig" statt 500', kaputt.status === 400 && /ungültig/.test(fehler(kaputt)), kaputt.status + ' ' + fehler(kaputt));
    const niemand = await roh('GET', '/api/statistics/overtime?user_id=99999', admin);
    ok('unbekannter Mitarbeiter: „Mitarbeiter nicht gefunden"', niemand.status === 404 && fehler(niemand) === 'Mitarbeiter nicht gefunden', niemand.status + ' ' + fehler(niemand));
    const haendler = await roh('POST', '/api/suppliers', admin, { name: 'Großhandel Test', kundennummer: '1'.repeat(61) });
    ok('Großhändler: „Die Kundennummer ist zu lang"', haendler.status === 400 && /^Die Kundennummer ist zu lang/.test(fehler(haendler)), haendler.status + ' ' + fehler(haendler));

    console.log('\nServer: Hochladen');
    const feldFalsch = await hochladen('/api/documents/upload', admin, 'datei', 'notiz.txt', 'Hallo');
    ok('falsches Formularfeld: deutsch statt „Unexpected field"', feldFalsch.status === 400 && /Formularfeld/.test(fehler(feldFalsch)) && !INNEREIEN.test(fehler(feldFalsch)), fehler(feldFalsch));
    const logoFalsch = await hochladen('/api/settings/logo', admin, 'bild', 'logo.png', 'x');
    ok('Logo mit falschem Feld: ebenso', logoFalsch.status === 400 && !INNEREIEN.test(fehler(logoFalsch)), fehler(logoFalsch));
    // Echter Dateisystemfehler: der Dokumentenordner ist schreibgeschützt
    fs.mkdirSync(DOKUMENTE, { recursive: true });
    fs.chmodSync(DOKUMENTE, 0o555); zurueck.push(() => fs.chmodSync(DOKUMENTE, 0o755));
    const gesperrt = await hochladen('/api/documents/upload', admin, 'file', 'notiz.txt', 'Hallo');
    zurueck.pop()();
    ok('Schreibrechte fehlen: „Hochladen fehlgeschlagen: fehlende Schreibrechte."', gesperrt.status === 400 && fehler(gesperrt) === 'Hochladen fehlgeschlagen: fehlende Schreibrechte.', fehler(gesperrt));
    ok('… ohne Fehlercode und ohne Serverpfad', !INNEREIEN.test(fehler(gesperrt)), fehler(gesperrt));
    ok('… der Rohtext steht dafür im Server-Protokoll', /Dokument hochladen:[\s\S]*EACCES/.test(fs.readFileSync(LOG, 'utf8')));

    console.log('\nOberfläche');
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'max'); await seite.type('#login-pass', pw('max'));
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForFunction(() => document.querySelector('.main')); await sleep(600);
    const zeige = (m) => seite.evaluate((m) => { toast(m, 'error'); return document.querySelector('.toast').textContent; }, m);
    ok('Programmfehler → „Unerwarteter Fehler. Bitte die Seite neu laden."',
      await zeige("Cannot read properties of null (reading 'folders')") === 'Unerwarteter Fehler. Bitte die Seite neu laden.');
    ok('„Failed to fetch" → „Keine Verbindung …"', /^Keine Verbindung zum Server/.test(await zeige('Failed to fetch')));
    ok('eine deutsche Meldung bleibt, wie sie ist', await zeige('Die Datei ist zu groß.') === 'Die Datei ist zu groß.');
    ok('Push: Browserfehler → deutsch',
      /Push-Dienst des Browsers/.test(await seite.evaluate(() => pushFehlerText(new DOMException('Registration failed - push service error', 'AbortError')))));
    ok('Push: „nicht erlaubt" → deutsch',
      /nicht erlaubt/.test(await seite.evaluate(() => pushFehlerText(new DOMException('Permission denied', 'NotAllowedError')))));
    // Abgemeldet: Programmfehler aus noch laufenden Aufrufen erscheinen gar nicht
    const abgemeldet = await seite.evaluate(() => {
      const t = document.querySelector('.toast'); clearTimeout(t._hideTimer); t.classList.remove('show');
      const merk = S.token; S.token = null;
      toast("Cannot read properties of null (reading 'x')", 'error');
      const sichtbar = t.classList.contains('show') || /Cannot read|Unerwartet/.test(t.textContent);
      S.token = merk; return sichtbar;
    });
    await sleep(100);
    ok('abgemeldet: keine Fehlermeldung über der Anmeldeseite', abgemeldet === false);
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const f of zurueck.reverse()) { try { f(); } catch (_) {} }
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nMeldungen auf Deutsch: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
