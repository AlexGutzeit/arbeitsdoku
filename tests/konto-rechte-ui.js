// „Zusätzliche Rechte" auf Mein Konto (Alex, 16.09.2026)
//
// Der Anlass: Alex hatte sich Lagerdaten-, Einlern- und Bestellrecht gegeben — auf „Mein Konto"
// standen weiter nur „Schwarzes Brett, Dateien hochladen". Der Server schickte alle sieben
// Schalter, die Anzeige kannte drei davon. Eine handgepflegte Liste neben einer anderen
// handgepflegten Liste, und niemand merkt, wenn die kürzere zurückbleibt.
//
// DIE WICHTIGSTE ZUSICHERUNG steht deshalb ganz unten: Für JEDEN Schlüssel, den der Server in
// `rechte` liefert, muss die Anzeige eine Beschriftung haben. Sie holt sich die Schlüssel vom
// Server, statt sie hier aufzuzählen — eine Liste im Test wäre die dritte, die zurückbleiben kann.
//
//   node tests/konto-rechte-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3325, DB = '/tmp/konto-rechte.db', LOG = '/tmp/konto-rechte.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
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
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    const PW = 'Monteur1!';
    const anlegen = async (u, n) => (await req('POST', '/api/users', admin,
      { username: u, password: PW, name: n, role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;

    const ohne = await anlegen('ohne', 'Ohne Rechte');
    const viel = await anlegen('viel', 'Viele Rechte');
    const stufe = await anlegen('stufe', 'Stufen-Fall');
    // Genau Alex' Lage: Brett + Hochladen + Bestellen + Lagerdaten + Einlernen.
    await req('PUT', `/api/users/${viel.id}`, admin, {
      can_bulletin: 1, can_upload: 1, can_order: 1, can_products_edit: 1, can_products_add: 1 });
    // Nur das GRÖSSERE Recht je Stufe — das kleinere darf dann nicht zusätzlich dastehen.
    await req('PUT', `/api/users/${stufe.id}`, admin, { can_plan_all: 1, can_products_edit: 1 });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];
    const alsWer = async (u) => {
      const ktx = await browser.createBrowserContext();
      const s = await ktx.newPage();
      await s.setViewport({ width: 900, height: 950 });
      s.setDefaultTimeout(30000);
      s.on('pageerror', e => jsFehler.push(e.message));
      await s.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await s.waitForSelector('#login-user');
      await s.type('#login-user', u); await s.type('#login-pass', PW);
      await s.click('#login-form button[type="submit"]'); await sleep(2600);
      await s.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' }); await sleep(2600);
      await s.waitForSelector('#konto-stammdaten', { timeout: 15000 });
      const zeile = await s.evaluate(() => {
        const tr = [...document.querySelectorAll('#konto-stammdaten tr')]
          .find(r => /Zusätzliche Rechte/.test(r.textContent));
        return tr ? tr.textContent.replace(/\s+/g, ' ').replace('Zusätzliche Rechte', '').trim() : null;
      });
      return { ktx, s, zeile };
    };

    console.log('── Wer nichts Zusätzliches hat ──');
    let a = await alsWer('ohne');
    ok('… sieht „keine"', a.zeile === 'keine', JSON.stringify(a.zeile));
    await a.s.close(); await a.ktx.close();

    console.log('\n── Alex\' Lage: fünf Zusatzrechte ──');
    a = await alsWer('viel');
    const z = a.zeile || '';
    for (const [was, muss] of [
      ['Schwarzes Brett', 'Schwarzes Brett'],
      ['Dateien hochladen', 'Dateien hochladen'],
      ['Bestellungen abschließen', 'Bestellungen abschließen'],
      ['Lagerdaten pflegen', 'Lagerdaten pflegen'],
    ]) ok(`… nennt „${was}"`, z.includes(muss), z);
    ok('… und „Artikel einlernen" steht NICHT zusätzlich da (im Pflegen enthalten)',
      !/Artikel einlernen/.test(z), z);
    ok('… es ist genau EINE Zeile, keine Aufzählung über mehrere Felder', (z.match(/,/g) || []).length === 3, z);
    await a.s.close(); await a.ktx.close();

    console.log('\n── Stufen: nur das größere Recht wird genannt ──');
    a = await alsWer('stufe');
    const zs = a.zeile || '';
    ok('„Planung für alle" statt zusätzlich „eigene Planung"',
      /Planung für alle/.test(zs) && !/eigene Planung/.test(zs), zs);
    ok('„Lagerdaten pflegen" sagt dazu, dass das Einlernen eingeschlossen ist',
      /Lagerdaten pflegen \(schließt Einlernen ein\)/.test(zs), zs);
    await a.s.close(); await a.ktx.close();

    console.log('\n── Die Zusicherung gegen das Wiederauftreten ──');
    // Der Server ist die Wahrheit: Fuer JEDEN Schluessel, den er in `rechte` schickt, muss die
    // Anzeige eine Beschriftung haben. Die Schluessel werden hier NICHT aufgezaehlt — sonst waere
    // dieser Test die dritte Liste, die zurueckbleiben kann.
    const tokenViel = (await req('POST', '/api/auth/login', null, { username: 'viel', password: PW })).body.token;
    const vomServer = Object.keys((await req('GET', '/api/users/meine-stammdaten', tokenViel)).body.stammdaten.rechte);
    ok('der Server schickt überhaupt Rechte', vomServer.length >= 3, JSON.stringify(vomServer));
    // RECHTE_NAMEN steht IN der Funktion, nicht global — also wird der Quelltext befragt. Das ist
    // genau die Liste, die zurueckbleiben kann.
    const quelle = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-5-team.js'), 'utf8');
    const block = (quelle.match(/const RECHTE_NAMEN = \{([\s\S]*?)\};/) || [])[1] || '';
    ok('… die Beschriftungs-Tabelle wurde gefunden', block.length > 40, block.slice(0, 60));
    const fehlend = vomServer.filter(k => !new RegExp('(^|\\s)' + k + '\\s*:').test(block));
    ok('… und die Anzeige kennt JEDEN Schlüssel des Servers',
      fehlend.length === 0, 'ohne Beschriftung: ' + JSON.stringify(fehlend));
    // Gegenprobe: ein erfundener Schluessel MUSS als fehlend auffallen — sonst prueft die
    // Zusicherung oben gar nichts.
    ok('… und die Gegenprobe schlägt an (erfundener Schlüssel gilt als fehlend)',
      ['gibtsnicht_xyz'].filter(k => !new RegExp('(^|\\s)' + k + '\\s*:').test(block)).length === 1);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nKonto: Zusätzliche Rechte: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
