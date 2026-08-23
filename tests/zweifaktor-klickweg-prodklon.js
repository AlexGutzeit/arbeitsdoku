// Der ganze Zwei-Faktor-Weg GEKLICKT, an einer Kopie der echten Produktivdaten (Alex, 23.08.2026).
//
// „Es war schon oft genug, dass über API alles ging, aber beim Klicken sind noch einige Fehler
// aufgefallen." Genau deshalb dieser Test. Zwei Stellen waren bis heute überhaupt nie geklickt:
// der Knopf „Zwei-Faktor zurücksetzen" im Mitarbeiter-Dialog und der Notfall-Schalter TWOFA_AUS.
// Beide sind Rettungswege — wenn ausgerechnet die nur über die Schnittstelle funktionieren, merkt
// man das im schlechtesten Moment.
//
// Geklickt wird der komplette Ablauf an echten Konten:
//   1. Admin richtet sich auf „Mein Konto" einen Authenticator ein (Schlüssel aus der Seite lesen)
//   2. Admin schaltet in den Einstellungen die Mitarbeiter-Pflicht scharf — mit Rückfrage und Code
//   3. Ein Mitarbeiter meldet sich an, wird auf „Mein Konto" festgehalten, richtet ein
//   4. Er meldet sich ab und wieder an: Code-Karte, Code eintippen, drin
//   5. Handy weg → der Admin klickt im Mitarbeiter-Dialog auf „Zwei-Faktor zurücksetzen"
//   6. Der Mitarbeiter kommt wieder bis zur Neueinrichtung
//   7. Notfall: Server mit TWOFA_AUS=1 — der Mitarbeiter kommt ohne Code durch
//
// Zum Zeitfenster: Ein Code gilt nur für seinen 30-Sekunden-Schritt, und jeder verbraucht ihn.
// Wer wie hier mehrere hintereinander braucht, muss sich auf ein frisches Fenster stellen. Der
// Test tut das vor jedem Paar (höchstens 30 s Wartezeit) — dieselbe Einschränkung wie im Alltag.
//
// Nur lesend gegenüber der Quelle: Es wird eine Kopie angelegt und ausschließlich darauf gearbeitet.
//   node tests/zweifaktor-klickweg-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const totp = require('../totp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3281, DB = '/tmp/zweifaktor-klickweg.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Auf den Anfang eines frischen 30-Sekunden-Fensters stellen und dessen Mitte zurueckgeben.
async function fensterAnfang() {
  await sleep(30000 - (Date.now() % 30000) + 400);
  return Date.now();
}

let srv = null;
async function starten(extra = {}) {
  const lg = fs.openSync('/tmp/zweifaktor-klickweg-srv.log', 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang', ...extra }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch');
}
async function stoppen() { if (srv) { srv.kill('SIGTERM'); await sleep(1200); srv = null; } }

(async () => {
  if (!fs.existsSync(QUELLE)) {
    console.log(`Prod-Klon ${QUELLE} fehlt — Test uebersprungen.`);
    process.exit(0);
  }
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync('/tmp/zweifaktor-klickweg-srv.log'); } catch (_) {}
  fs.copyFileSync(QUELLE, DB);
  let browser;
  try {
    await starten();
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    const seite = async () => { const p = await browser.newPage(); await p.setViewport({ width: 900, height: 950 }); p.setDefaultTimeout(30000); return p; };
    const anmelden = async (p, nutzer, passwort = 'test') => {
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => localStorage.clear());
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', nutzer); await p.type('#login-pass', passwort);
      await p.click('#login-form button[type="submit"]');
      await sleep(2400);
    };
    // Richtet den Authenticator ueber die OBERFLAECHE ein und gibt den Schluessel zurueck,
    // so wie ihn ein Mensch von der Seite abliest.
    const einrichtenGeklickt = async (p, wann) => {
      await p.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#zfa-start'); await sleep(1200);
      await p.evaluate(() => { const b = document.getElementById('zfa-start'); b.scrollIntoView({ block: 'center' }); b.click(); });
      await p.waitForSelector('#zfa-code'); await sleep(700);
      const schluessel = await p.$eval('#konto-2fa code', el => el.textContent.trim());
      const qrDa = await p.$eval('#zfa-qr', el => /<svg/i.test(el.innerHTML));
      ok('der QR-Code steht auf der Seite', qrDa);
      ok('… und der Schlüssel zum Abtippen daneben', /^[A-Z2-7]{32}$/.test(schluessel), schluessel);
      await p.type('#zfa-code', totp.code(schluessel, wann));
      await p.evaluate(() => document.getElementById('zfa-verify').requestSubmit());
      await sleep(2400);
      return schluessel;
    };

    const alle = (await req('GET', '/api/users',
      (await req('POST', '/api/auth/login', null, { username: 'admin', password: 'test' })).body.token)).body.users;
    const ma = alle.find(u => u.role === 'mitarbeiter' && u.active !== 0);
    ok('ein echter Mitarbeiter aus dem Bestand', !!ma, JSON.stringify(ma && ma.username));

    console.log('── 1./2. Der Admin richtet ein und schaltet scharf — alles geklickt ──');
    let T = await fensterAnfang();
    const pAdmin = await seite();
    await anmelden(pAdmin, 'admin');
    ok('der Admin ist drin (noch ohne Code)', !(await pAdmin.$('#login-user')) && !(await pAdmin.$('#login-code')));
    const adminSchluessel = await einrichtenGeklickt(pAdmin, T - 30000);
    ok('nach dem Bestätigen meldet die Karte „eingerichtet"',
      /eingerichtet|aktiv/i.test(await pAdmin.$eval('#konto-2fa', el => el.innerText)),
      (await pAdmin.$eval('#konto-2fa', el => el.innerText)).replace(/\s+/g, ' ').slice(0, 90));

    await pAdmin.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await pAdmin.waitForSelector('#s-twofa-mitarbeiter'); await sleep(1500);
    await pAdmin.select('#s-twofa-mitarbeiter', 'immer');
    await pAdmin.evaluate(() => document.getElementById('twofa-form').requestSubmit());
    await sleep(900);
    ok('es kommt eine Rückfrage', !!(await pAdmin.$('.dialog-modal [data-act="ok"]')));
    await pAdmin.click('.dialog-modal [data-act="ok"]'); await sleep(900);
    ok('… danach die Code-Abfrage', !!(await pAdmin.$('#pm-input')));
    await pAdmin.type('#pm-input', totp.code(adminSchluessel, T));
    await pAdmin.click('.dialog-modal [data-act="ok"]'); await sleep(2400);
    // Nicht dem Bildschirm glauben, sondern neu laden: Steht der Wert wirklich gespeichert?
    await pAdmin.goto(BASIS + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(1200);
    await pAdmin.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await pAdmin.waitForSelector('#s-twofa-mitarbeiter'); await sleep(1500);
    ok('nach dem Neuladen steht die Pflicht im Auswahlfeld',
      (await pAdmin.$eval('#s-twofa-mitarbeiter', el => el.value)) === 'immer',
      await pAdmin.$eval('#s-twofa-mitarbeiter', el => el.value));
    const adminApi = await req('POST', '/api/auth/login', null, { username: 'admin', password: 'test' });
    ok('… und der Admin wird ab jetzt selbst nach einem Code gefragt',
      adminApi.body.zwei_faktor_erforderlich === true, JSON.stringify(adminApi.body).slice(0, 80));

    console.log('\n── 3. Der Mitarbeiter wird festgehalten und richtet ein ──');
    T = await fensterAnfang();
    const pMa = await seite();
    await anmelden(pMa, ma.username);
    await pMa.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('er landet auf „Mein Konto" statt in der Planung',
      (await pMa.evaluate(() => location.hash)) === '#/konto', await pMa.evaluate(() => location.hash));
    ok('… mit einem Hinweis, warum es nicht weitergeht',
      /Zwei-Faktor/i.test(await pMa.$eval('.warning-box, .main', el => el.innerText).catch(() => '')));
    const maSchluessel = await einrichtenGeklickt(pMa, T - 30000);
    await pMa.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('jetzt kommt er in die Planung', (await pMa.evaluate(() => location.hash)) === '#/planning');

    console.log('\n── 4. Abmelden und mit Code wieder anmelden ──');
    await anmelden(pMa, ma.username);
    ok('die Anmeldung zeigt die Code-Karte', !!(await pMa.$('#login-code')));
    await pMa.type('#login-code', totp.code(maSchluessel, T));
    await pMa.click('#code-form button[type="submit"]'); await sleep(2600);
    ok('… und mit dem Code ist er drin', !(await pMa.$('#login-code')) && !(await pMa.$('#login-user')));

    console.log('\n── 5. Handy weg: der Admin klickt „Zwei-Faktor zurücksetzen" ──');
    // Dieser Knopf war bis heute in KEINEM Test geklickt — nur die Route dahinter.
    T = await fensterAnfang();
    await anmelden(pAdmin, 'admin');
    ok('der Admin muss jetzt selbst einen Code eintippen', !!(await pAdmin.$('#login-code')));
    await pAdmin.type('#login-code', totp.code(adminSchluessel, T));
    await pAdmin.click('#code-form button[type="submit"]'); await sleep(2600);
    ok('… und ist drin', !(await pAdmin.$('#login-code')));
    await pAdmin.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await pAdmin.waitForSelector('.edit-user'); await sleep(1500);
    await pAdmin.evaluate((id) => {
      const b = document.querySelector(`.edit-user[data-id="${id}"]`); b.scrollIntoView({ block: 'center' }); b.click();
    }, ma.id);
    await pAdmin.waitForSelector('#um-2fa-reset-btn'); await sleep(800);
    ok('der Knopf ist im Mitarbeiter-Dialog da', !!(await pAdmin.$('#um-2fa-reset-btn')));
    await pAdmin.evaluate(() => { const b = document.getElementById('um-2fa-reset-btn'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(900);
    const bestaetigung = await pAdmin.$('.dialog-modal [data-act="ok"]');
    if (bestaetigung) { await pAdmin.click('.dialog-modal [data-act="ok"]'); await sleep(2200); }
    ok('… und der Klick hat wirklich gewirkt',
      (await req('POST', '/api/auth/login', null, { username: ma.username, password: 'test' })).body.zwei_faktor_erforderlich === undefined,
      'nach dem Zuruecksetzen darf kein Code mehr verlangt werden');

    console.log('\n── 6. Der Mitarbeiter kommt bis zur Neueinrichtung ──');
    await anmelden(pMa, ma.username);
    ok('kein Code mehr verlangt', !(await pMa.$('#login-code')));
    await pMa.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(2200);
    ok('… aber wieder auf „Mein Konto" festgehalten', (await pMa.evaluate(() => location.hash)) === '#/konto');

    console.log('\n── 7. Notfall-Schalter, ebenfalls geklickt ──');
    await browser.close(); browser = null;
    await stoppen();
    await starten({ TWOFA_AUS: '1' });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const pNot = await seite();
    await anmelden(pNot, ma.username);
    ok('keine Code-Karte', !(await pNot.$('#login-code')));
    await pNot.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' }); await sleep(2400);
    ok('… und er kommt in die Planung, ohne festgehalten zu werden',
      (await pNot.evaluate(() => location.hash)) === '#/planning', await pNot.evaluate(() => location.hash));
    ok('… die Seite zeigt echte Daten', (await pNot.$eval('.main', el => el.innerText)).length > 60);

  } finally {
    if (browser) await browser.close();
    await stoppen();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nZwei-Faktor geklickt (Prod-Klon): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
