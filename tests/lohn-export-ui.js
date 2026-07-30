// Puppeteer-Test (C1): Bedienung des Lohn-Exports.
//  - Karte auf der Export-Seite für Chef/Admin/Buchhalter sichtbar, für Mitarbeiter NICHT
//  - Monat ist auf den Vormonat voreingestellt
//  - Download liefert eine CSV mit erwarteter Kopfzeile
//  - Personalnummer im Mitarbeiter-Dialog speicherbar und taucht in der Datei auf
// Start: node tests/lohn-export-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3146, DB = '/tmp/lohnui.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

// Erwarteter Vormonat als JJJJ-MM
const jetzt = new Date();
const vm = new Date(jetzt.getFullYear(), jetzt.getMonth() - 1, 15);
const VORMONAT = `${vm.getFullYear()}-${String(vm.getMonth() + 1).padStart(2, '0')}`;

const anmelden = async (browser, user, pw) => {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1100, height: 900 });
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.waitForSelector('#login-user');
  await p.type('#login-user', user); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]');
  await p.waitForSelector('a[href="#/pdf"]', { timeout: 10000 });
  await sleep(500);
  return p;
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/lohnui-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/lohnui-srv.log', 'utf8');
    const pw = (rolle) => (log.match(new RegExp(rolle + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    await req('POST', '/api/users', admin, { username: 'lohnui_ma', password: 'Test1234!', name: 'Zed Mitarbeiter', role: 'mitarbeiter' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // ── Sichtbarkeit je Rolle ─────────────────────────────────────────────
    console.log('Sichtbarkeit:');
    for (const [rolle, user, passwort, sichtbar] of [
      ['Admin', 'admin', pw('admin'), true],
      ['Chef', 'chef', pw('chef'), true],
      ['Buchhalter', 'buchhalter', pw('buchhalter'), true],
      ['Mitarbeiter', 'lohnui_ma', 'Test1234!', false],
    ]) {
      const p = await anmelden(browser, user, passwort);
      await p.evaluate(() => { location.hash = '#/pdf'; });
      await sleep(2000);
      const da = await p.evaluate(() => !!document.getElementById('lohn-form'));
      ok(`${rolle}: Lohn-Export ${sichtbar ? 'sichtbar' : 'NICHT sichtbar'}`, da === sichtbar, 'Formular da=' + da);
      if (rolle === 'Mitarbeiter') {
        // Ausgeblendet ist nicht gesperrt — die Route muss selbst ablehnen
        const status = await p.evaluate(async (m) => {
          const r = await fetch('/api/payroll/monat.csv?month=' + m, { headers: { Authorization: 'Bearer ' + S.token } });
          return r.status;
        }, VORMONAT);
        ok('Mitarbeiter: Route lehnt trotzdem ab (403)', status === 403, String(status));
      }
      await p.browserContext().close();
    }

    // ── Bedienung als Chef ────────────────────────────────────────────────
    console.log('Bedienung:');
    const p = await anmelden(browser, 'chef', pw('chef'));

    // Der Menuepunkt heisst fuer Chef/Admin/Buchhalter „Abrechnung" — auf der Seite liegen PDF,
    // Lohn-Export UND der Abrechnungs-Abschluss. (Hiess bis 30.07.2026 „Export"; das beschrieb die
    // Technik statt des Zwecks. Die rollenabhaengige Beschriftung prueft tests/menue-abrechnung-ui.js.)
    const menuText = await p.evaluate(() => {
      const a2 = document.querySelector('nav a[href="#/pdf"]');
      return a2 ? a2.textContent.trim() : null;
    });
    // Das Symbol steht mit im Link — daher auf den Wortlaut pruefen, nicht auf Gleichheit.
    ok('Menüpunkt heißt für den Chef „Abrechnung"',
      /\bAbrechnung$/.test(menuText || '') && !/Export/.test(menuText || ''), JSON.stringify(menuText));

    await p.evaluate(() => { location.hash = '#/pdf'; }); await sleep(2000);
    ok('beide Karten sind auf der Seite', await p.evaluate(() => {
      const t = document.querySelector('.main').textContent;
      return /PDF-Export/.test(t) && /Lohn-Export/.test(t);
    }));
    ok('Monat ist auf den Vormonat voreingestellt',
      (await p.evaluate(() => document.getElementById('lohn-monat').value)) === VORMONAT,
      `erwartet ${VORMONAT}, ist ${await p.evaluate(() => document.getElementById('lohn-monat').value)}`);
    ok('PDF-Formular ist weiterhin da (zweite Karte, keine Verdrängung)',
      await p.evaluate(() => !!document.getElementById('pdf-form')));

    // Download über den echten Knopf auslösen und die Datei einsammeln
    const datei = await p.evaluate(async () => {
      // Den erzeugten Blob abfangen, statt eine Datei auf die Platte zu schreiben
      const echt = URL.createObjectURL;
      let inhalt = null;
      URL.createObjectURL = function (blob) { inhalt = blob; return echt.call(URL, blob); };
      document.getElementById('lohn-btn').click();
      for (let i = 0; i < 60 && !inhalt; i++) await new Promise(r => setTimeout(r, 100));
      URL.createObjectURL = echt;
      if (!inhalt) return null;
      // Rohbytes mitnehmen: blob.text() dekodiert als UTF-8 und ENTFERNT dabei das BOM —
      // am Text laesst sich also nicht pruefen, ob Excel die Umlaute richtig sieht.
      const bytes = new Uint8Array(await inhalt.arrayBuffer()).slice(0, 3);
      return { typ: inhalt.type, text: await inhalt.text(), ersteBytes: [...bytes] };
    });
    ok('Klick erzeugt eine Datei', !!datei, String(datei));
    if (datei) {
      ok('Datei ist eine CSV', /csv/.test(datei.typ), datei.typ);
      ok('Rohbytes beginnen mit UTF-8-BOM (EF BB BF)',
        JSON.stringify(datei.ersteBytes) === '[239,187,191]', JSON.stringify(datei.ersteBytes));
      ok('Kopfzeile enthält die erwarteten Spalten',
        /Personalnummer/.test(datei.text) && /Überstunden gesamt/.test(datei.text) && /Beschäftigt bis/.test(datei.text),
        datei.text.slice(0, 120));
      ok('Meldung „heruntergeladen" erscheint',
        /heruntergeladen/i.test(await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')));
    }

    // ── Personalnummer pflegen und wiederfinden ───────────────────────────
    console.log('Personalnummer:');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(2000);
    const geoeffnet = await p.evaluate(() => {
      const zeilen = [...document.querySelectorAll('#users-tbody tr')];
      const zeile = zeilen.find(z => /Zed Mitarbeiter/.test(z.textContent));
      if (!zeile) return 'keine Zeile';
      const btn = zeile.querySelector('.edit-user');
      if (!btn) return 'kein Knopf';
      btn.click();
      return 'ok';
    });
    ok('Mitarbeiter-Dialog geöffnet', geoeffnet === 'ok', String(geoeffnet));
    await sleep(900);
    ok('Feld „Personalnummer" ist im Dialog', await p.evaluate(() => !!document.getElementById('um-personnel-no')));
    await p.evaluate(() => {
      const el = document.getElementById('um-personnel-no');
      el.value = '0815';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('user-modal-form').requestSubmit();
    });
    await sleep(2000);
    const gespeichert = (await req('GET', '/api/users', admin)).body.users.find(u => u.name === 'Zed Mitarbeiter');
    ok('Personalnummer gespeichert', gespeichert && gespeichert.personnel_no === '0815', JSON.stringify(gespeichert && gespeichert.personnel_no));

    // WICHTIG: den LAUFENDEN Monat abfragen. Im Vormonat war der eben angelegte Mitarbeiter noch
    // gar nicht angestellt — dass er dort fehlt, ist richtig und wird gleich mitgeprueft.
    const dieserMonat = `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`;
    const csv = await req('GET', `/api/payroll/monat.csv?month=${dieserMonat}`, admin);
    ok('Personalnummer steht in der CSV', /"0815";"Zed Mitarbeiter"/.test(csv.text),
      (csv.text.split('\r\n').find(z => /Zed/.test(z)) || 'keine Zeile gefunden').slice(0, 70));
    const csvVormonat = await req('GET', `/api/payroll/monat.csv?month=${VORMONAT}`, admin);
    ok('im Vormonat fehlt er zu Recht (damals nicht angestellt)', !/Zed Mitarbeiter/.test(csvVormonat.text));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLohn-Export Bedienung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
