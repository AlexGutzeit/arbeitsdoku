// Profilbild fehlt auf der Platte: keine hängenden Verbindungen, ein Abruf je Person, nicht dauernd neu fragen.
//
// Fund vom 05.10.2026: barrierefrei-prodklon lief in eine Zeitüberschreitung. In der Prod-Kopie stehen zwei
// Personen mit Bild in der Datenbank, die Bilddateien liegen aber nicht bei — der Server antwortet 404. Die App
// las den Inhalt dieser Antwort nie, der Browser hielt die Verbindung deshalb für belegt; und weil jeder Kreis
// derselben Person (Kollegen-Menü, Übersicht …) neu fragte, häuften sich offene Verbindungen. Über HTTP/1.1 sind
// es höchstens sechs je Server — danach hätten auch normale Anfragen der App gewartet.
// Kann im Betrieb passieren, sobald eine Datei fehlt: Zurückspielen ohne Bilder, Zweitanlage, Prod-Kopie.
//
//   node tests/avatar-fehlt-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3372, DB = '/tmp/avatar-fehlt-ui.db', BASIS = `http://localhost:${PORT}`;
const BILDER = path.join(__dirname, '..', 'storage', 'avatare');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function hochladen(token, buf) {
  const rand = '----af' + Date.now();
  const koerper = Buffer.concat([
    Buffer.from(`--${rand}\r\nContent-Disposition: form-data; name="bild"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf, Buffer.from(`\r\n--${rand}--\r\n`)]);
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + rand, 'Content-Length': koerper.length } },
      x => { x.resume(); x.on('end', () => res(x.statusCode)); });
    r.on('error', rej); r.write(koerper); r.end();
  });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  const lg = fs.openSync('/tmp/avatar-fehlt-ui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/avatar-fehlt-ui-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const anlegen = async (username, name) => (await req('POST', '/api/users', admin, { username, password: 'Start!2345', name, role: 'mitarbeiter',
      hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40 })).body.user;
    const anna = await anlegen('anna', 'Anna Berger');
    await anlegen('bernd', 'Bernd Kraus');
    const annaT = (await req('POST', '/api/auth/login', null, { username: 'anna', password: 'Start!2345' })).body.token;
    ok('Anna hat ein Bild', (await hochladen(annaT, await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer())) < 300);
    for (const f of fs.readdirSync(BILDER)) fs.unlinkSync(path.join(BILDER, f));      // … aber die Dateien fehlen
    ok('… die Dateien sind weg, der Eintrag steht noch (Server: 404)', (await req('GET', '/api/avatare/' + anna.id, annaT)).status === 404
      && Object.keys((await req('GET', '/api/avatare', annaT)).body.stand).includes(String(anna.id)));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 900 }); p.setDefaultTimeout(30000);
    const anfragen = []; const offen = new Set();
    const istAnna = (r) => new RegExp('/api/avatare/' + anna.id + '(\\?|$)').test(r.url());
    p.on('request', r => { if (istAnna(r)) { anfragen.push(r.url().includes('gross') ? 'gross' : 'klein'); offen.add(r); } });
    p.on('requestfinished', r => offen.delete(r)); p.on('requestfailed', r => offen.delete(r));
    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'bernd'); await p.type('#login-pass', 'Start!2345');
    await p.click('#login-form button[type="submit"]'); await sleep(2500);

    console.log('── Kollegen-Übersicht: Anna steht im Menü UND auf einer Karte ──');
    await p.evaluate(() => { location.hash = '#/kollegen'; }); await sleep(3000);
    const kreise = await p.$$eval('.avatar[title="Anna Berger"]', es => es.map(e => ({ text: e.textContent.trim(), bild: /blob:/.test(getComputedStyle(e).backgroundImage) })));
    ok('Anna steht mehrfach auf der Seite', kreise.length >= 2, String(kreise.length));
    ok('… überall mit Initialen statt Bild', kreise.every(k => k.text === 'AB' && !k.bild), JSON.stringify(kreise));
    ok('… und es gab EINE Anfrage für ihr Bild, nicht eine je Kreis', anfragen.filter(a => a === 'klein').length === 1, JSON.stringify(anfragen));
    ok('keine Verbindung hängt fest (die 404-Antwort wird verworfen)', offen.size === 0, [...offen].map(r => r.url()).join(', '));

    console.log('\n── Weiter durch die App ──');
    for (const h of ['#/welcome', '#/planning', '#/kollegen']) { await p.evaluate(x => { location.hash = x; }, h); await sleep(1500); }
    ok('das fehlende Bild wird nicht bei jeder Seite neu angefragt', anfragen.filter(a => a === 'klein').length === 1, JSON.stringify(anfragen));
    await p.evaluate(id => { location.hash = '#/kollegen/' + id; }, anna.id); await sleep(2500);
    ok('ihre Seite fragt das große Bild genau einmal', anfragen.filter(a => a === 'gross').length === 1, JSON.stringify(anfragen));
    ok('… und auch dort hängt nichts', offen.size === 0, [...offen].map(r => r.url()).join(', '));
    ok('… großer Kreis mit Initialen', (await p.$eval('.kollege-kopf .avatar', e => e.textContent.trim())) === 'AB');

    console.log('\n── Neu laden auf der Übersicht: Menü und Karte warten GEMEINSAM auf ihr Bild ──');
    // Beim Start stehen Menü und Karte schon da, bevor die App weiß, wer ein Bild hat; dann werden beide in
    // EINEM Durchgang nachgeladen. Genau hier muss der laufende Abruf geteilt werden — der Merker für fehlende
    // Bilder hilft noch nicht, er ist nach dem Neuladen leer.
    await p.evaluate(() => { location.hash = '#/kollegen'; }); await sleep(1500);
    anfragen.length = 0;
    await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3500);
    const kreiseNeu = await p.$$eval('.avatar[title="Anna Berger"]', es => es.length);
    ok('nach dem Neuladen steht Anna wieder mehrfach da', kreiseNeu >= 2, String(kreiseNeu));
    ok('… und trotzdem EINE Anfrage (der laufende Abruf wird geteilt)', anfragen.filter(a => a === 'klein').length === 1, JSON.stringify(anfragen));
    ok('… nichts hängt', offen.size === 0, [...offen].map(r => r.url()).join(', '));
  } catch (e) {
    fail++; fails.push('Abbruch: ' + e.message); console.log('  ✗ Abbruch: ' + e.stack);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    srv.kill();
    try { fs.rmSync(BILDER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nFehlendes Profilbild: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
