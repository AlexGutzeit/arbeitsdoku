// Das Geburtsdatums-FELD in Mitarbeiter → bearbeiten — über die echte Oberfläche bedient.
//
// Warum eigens: Alle anderen Geburtsdatums-Prüfungen setzen den Wert über die Schnittstelle. Damit
// bleibt genau der Weg ungeprüft, den der Chef tatsächlich geht — und der kann kaputt sein, ohne
// dass irgendein Test rot wird (Feld wird nicht mitgeschickt, steht beim erneuten Öffnen nicht drin,
// die Hinweiszeile sitzt am falschen Feld). Genau Letzteres war beim Schreiben dieses Tests der Fall.
//
//   node tests/geburtsdatum-feld-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3210, DB = '/tmp/geburtsdatum-feld.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Alle Datumsrechnungen hier laufen ueber die LOKALE Uhr, nicht ueber UTC. Der Server prueft
// Geburtsdaten gegen das Berliner Datum; zwischen Mitternacht und 02:00 Uhr sind das zwei
// verschiedene Tage, und der Test wuerde aus dem falschen Grund umfallen.
const lokal = d => d.toLocaleDateString('sv-SE');
const jahre = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return lokal(d); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/geburtsdatum-feld-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/geburtsdatum-feld-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const adminA = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    await req('PUT', '/api/settings', adminA.token, { break_minutes_default: 30 });
    const maxId = (await req('GET', '/api/users', adminA.token)).body.users.find(u => u.username === 'max').id;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    // Feste Uhrzeit: Der Test darf nicht davon abhängen, wann er läuft.
    await page.evaluateOnNewDocument(() => {
      const E = Date; const b = new E(); b.setHours(19, 0, 0, 0); const v = b.getTime() - E.now();
      function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
      G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
    });
    const anmelden = async (n, p) => {
      await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', n); await page.type('#login-pass', p);
      await page.click('#login-form button[type="submit"]');
      await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
    };
    const formularOeffnen = async () => {
      // Über den echten Knopf in der Liste, nicht über einen Funktionsaufruf — sonst prüfte der
      // Test einen Weg, den der Chef nie geht.
      await page.goto(BASIS + '/#/users', { waitUntil: 'networkidle0' }); await sleep(1000);
      await page.click(`.edit-user[data-id="${maxId}"]`);
      await page.waitForSelector('#um-birth-date'); await sleep(500);
    };
    const setzenUndSpeichern = async (wert) => {
      await page.evaluate(w => {
        const f = document.getElementById('um-birth-date');
        f.value = w; f.dispatchEvent(new Event('change', { bubbles: true }));
      }, wert);
      await page.evaluate(() => document.querySelector('#user-modal-form button[type="submit"]').click());
      await sleep(1200);
    };

    console.log('\n── Feld im Mitarbeiter-Formular ────────────────────────');
    await anmelden('chef', pw('chef'));
    await formularOeffnen();
    ok('Feld ist da und anfangs leer', (await page.$eval('#um-birth-date', e => e.value)) === '');

    // Die Hinweiszeile muss am RICHTIGEN Feld hängen. Genau hier saß ein Fehler: Der Satz zum
    // Arbeitsbeginn war beim Geburtsdatum gelandet.
    const hinweise = await page.evaluate(() => {
      const t = el => [...el.parentElement.querySelectorAll('.push-hint')].map(x => x.innerText).join(' | ');
      return { geburt: t(document.getElementById('um-birth-date')), beginn: t(document.getElementById('um-work-start')) };
    });
    ok('Hinweis am Geburtsdatum spricht vom Jugendschutz', /Jugendarbeitsschutzgesetz/.test(hinweise.geburt), hinweise.geburt);
    ok('… und NICHT vom Arbeitsbeginn', !/abweichend beginnt/.test(hinweise.geburt), hinweise.geburt);
    ok('Hinweis zum Arbeitsbeginn steht am Arbeitsbeginn', /abweichend beginnt/.test(hinweise.beginn), hinweise.beginn);

    const erwachsen = jahre(35);
    await setzenUndSpeichern(erwachsen);
    ok('Gespeichert (steht in der Datenbank)',
      (await req('GET', `/api/users/${maxId}`, adminA.token)).body.user.birth_date === erwachsen,
      JSON.stringify((await req('GET', `/api/users/${maxId}`, adminA.token)).body.user.birth_date));

    await formularOeffnen();
    ok('Beim erneuten Öffnen steht der Wert im Feld', (await page.$eval('#um-birth-date', e => e.value)) === erwachsen);

    const heute = lokal(new Date());
    ok('Zukünftige Daten sind schon im Feld gesperrt (max)', (await page.$eval('#um-birth-date', e => e.max)) === heute,
      await page.$eval('#um-birth-date', e => e.max));
    // Gegenprobe am Server: Die Sperre im Feld ist nur Komfort, entschieden wird hinten.
    const morgen = lokal(new Date(Date.now() + 864e5));
    const abgelehnt = await req('PUT', `/api/users/${maxId}`, adminA.token, { birth_date: morgen });
    ok('Der Server weist ein Datum in der Zukunft ab', abgelehnt.status === 400, abgelehnt.status + ' ' + abgelehnt.text);

    console.log('\n── Wirkung auf den Pausenvorschlag ─────────────────────');
    const vorschlag = async () => {
      await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(600);
      await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
      await page.waitForSelector('#ef-break'); await sleep(800);
      const tag = lokal(new Date(Date.now() - 864e5));
      await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, tag);
      await sleep(1200);
      await page.evaluate(() => {
        const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
        f.value = '07:00'; f.dispatchEvent(new Event('change', { bubbles: true }));
        t.value = '15:30'; t.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(1400);
      return page.evaluate(() => document.getElementById('ef-break').value);
    };
    await anmelden('max', pw('max'));
    ok('Erwachsener: 8:30 Anwesenheit → 30 min', (await vorschlag()) === '30');

    // Jetzt trägt der Chef ein Azubi-Datum ein — über das Formular, nicht über die Schnittstelle.
    await anmelden('chef', pw('chef'));
    await formularOeffnen();
    await setzenUndSpeichern(jahre(16));
    await anmelden('max', pw('max'));
    ok('Nach Umstellung auf 16 Jahre → 60 min', (await vorschlag()) === '60');

    // Und wieder leeren: „unbekannt" heißt weiterhin „unter 18", nicht „Erwachsener".
    await anmelden('chef', pw('chef'));
    await formularOeffnen();
    await setzenUndSpeichern('');
    ok('Leeren wird gespeichert (nicht stillschweigend ignoriert)',
      !(await req('GET', `/api/users/${maxId}`, adminA.token)).body.user.birth_date,
      JSON.stringify((await req('GET', `/api/users/${maxId}`, adminA.token)).body.user.birth_date));
    await anmelden('max', pw('max'));
    ok('Leeres Feld → weiterhin 60 min (Annahme „unter 18")', (await vorschlag()) === '60');

    console.log('\n── Protokoll ───────────────────────────────────────────');
    const audit = (await req('GET', '/api/audit?limit=200', adminA.token)).body;
    const eintraege = (audit.entries || audit.logs || []).filter(e => /Geburtsdatum/.test(JSON.stringify(e)));
    ok('Änderungen stehen im Protokoll', eintraege.length >= 2, 'gefunden: ' + eintraege.length);
    ok('… mit alt → neu im Klartext', eintraege.some(e => /Geburtsdatum: .* → .*/.test(JSON.stringify(e))),
      JSON.stringify(eintraege[0] || {}).slice(0, 300));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nGeburtsdatums-Feld: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
