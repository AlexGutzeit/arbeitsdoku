// Das Hilfsprogramm für den Ernstfall — geöffnet wie durch einen Doppelklick.
//
// Wenn die App nicht läuft, gibt es keine Einstellungsseite. Genau dann braucht man eine
// Sicherung. Diese eine Datei muss das dann allein können: von der Festplatte geöffnet, ohne
// Internet, ohne Installation.
//
// Deshalb wird hier ausdrücklich über `file://` geladen und nicht über einen Webserver — nur so
// ist geprüft, was beim Doppelklick wirklich passiert. Und geprüft wird die HERUNTERGELADENE
// Fassung, also die mit eingebetteter Entschlüsselung, nicht die Vorlage aus dem Repository.
//
//   node tests/backup-entschluesseln-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { Readable } = require('stream');
const puppeteer = require('puppeteer');
const krypto = require('../backup-krypto');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3286, DB = '/tmp/backup-werkzeug.db';
const ARBEIT = '/tmp/backup-werkzeug-probe';
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
const verschluesseln = (daten, e) => new Promise((res, rej) => {
  const t = []; Readable.from([daten]).pipe(krypto.verschluesselnStream(e))
    .on('data', d => t.push(d)).on('end', () => res(Buffer.concat(t))).on('error', rej);
});

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.rmSync(ARBEIT, { recursive: true, force: true });
  fs.mkdirSync(ARBEIT + '/dl', { recursive: true });

  const minipc = krypto.paarErzeugen();
  const offline = krypto.paarErzeugen();
  const fremd = krypto.paarErzeugen();
  const empf = (n, p) => ({ name: n, schluessel: krypto.oeffentlichLesen(p.oeffentlich), b64: p.oeffentlich });

  const lg = fs.openSync('/tmp/backup-werkzeug-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/backup-werkzeug-srv.log', 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;

    // Die HERUNTERGELADENE Fassung holen — die mit eingebetteter Entschlüsselung.
    const w = await holen('/api/backup/entschluesseler', admin);
    const werkzeug = path.join(ARBEIT, 'sicherung-entschluesseln.html');
    fs.writeFileSync(werkzeug, w.buf);
    ok('das Hilfsprogramm liegt als eine Datei vor', w.status === 200 && w.buf.length > 3000);

    // Ein „Zip", an dem sich Byte-Gleichheit messen lässt.
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('arbeitsdoku.db Sonnenhof Zapfendorf'), require('crypto').randomBytes(40000)]);
    const container = await verschluesseln(zip, [empf('minipc', minipc), empf('offline', offline)]);
    const cDatei = path.join(ARBEIT, 'sicherung_2026-08-24.adbk');
    fs.writeFileSync(cDatei, container);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 950 });
    page.setDefaultTimeout(30000);
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ARBEIT + '/dl' });

    const oeffnen = async () => {
      await page.goto('file://' + werkzeug, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#los'); await sleep(400);
    };
    const dateiWaehlen = async (p) => { await (await page.$('#datei')).uploadFile(p); await sleep(700); };
    const schluesselSetzen = (k) => page.evaluate((v) => {
      const t = document.getElementById('schluessel'); t.value = v;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }, k);
    const meldung = () => page.$eval('#meldung', el => el.textContent.replace(/\s+/g, ' ').trim());

    console.log('\n── Per Doppelklick geöffnet (file://) ──');
    await oeffnen();
    ok('die Seite läuft von der Festplatte', await page.evaluate(() => location.protocol === 'file:'));
    ok('… ist ein sicherer Kontext (sonst gäbe es keine Verschlüsselung)',
      await page.evaluate(() => window.isSecureContext === true));
    ok('… die Entschlüsselung ist eingebettet', await page.evaluate(() => typeof window.SicherungKrypto === 'object'));
    ok('… und der Knopf ist noch gesperrt', await page.evaluate(() => document.getElementById('los').disabled));

    console.log('\n── Datei hineingeben ──');
    await dateiWaehlen(cDatei);
    ok('der Dateiname erscheint', /adbk/.test(await page.$eval('#ablage-text', el => el.textContent)));
    ok('… und es steht dort, wer sie öffnen kann',
      /minipc.*offline/.test(await page.$eval('#datei-info', el => el.textContent)),
      await page.$eval('#datei-info', el => el.textContent));
    ok('der Knopf bleibt gesperrt, solange kein Schlüssel da ist',
      await page.evaluate(() => document.getElementById('los').disabled));

    console.log('\n── Falscher Schlüssel ──');
    await schluesselSetzen(fremd.privat);
    await page.click('#los'); await sleep(900);
    ok('es kommt eine verständliche Meldung', /gehört nicht zu dieser Sicherung/i.test(await meldung()), await meldung());
    ok('… und keine Datei wird gespeichert', fs.readdirSync(ARBEIT + '/dl').length === 0);

    console.log('\n── Unsinn statt Schlüssel ──');
    await schluesselSetzen('das ist kein schluessel');
    await page.click('#los'); await sleep(900);
    ok('ebenfalls eine Meldung, kein Absturz', /unbrauchbar|Schlüssel/i.test(await meldung()), await meldung());

    console.log('\n── Richtiger Schlüssel (Mini-PC) ──');
    await schluesselSetzen(minipc.privat);
    await page.click('#los'); await sleep(2000);
    let da = fs.readdirSync(ARBEIT + '/dl');
    ok('eine Datei wird gespeichert', da.length === 1, da.join(', '));
    ok('… und sie heißt wie die Sicherung, nur als .zip',
      da[0] === 'sicherung_2026-08-24.zip', da[0]);
    ok('… und ist Byte für Byte das ursprüngliche Zip',
      fs.readFileSync(path.join(ARBEIT + '/dl', da[0])).equals(zip));
    ok('… die Meldung sagt, wo die Datei liegt und was damit zu tun ist',
      /Downloads/.test(await meldung()) && /Backup/.test(await meldung()), await meldung());

    console.log('\n── Der zweite Schlüssel öffnet dieselbe Datei ──');
    fs.rmSync(ARBEIT + '/dl', { recursive: true, force: true }); fs.mkdirSync(ARBEIT + '/dl');
    await oeffnen();
    await dateiWaehlen(cDatei);
    await schluesselSetzen(offline.privat);
    await page.click('#los'); await sleep(2000);
    da = fs.readdirSync(ARBEIT + '/dl');
    ok('auch der Offline-Schlüssel liefert dasselbe Zip',
      da.length === 1 && fs.readFileSync(path.join(ARBEIT + '/dl', da[0])).equals(zip), da.join(', '));

    console.log('\n── Eine unverschlüsselte Datei sagt es freundlich ──');
    const klarDatei = path.join(ARBEIT, 'schon_offen.zip');
    fs.writeFileSync(klarDatei, zip);
    await oeffnen();
    await dateiWaehlen(klarDatei);
    ok('der Hinweis nennt den Fall beim Namen',
      /nicht verschlüsselt/i.test(await page.$eval('#datei-info', el => el.textContent)),
      await page.$eval('#datei-info', el => el.textContent));

    console.log('\n── Wirklich ohne Verbindung nach draußen ──');
    const fremdeAnfragen = [];
    page.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) fremdeAnfragen.push(r.url()); });
    await oeffnen();
    await dateiWaehlen(cDatei);
    await schluesselSetzen(minipc.privat);
    await page.click('#los'); await sleep(1500);
    ok('die Seite hat NICHTS aus dem Netz geholt', fremdeAnfragen.length === 0, fremdeAnfragen.join(', '));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
    fs.rmSync(ARBEIT, { recursive: true, force: true });
  }
  console.log(`\nHilfsprogramm (Doppelklick): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
