// Die Empfängerliste, geklickt statt aufgerufen (Alex, 25.08.2026).
//
// Über die API ging bei diesem Projekt schon oft alles glatt, während beim Klicken doch etwas
// hakte. Deshalb hier der Weg, den ein Betreiber wirklich geht: Einstellungen → Backup, Schlüssel
// erzeugen lassen, hinterlegen, prüfen, entfernen.
//
// Die Zeile, an der alles hängt: Der PRIVATE Schlüssel darf in KEINER Anfrage vorkommen — weder
// beim Erzeugen noch beim Prüfen. Ein Server, der ihn einmal sieht, kann danach jede Sicherung
// lesen, und die ganze Übung wäre umsonst. Deshalb wird jede Anfrage mitgeschnitten und
// nachgesehen, was wirklich hinausging.
//
//   node tests/backup-empfaenger-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const krypto = require('../backup-krypto');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3288, DB = '/tmp/backup-empf-ui.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/backup-empf-ui-srv.log';
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
// Im Modal auf einen Knopf tippen (confirmModal/promptModal aus app-1-core.js).
async function modal(page, aktion, text) {
  await page.waitForSelector('.dialog-modal', { timeout: 8000 });
  if (text !== undefined) {
    await page.waitForSelector('#pm-input');
    await page.evaluate(t => { document.getElementById('pm-input').value = t; }, text);
  }
  await page.click(`.dialog-modal [data-act="${aktion}"]`);
  await sleep(900);
}
const listenText = (page) => page.evaluate(() => document.getElementById('empf-liste').innerText);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      BACKUP_EMPFAENGER: '' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    await req('POST', '/api/projects', admin, { name: 'Sonnenhof Zapfendorf GmbH', address: 'Hauptstr. 3' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 1000 });
    page.setDefaultTimeout(30000);

    // Wirklich mitlesen, statt es zu behaupten: Ein Tippfehler im neuen Oberflaechen-Code faellt
    // sonst nirgends auf — die Liste bliebe einfach leer und alles andere waere trotzdem gruen.
    const jsFehler = [];
    page.on('pageerror', e => jsFehler.push('pageerror: ' + e.message));
    page.on('console', m => {
      // „Failed to load resource" ist Chromes Notiz zu einer Antwort ausserhalb 2xx — kein
      // JavaScript-Fehler. Ein abgelehnter Doppel-Eintrag (409) ist ein normaler Bedienweg und
      // soll den Test nicht rot faerben; alles andere schon.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) jsFehler.push('console: ' + m.text());
    });

    // Mitschnitt JEDER Anfrage samt Rumpf — hier wird nachher nach dem privaten Schlüssel gesucht.
    await page.evaluateOnNewDocument(() => {
      window.__gesendet = [];
      const echt = window.fetch;
      window.fetch = async function (...args) {
        const eintrag = { url: String(args[0]), felder: [] };
        try {
          const o = args[1] || {};
          if (typeof o.body === 'string') eintrag.felder.push(o.body);
          else if (o.body instanceof FormData) for (const [k, v] of o.body.entries()) eintrag.felder.push(k + '=' + (typeof v === 'string' ? v : '<datei>'));
        } catch (_) {}
        window.__gesendet.push(eintrag);
        return echt.apply(this, args);
      };
    });

    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'admin'); await page.type('#login-pass', pw);
    await page.click('#login-form button[type="submit"]');
    await sleep(2500);
    await page.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#empf-liste'); await sleep(1500);

    console.log('── Ohne Schlüssel: die Karte sagt es deutlich ──');
    ok('Warnung „unverschlüsselt" steht da', /unverschlüsselt/i.test(await listenText(page)), (await listenText(page)).slice(0, 80));
    ok('der Notfall-Entschlüsseler ist verborgen (es gibt nichts zu entschlüsseln)',
      await page.evaluate(() => getComputedStyle(document.getElementById('empf-werkzeug')).display === 'none'));
    ok('das Formular ist zu', await page.evaluate(() => getComputedStyle(document.getElementById('empf-form')).display === 'none'));

    console.log('\n── Schlüssel im Browser erzeugen ──');
    await page.click('#empf-add'); await sleep(400);
    await page.type('#empf-name', 'Chefin');
    await page.click('#empf-gen'); await sleep(1200);
    const privat = await page.evaluate(() => document.getElementById('empf-privat-wert').value);
    const oeffentlich = await page.evaluate(() => document.getElementById('empf-key').value);
    ok('ein privater Schlüssel wird angezeigt', privat.length > 100, String(privat.length));
    ok('… und ein öffentlicher steht im Feld', oeffentlich.length > 100, String(oeffentlich.length));
    ok('… beide gehören zusammen und sind brauchbar', (() => {
      try { return krypto.schluesselPruefen(oeffentlich).fingerabdruck === krypto.fingerabdruck(oeffentlich); }
      catch (_) { return false; }
    })());
    ok('der Warnkasten zum privaten Schlüssel ist sichtbar',
      await page.evaluate(() => getComputedStyle(document.getElementById('empf-privat')).display !== 'none'));

    console.log('\n── Erst sichern, dann speichern ──');
    await page.click('#empf-save'); await sleep(900);
    ok('ohne Haken wird nicht gespeichert', (await listenText(page)).includes('unverschlüsselt'), (await listenText(page)).slice(0, 60));
    await page.click('#empf-privat-ok');
    await page.click('#empf-save'); await sleep(1500);
    const text = await listenText(page);
    ok('mit Haken steht „Chefin" in der Liste', /Chefin/.test(text), text.slice(0, 120));
    ok('… mit Fingerabdruck', /[0-9a-f]{4} [0-9a-f]{4}/.test(text), text.slice(0, 120));
    ok('… und als „noch nicht geprüft"', /noch nicht geprüft/.test(text), text.slice(0, 160));
    ok('das Formular ist wieder zu', await page.evaluate(() => getComputedStyle(document.getElementById('empf-form')).display === 'none'));
    ok('der private Schlüssel steht nicht mehr auf der Seite',
      !(await page.evaluate(() => document.body.innerText)).includes(privat.slice(0, 40)));
    ok('der Notfall-Entschlüsseler ist jetzt da',
      await page.evaluate(() => getComputedStyle(document.getElementById('empf-werkzeug')).display !== 'none'));

    console.log('\n── Wirkt sich das wirklich auf die Sicherung aus? ──');
    const d = await holen('/api/backup/download', admin);
    ok('der Download ist ein ADBK1-Container', krypto.istContainer(d.buf), d.buf.subarray(0, 6).toString('hex'));
    ok('… und der im Browser erzeugte Schlüssel öffnet ihn',
      krypto.entschluesseln(d.buf, privat).subarray(0, 2).toString('hex') === '504b');

    console.log('\n── Prüfen: der Beweis über die Oberfläche ──');
    await page.click('.empf-pruefen'); await sleep(600);
    await modal(page, 'ok', 'völliger unsinn');
    await sleep(1200);
    ok('falscher Schlüssel → bleibt ungeprüft', /noch nicht geprüft/.test(await listenText(page)), (await listenText(page)).slice(0, 160));
    await page.click('.empf-pruefen'); await sleep(600);
    await modal(page, 'ok', privat);
    await sleep(1500);
    ok('richtiger Schlüssel → „geprüft am"', /geprüft am/.test(await listenText(page)), (await listenText(page)).slice(0, 160));

    console.log('\n── Der private Schlüssel darf nirgends hingegangen sein ──');
    const gesendet = await page.evaluate(() => window.__gesendet);
    const treffer = gesendet.filter(e => e.felder.some(f => f.includes(privat.slice(0, 40))));
    ok(`in KEINER der ${gesendet.length} Anfragen steht der private Schlüssel`, treffer.length === 0,
      JSON.stringify(treffer.map(t => t.url)));
    ok('… auch nicht in Teilen (die ersten 24 Zeichen)',
      !gesendet.some(e => e.felder.some(f => f.includes(privat.slice(0, 24)))));
    const probeAnfragen = gesendet.filter(e => /probe\/bestaetigen/.test(e.url));
    ok('die Bestätigung schickt nur den entschlüsselten Zufall', probeAnfragen.length >= 1
      && probeAnfragen.every(e => e.felder.every(f => /^\{"klartext":"[A-Za-z0-9+/=]{40,50}"\}$/.test(f))),
      JSON.stringify(probeAnfragen.map(e => e.felder)).slice(0, 120));

    console.log('\n── Der wahrscheinlichste Fehlgriff ──');
    await page.click('#empf-add'); await sleep(400);
    await page.evaluate(() => { document.getElementById('empf-name').value = 'Falsch'; });
    await page.evaluate(p => { document.getElementById('empf-key').value = p; }, privat);
    const vorher = (await page.evaluate(() => window.__gesendet)).length;
    await page.click('#empf-save'); await sleep(1200);
    const nachher = (await page.evaluate(() => window.__gesendet)).length;
    ok('privater Schlüssel im Feld für den öffentlichen → gar keine Anfrage', nachher === vorher, `${vorher} → ${nachher}`);
    ok('… die Meldung sagt, was falsch ist',
      /PRIVATE/.test(await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).innerText || '')),
      await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).innerText || '(kein Toast)'));
    await page.click('#empf-cancel'); await sleep(400);

    console.log('\n── Entfernen, mit Ansage ──');
    await page.click('.empf-del'); await sleep(600);
    const dialogText = await page.evaluate(() => document.querySelector('.dialog-modal .modal-body').innerText);
    ok('der Dialog erklärt, dass alte Sicherungen lesbar bleiben', /bereits erzeugte/i.test(dialogText), dialogText.slice(0, 140));
    await modal(page, 'cancel');
    ok('Abbrechen lässt den Eintrag stehen', /Chefin/.test(await listenText(page)));
    await page.click('.empf-del'); await sleep(600);
    await modal(page, 'ok');
    await sleep(1200);
    ok('nach dem Entfernen steht die Warnung wieder da', /unverschlüsselt/i.test(await listenText(page)), (await listenText(page)).slice(0, 90));
    ok('… und der Notfall-Entschlüsseler ist wieder verborgen',
      await page.evaluate(() => getComputedStyle(document.getElementById('empf-werkzeug')).display === 'none'));
    const d2 = await holen('/api/backup/download', admin);
    ok('… die Sicherung ist wieder ein Zip', d2.buf[0] === 0x50 && d2.buf[1] === 0x4b);

    console.log('\n── Ein abgelehnter Versuch meldet sich sauber ──');
    // „Name schon vergeben" ist ein ganz normaler Bedienweg. Er muss als Meldung ankommen — und
    // nicht als unbehandelte Ablehnung in der Konsole.
    const zweitPaar = krypto.paarErzeugen();
    await req('POST', '/api/backup/empfaenger', admin, { name: 'Belegt', pubkey: zweitPaar.oeffentlich });
    await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2000);
    await page.click('#empf-add'); await sleep(400);
    await page.evaluate(() => { document.getElementById('empf-name').value = 'Belegt'; });
    await page.evaluate(k => { document.getElementById('empf-key').value = k; }, krypto.paarErzeugen().oeffentlich);
    const fehlerVorher = jsFehler.length;
    await page.click('#empf-save'); await sleep(1500);
    ok('der Server lehnt ab und die Seite sagt es',
      /bereits|vergeben/i.test(await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).innerText || '')),
      await page.evaluate(() => (document.querySelector('.toast, #toast') || {}).innerText || '(kein Toast)'));
    ok('… ohne unbehandelte Ablehnung in der Konsole', jsFehler.length === fehlerVorher,
      jsFehler.slice(fehlerVorher).join(' | '));
    await page.click('#empf-cancel'); await sleep(400);

    console.log('\n── Der Chef sieht die Liste, kann sie aber nicht ändern ──');
    // Vorher wieder einen Empfaenger anlegen, sonst gaebe es nichts zu sehen und der Test waere
    // gruen, ohne etwas gezeigt zu haben.
    const chefPaar = krypto.paarErzeugen();
    await req('POST', '/api/backup/empfaenger', admin, { name: 'Chefin', pubkey: chefPaar.oeffentlich });
    await req('POST', '/api/users', admin, { username: 'daniel', password: 'Str3ng!Geheim', name: 'Daniel', role: 'chef', target_hours_per_week: 40 });
    // Eigener Browser-Kontext: Sonst liegt im selben localStorage noch die Anmeldung des Admins,
    // der Chef landet gar nicht auf dem Anmeldebildschirm — und der Test misst die falsche Rolle.
    const chefKontext = await browser.createBrowserContext();
    const chefSeite = await chefKontext.newPage();
    await chefSeite.setViewport({ width: 960, height: 1000 });
    chefSeite.setDefaultTimeout(30000);
    await chefSeite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await chefSeite.waitForSelector('#login-user');
    await chefSeite.type('#login-user', 'daniel'); await chefSeite.type('#login-pass', 'Str3ng!Geheim');
    await chefSeite.click('#login-form button[type="submit"]');
    await sleep(2500);
    await chefSeite.goto(BASIS + '/#/settings', { waitUntil: 'domcontentloaded' });
    await chefSeite.waitForSelector('#empf-liste'); await sleep(1500);
    const chefText = await chefSeite.evaluate(() => document.getElementById('empf-liste').innerText);
    ok('Chef sieht den Eintrag', /Chefin/.test(chefText), chefText.slice(0, 90));
    ok('… und den Fingerabdruck', /[0-9a-f]{4} [0-9a-f]{4}/.test(chefText));
    ok('… aber keinen Knopf zum Hinzufügen', await chefSeite.evaluate(() => !document.getElementById('empf-add')));
    ok('… kein Umbenennen, kein Entfernen',
      await chefSeite.evaluate(() => !document.querySelector('.empf-rename') && !document.querySelector('.empf-del')));
    ok('… „prüfen" darf er trotzdem', await chefSeite.evaluate(() => !!document.querySelector('.empf-pruefen')));
    ok('… und die Seite sagt ihm, warum', /nur ein Administrator/i.test(
      await chefSeite.evaluate(() => document.body.innerText)));
    await chefSeite.close(); await chefKontext.close();

    console.log('\n── Keine Fehler in der Browser-Konsole ──');
    ok('kein JavaScript-Fehler auf der Seite', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(800);
  }
  console.log(`\nEmpfaengerliste (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
