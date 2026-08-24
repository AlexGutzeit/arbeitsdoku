// Eine verschlüsselte Sicherung über die Oberfläche einspielen (Alex, 24.08.2026).
//
// Sein Wunsch war ausdrücklich: „die verschlüsselte Datei in Einstellungen → Backups einfügen,
// dort den Schlüssel eingeben und dann wird das Backup eingespielt." Genau dieser Weg wird hier
// geklickt — nicht die Schnittstelle darunter.
//
// Die entscheidende Prüfung ist nicht, DASS es klappt, sondern WO entschlüsselt wird: Der
// Schlüssel darf den Rechner nicht verlassen. Sonst wäre die ganze Übung sinnlos — ein Server,
// der den Schlüssel einmal sieht, kann danach jede Sicherung lesen. Deshalb wird jede Anfrage
// mitgeschnitten und nachgesehen, was wirklich hinausging.
//
//   node tests/backup-einspielen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const krypto = require('../backup-krypto');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3285, DB = '/tmp/backup-einspielen.db', BASIS = `http://localhost:${PORT}`;
const DATEI = '/tmp/backup-einspielen-probe.adbk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function holen(p, t) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, headers: { Authorization: 'Bearer ' + t } },
      x => { const teile = []; x.on('data', c => teile.push(c)); x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(teile) })); });
    r.on('error', rej); r.end();
  });
}

const KUNDE = 'Sonnenhof Zapfendorf GmbH';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const minipc = krypto.paarErzeugen();
  const fremd = krypto.paarErzeugen();
  const lg = fs.openSync('/tmp/backup-einspielen-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      BACKUP_EMPFAENGER: `minipc:${minipc.oeffentlich}` }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/backup-einspielen-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;

    // Stand herstellen, sichern, dann den Stand kaputtmachen — nur so zeigt sich, dass das
    // Einspielen wirklich etwas bewirkt hat.
    await req('POST', '/api/projects', admin, { name: KUNDE, address: 'Hauptstr. 3' });
    const sicherung = await holen('/api/backup/download', admin);
    ok('die Sicherung ist verschlüsselt', krypto.istContainer(sicherung.buf));
    fs.writeFileSync(DATEI, sicherung.buf);
    const weg = (await req('GET', '/api/projects', admin)).body.projects.find(p => p.name === KUNDE);
    await req('DELETE', `/api/projects/${weg.id}`, admin);
    ok('der Kunde ist vor dem Einspielen weg',
      !((await req('GET', '/api/projects', admin)).body.projects || []).some(p => p.name === KUNDE));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 950 });
    page.setDefaultTimeout(30000);

    // Jede Anfrage mitschneiden: Womit ruft die Seite den Server? Bei FormData werden die
    // Textfelder mitgelesen — ein Schluessel wuerde genau dort auftauchen.
    await page.evaluateOnNewDocument(() => {
      window.__gesendet = [];
      const echt = window.fetch;
      window.fetch = async function (...args) {
        const eintrag = { url: String(args[0]), felder: [], dateiKopf: null };
        try {
          const o = args[1] || {};
          if (typeof o.body === 'string') eintrag.felder.push(o.body);
          else if (o.body instanceof FormData) {
            for (const [k, v] of o.body.entries()) {
              if (typeof v === 'string') eintrag.felder.push(k + '=' + v);
              else {
                eintrag.felder.push(k + '=<datei ' + v.size + '>');
                const kopf = new Uint8Array(await v.slice(0, 4).arrayBuffer());
                eintrag.dateiKopf = Array.from(kopf).map(x => x.toString(16).padStart(2, '0')).join('');
              }
            }
          }
        } catch (_) {}
        window.__gesendet.push(eintrag);
        return echt.apply(this, args);
      };
    });

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', pw('admin'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);
    await page.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#backup-restore-btn'); await sleep(1500);

    console.log('\n── Die Datei wählen ──');
    await page.click('#backup-restore-btn'); await sleep(500);
    ok('das Schlüsselfeld ist noch verborgen',
      await page.evaluate(() => getComputedStyle(document.getElementById('restore-schluessel')).display === 'none'));
    await (await page.$('#backup-file')).uploadFile(DATEI);
    await sleep(1200);
    ok('… und erscheint, sobald die Datei verschlüsselt ist',
      await page.evaluate(() => getComputedStyle(document.getElementById('restore-schluessel')).display !== 'none'));
    ok('… mit dem Hinweis, wer sie öffnen kann',
      /minipc/.test(await page.$eval('#backup-schluessel-info', el => el.textContent)),
      await page.$eval('#backup-schluessel-info', el => el.textContent));

    console.log('\n── Ohne Schlüssel geht nichts ──');
    await page.click('#restore-confirm'); await sleep(1200);
    ok('es wird nichts eingespielt',
      !((await req('GET', '/api/projects', admin)).body.projects || []).some(p => p.name === KUNDE));
    ok('… und es kam keine Anfrage an /restore',
      !(await page.evaluate(() => window.__gesendet.some(g => g.url.includes('/restore')))));

    console.log('\n── Mit falschem Schlüssel ──');
    await page.evaluate((k) => { document.getElementById('backup-schluessel').value = k; }, fremd.privat);
    await page.click('#restore-confirm'); await sleep(1500);
    ok('immer noch nichts eingespielt',
      !((await req('GET', '/api/projects', admin)).body.projects || []).some(p => p.name === KUNDE));
    const meldung = await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).textContent || '');
    ok('… und eine Meldung, die den Grund nennt', /gehört nicht|Schlüssel/i.test(meldung), `„${meldung}"`);

    console.log('\n── Mit richtigem Schlüssel ──');
    await page.evaluate((k) => { document.getElementById('backup-schluessel').value = k; }, minipc.privat);
    await page.click('#restore-confirm'); await sleep(1200);
    const dialog = await page.$('.dialog-modal [data-act="ok"]');
    ok('es kommt die Sicherheitsabfrage', !!dialog);
    await page.click('.dialog-modal [data-act="ok"]');
    // WICHTIG: Der Mitschnitt muss VOR dem Neuladen gelesen werden. Nach erfolgreichem Einspielen
    // meldet die App ab und laedt die Seite neu — dabei ist window.__gesendet weg. (Genau daran
    // ist dieser Test beim ersten Wurf gescheitert, und zwar ohne dass an der App etwas war.)
    await sleep(1300);
    const gesendet = await page.evaluate(() => window.__gesendet);
    await sleep(2500);   // jetzt den Neustart abwarten
    ok('der Kunde ist wieder da',
      ((await req('GET', '/api/projects', admin)).body.projects || []).some(p => p.name === KUNDE));

    console.log('\n── Und was ging dabei über die Leitung? ──');
    const restore = gesendet.filter(g => g.url.includes('/restore'));
    ok('genau eine Anfrage an /restore', restore.length === 1, String(restore.length));
    ok('… sie enthielt eine Datei, die mit PK beginnt — also ein ZIP, kein Container',
      restore[0] && restore[0].dateiKopf === '504b0304', restore[0] && restore[0].dateiKopf);
    // Der Kern der Sache.
    const alleFelder = JSON.stringify(gesendet);
    ok('DER SCHLÜSSEL TAUCHT IN KEINER EINZIGEN ANFRAGE AUF',
      !alleFelder.includes(minipc.privat) && !alleFelder.includes(fremd.privat),
      'er wurde mitgeschickt!');
    ok('… auch nicht in Teilen (erste 40 Zeichen)',
      !alleFelder.includes(minipc.privat.slice(0, 40)));

    console.log('\n── Das Hilfsprogramm lässt sich herunterladen ──');
    const ordner = '/tmp/backup-einspielen-dl';
    fs.rmSync(ordner, { recursive: true, force: true }); fs.mkdirSync(ordner, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ordner });
    // Nach dem Einspielen ist man abgemeldet — also erst wieder anmelden.
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', pw('admin'));
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);
    await page.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#backup-werkzeug'); await sleep(1200);
    await page.evaluate(() => { const b = document.getElementById('backup-werkzeug'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(2500);
    const da = fs.readdirSync(ordner);
    ok('die Datei kommt an', da.includes('sicherung-entschluesseln.html'), da.join(', '));
    if (da.length) {
      const inhalt = fs.readFileSync(path.join(ordner, da[0]), 'utf8');
      ok('… sie ist in sich geschlossen (keine externe Quelle)',
        !/<script[^>]+src=/i.test(inhalt) && !/<link[^>]+href=/i.test(inhalt));
      ok('… und enthält die Entschlüsselung', inhalt.includes('SicherungKrypto'));
    }
    fs.rmSync(ordner, { recursive: true, force: true });

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.unlinkSync(DATEI); } catch (_) {}
  }
  console.log(`\nSicherung einspielen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
