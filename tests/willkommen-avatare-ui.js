// Profilbilder in der Wochenliste der Willkommensseite (Alex, 31.08.2026).
//
// „aktuell sehen die user die avatare nur in der Planung. Ich hätte aber gerne auch die Avatare auf
// der willkommensseite. Bei der Auflistung mit welchen MA man heute unterwegs ist."
//
// Zwei Dinge, die hier wirklich schiefgehen können:
//
//  * Die Wochenliste wird NACH dem Seitenaufbau gefüllt (eigene Anfrage). Der zentrale
//    Bild-Nachlader in app-1-core.js ist da längst durch — ohne eigenes Nachfassen bleiben die
//    Bilder leer, und beim Blättern zwischen den Wochen erst recht.
//  * Bild und Name gehören zusammen. Bricht die Zeile dazwischen um, steht ein Gesicht am
//    Zeilenende und der Name in der nächsten — dann rät man, wer wer ist.
//
// Wer KEIN Bild hinterlegt hat, bekommt seine Initialen (nicht einen leeren Kreis): In dieser Firma
// hat genau eine Person ein Foto, eine Reihe grauer Kreise wäre also der Normalfall.
//
//   node tests/willkommen-avatare-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3300, DB = '/tmp/willkommen-avatare.db', LOG = '/tmp/willkommen-avatare-srv.log';
const BASIS = `http://localhost:${PORT}`;
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
  const bildDatei = '/tmp/willkommen-avatar-testbild.png';
  fs.writeFileSync(bildDatei, await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer());

  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    const PW = 'Willk!2345';

    const namen = [['ich', 'Ida Ich'], ['mitbild', 'Bruno Bild'], ['ohnebild', 'Otto Ohne'], ['dritter', 'Carla Cee']];
    const ids = {};
    for (const [u, n] of namen) {
      ids[u] = (await req('POST', '/api/users', admin, { username: u, password: PW, name: n,
        role: 'mitarbeiter', target_hours_per_week: 40 })).body.user.id;
    }
    const tok = async u => (await req('POST', '/api/auth/login', null, { username: u, password: PW })).body.token;
    const ichTok = await tok('ich');

    // EIN Termin, auf dem alle vier stehen — genau der Fall „mit wem bin ich unterwegs".
    const heute = new Date().toLocaleDateString('sv-SE');
    const plan = await req('POST', '/api/planning', admin, { date: heute, time_from: '07:00', time_to: '15:30',
      client: 'Baustelle Nord', assigned_user_ids: Object.values(ids) });
    ok('ein gemeinsamer Termin für heute liegt vor', plan.status === 201 || plan.status === 200,
      plan.status + ' ' + plan.text.slice(0, 90));

    // Genau EINER bekommt ein Profilbild — so ist es in der echten Firma auch.
    const bildTok = await tok('mitbild');
    const hoch = await new Promise((res, rej) => {
      const grenze = '----avatar' + Date.now();
      const kopf = Buffer.from(`--${grenze}\r\nContent-Disposition: form-data; name="bild"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
      const fuss = Buffer.from(`\r\n--${grenze}--\r\n`);
      const daten = Buffer.concat([kopf, fs.readFileSync(bildDatei), fuss]);
      const r = http.request({ host: 'localhost', port: PORT, path: '/api/avatare', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + grenze, 'Content-Length': daten.length,
          Authorization: 'Bearer ' + bildTok } },
        x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s })); });
      r.on('error', rej); r.write(daten); r.end();
    });
    ok('genau eine Person hat ein Profilbild', hoch.status === 200 || hoch.status === 201, hoch.status + ' ' + hoch.text.slice(0, 100));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    seite.setDefaultTimeout(45000);
    const jsFehler = [];
    seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'ich'); await seite.type('#login-pass', PW);
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForSelector('a[href="#/statistics"]'); await sleep(2500);

    const lies = () => seite.evaluate(() => {
      const zeile = document.querySelector('.welcome-task-mit');
      if (!zeile) return { zeileDa: false };
      const leute = [...zeile.querySelectorAll('.welcome-mit-person')].map(p => {
        const a = p.querySelector('.avatar');
        const ar = a.getBoundingClientRect(), pr = p.getBoundingClientRect();
        return { text: p.textContent.trim(), bild: getComputedStyle(a).backgroundImage,
                 initialen: a.textContent.trim(),
                 // Bild und Name in derselben Zeile? Dann ist die Personen-Box nicht hoeher als
                 // eine Zeile — sonst waere sie umgebrochen.
                 einzeilig: pr.height < ar.height * 1.8 };
      });
      return { zeileDa: true, leute };
    });

    console.log('\n── In der Wochenliste steht, mit wem man unterwegs ist ──');
    const w = await lies();
    ok('die „mit …"-Zeile ist da', w.zeileDa, JSON.stringify(w));
    ok('… mit allen drei Kollegen', w.leute && w.leute.length === 3, JSON.stringify(w.leute && w.leute.map(l => l.text)));
    ok('… und ohne einen selbst', !(w.leute || []).some(l => /Ida Ich/.test(l.text)), JSON.stringify(w.leute && w.leute.map(l => l.text)));

    console.log('\n── Jeder hat ein Bild ODER seine Initialen ──');
    const mitBild = (w.leute || []).find(l => /Bruno Bild/.test(l.text));
    const ohneBild = (w.leute || []).find(l => /Otto Ohne/.test(l.text));
    ok('wer ein Foto hinterlegt hat, sieht man auch', mitBild && /blob:|url\(/.test(mitBild.bild), JSON.stringify(mitBild));
    ok('… und dann steht KEIN Kürzel mehr darüber', mitBild && mitBild.initialen === '', JSON.stringify(mitBild && mitBild.initialen));
    ok('wer keines hat, bekommt seine Initialen', ohneBild && ohneBild.initialen === 'OO', JSON.stringify(ohneBild));

    console.log('\n── Bild und Name bleiben zusammen ──');
    ok('keine Person bricht zwischen Bild und Name um',
      (w.leute || []).every(l => l.einzeilig), JSON.stringify((w.leute || []).map(l => [l.text, l.einzeilig])));

    console.log('\n── Auch nach dem Blättern in eine andere Woche ──');
    // Der eigentliche Stolperstein: Die Wochenliste wird nachgeladen, der zentrale Bild-Nachlader
    // ist dann längst durch. Ohne eigenes Nachfassen blieben hier leere Kreise stehen.
    const naechsteWoche = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toLocaleDateString('sv-SE'); })();
    await req('POST', '/api/planning', admin, { date: naechsteWoche, time_from: '07:00', time_to: '15:30',
      client: 'Baustelle Süd', assigned_user_ids: Object.values(ids) });
    await seite.evaluate(() => { S.welcomeWeekOffset = 1; renderWelcomeWeek(); });
    await sleep(2200);
    const w2 = await lies();
    ok('auch dort steht die Zeile', w2.zeileDa, JSON.stringify(w2));
    const mitBild2 = (w2.leute || []).find(l => /Bruno Bild/.test(l.text));
    ok('… und das Foto ist auch dort geladen', mitBild2 && /blob:|url\(/.test(mitBild2.bild), JSON.stringify(mitBild2));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(`\nAvatare auf der Willkommensseite: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
