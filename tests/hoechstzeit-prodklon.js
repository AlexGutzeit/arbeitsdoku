// Die Höchstarbeitszeit-Warnung an ECHTEN Daten: warnt sie nur — oder verändert sie etwas?
//
// Alex' Bedingung: „nur Warnung, keine Blockade, keine Beeinflussung irgendeiner Berechnung."
// Das wird hier gemessen, nicht behauptet:
//
//   1. ALLE Zahlen aller Mitarbeiter aufnehmen (Statistik in mehreren Zeiträumen, Überstundenstand).
//   2. Im Browser das Formular öffnen und die Warnung auslösen — ohne zu speichern.
//   3. Alle Zahlen erneut aufnehmen: keine einzige darf sich bewegt haben.
//   4. Den überlangen Eintrag dann WIRKLICH speichern → er muss durchgehen (keine Blockade) und mit
//      exakt den eingegebenen Zeiten in der Datenbank stehen.
//   5. Ihn wieder löschen → alle Zahlen müssen auf ihren Ausgangswert zurückfallen. Damit ist
//      belegt, dass die einzige Veränderung der Eintrag selbst war.
//
// Der Test prüft zuerst, dass er überhaupt etwas gemessen hat. Nur lesend gegenüber der Quelle.
//   node tests/hoechstzeit-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3217, DB = '/tmp/hoechstzeit-klon.db', BASIS = `http://localhost:${PORT}`;
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function ruf(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Alle Zahlen einer Antwort mit ihrem Pfad — damit ein Unterschied benennbar ist.
function zahlen(o, pfad, raus) {
  if (o === null || o === undefined) return raus;
  if (typeof o === 'number') { raus.push(pfad + '=' + o); return raus; }
  if (Array.isArray(o)) { o.forEach((v, i) => zahlen(v, `${pfad}[${i}]`, raus)); return raus; }
  if (typeof o === 'object') { for (const k of Object.keys(o).sort()) zahlen(o[k], `${pfad}.${k}`, raus); return raus; }
  return raus;
}
const plusTage = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test übersprungen.'); process.exit(0); }
  const pruefsumme = crypto.createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');
  fs.copyFileSync(QUELLE, DB);

  const SQL = await initSqlJs();
  const d0 = new SQL.Database(fs.readFileSync(DB));
  if (!d0.exec('PRAGMA table_info(users)')[0].values.some(v => v[1] === 'birth_date')) {
    console.log('Klon kennt birth_date noch nicht — Test übersprungen.'); d0.close(); process.exit(0);
  }
  const alle = d0.exec("SELECT id, name, role FROM users WHERE COALESCE(active,1)=1")[0].values;
  const jugend = d0.exec("SELECT id, name, birth_date FROM users WHERE birth_date IS NOT NULL AND birth_date != '' AND COALESCE(active,1)=1 ORDER BY birth_date DESC LIMIT 1")[0];
  d0.close();
  if (!jugend) { console.log('Niemand mit Geburtsdatum — Test übersprungen.'); process.exit(0); }
  const [uid, uname, geburt] = jugend.values[0];
  console.log(`Klon: ${alle.length} aktive Nutzer · Prüfling ${uname} (*${geburt})\n`);

  const lg = fs.openSync('/tmp/hoechstzeit-klon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await ruf('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    const adminZeile = alle.find(u => u[2] === 'admin');
    const adminT = jwt.sign({ userId: adminZeile[0], role: 'admin' }, SECRET, { expiresIn: '2h' });
    const maT = jwt.sign({ userId: uid, role: 'mitarbeiter' }, SECRET, { expiresIn: '2h' });
    const me = await ruf('GET', '/api/auth/me', maT);
    ok('Anmeldung am Klon möglich', me.status === 200, String(me.status));

    // Ein freier Tag: weit genug zurueck, damit dort nichts liegt.
    const heute = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
    let tag = null;
    for (let i = 3; i < 40 && !tag; i++) {
      const kandidat = plusTage(heute, -i);
      const wt = new Date(kandidat + 'T12:00:00Z').getUTCDay();
      if (wt === 0 || wt === 6) continue;                       // Wochenende meiden
      const r = await ruf('GET', `/api/entries?date_from=${kandidat}&date_to=${kandidat}`, maT);
      if (((r.body && r.body.entries) || []).length === 0) tag = kandidat;
    }
    ok('freier Werktag für die Probe gefunden', !!tag, String(tag));

    // ── 1. Alle Zahlen aufnehmen ──────────────────────────────────────────────────────────
    const jahr = Number(heute.slice(0, 4));
    async function alleZahlen() {
      const raus = [];
      for (const [id, , rolle] of alle) {
        const t = jwt.sign({ userId: id, role: rolle }, SECRET, { expiresIn: '2h' });
        const pfade = ['/api/statistics/overtime',
          `/api/statistics?period=month&date=${heute}`,
          `/api/statistics?period=year&date=${heute}`,
          `/api/statistics?period=year&date=${jahr - 1}-06-15`,
          `/api/entries?date_from=${jahr}-01-01&date_to=${jahr}-12-31`];
        for (const p of pfade) {
          const r = await ruf('GET', p, t);
          zahlen(r.body, `u${id}${p}`, raus);
        }
      }
      return raus;
    }
    const vorher = await alleZahlen();
    ok(`etwas gemessen (${vorher.length} Einzelwerte)`, vorher.length > 500, String(vorher.length));

    // ── 2. Warnung im Browser ausloesen, NICHT speichern ──────────────────────────────────
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
    page.setDefaultTimeout(45000);
    await page.evaluateOnNewDocument((tk, usr) => {
      localStorage.setItem('token', tk); localStorage.setItem('user', usr);
      const E = Date; const b = new E(); b.setHours(19, 0, 0, 0); const v = b.getTime() - E.now();
      function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
      G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
    }, maT, JSON.stringify(me.body.user));
    // networkidle0 taugt hier nicht: angemeldet gestartet haelt der SSE-Kanal die Verbindung offen.
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(800);
    await page.goto(BASIS + '/#/entry/new', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ef-break'); await sleep(900);
    await page.evaluate(t => { const e = document.getElementById('ef-date'); e.value = t; e.dispatchEvent(new Event('change', { bubbles: true })); }, tag);
    await sleep(1200);
    await page.evaluate(() => {
      const f = document.getElementById('ef-from'), t = document.getElementById('ef-to'), br = document.getElementById('ef-break');
      f.value = '06:00'; f.dispatchEvent(new Event('change', { bubbles: true }));
      t.value = '18:00'; t.dispatchEvent(new Event('change', { bubbles: true }));
      br.value = '60'; br.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(1800);
    const warntext = await page.evaluate(() => {
      const el = document.getElementById('ef-zeit-warnung');
      return el && el.checkVisibility && el.checkVisibility() ? el.innerText : '';
    });
    ok('Warnung erscheint an echten Daten (11 Std)', /11 Std/.test(warntext), `„${warntext}"`);

    // ── 3. Ohne Speichern: nichts darf sich bewegt haben ──────────────────────────────────
    const nachAnsehen = await alleZahlen();
    const unterschiedeAnsehen = vorher.filter((v, i) => v !== nachAnsehen[i]);
    ok('nach dem blossen Ansehen: keine Zahl verändert',
      vorher.length === nachAnsehen.length && unterschiedeAnsehen.length === 0,
      unterschiedeAnsehen.slice(0, 3).join(' | '));

    // ── 4. Jetzt wirklich speichern: keine Blockade ───────────────────────────────────────
    await page.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await sleep(2500);
    const amTag = (await ruf('GET', `/api/entries?date_from=${tag}&date_to=${tag}`, maT)).body.entries || [];
    const neuer = amTag.find(e => e.time_from === '06:00' && e.time_to === '18:00');
    ok('der überlange Eintrag wurde gespeichert (keine Blockade)', !!neuer, JSON.stringify(amTag.map(e => e.time_from + '-' + e.time_to)));
    ok('… mit exakt den eingegebenen Werten', neuer && Number(neuer.break_minutes) === 60, JSON.stringify(neuer && neuer.break_minutes));
    ok('… und mit der richtigen Netto-Zeit (11,0 h)', neuer && Number(neuer.net_hours) === 11, JSON.stringify(neuer && neuer.net_hours));

    // Selbstkontrolle: Der Vergleich muss eine echte Veraenderung auch SEHEN. Jetzt, mit dem
    // gespeicherten Eintrag, MUESSEN sich Zahlen bewegt haben — sonst waere das „keine Zahl
    // veraendert" von eben wertlos gewesen.
    const nachSpeichern = await alleZahlen();
    const bewegt = vorher.filter((v, i) => v !== nachSpeichern[i]);
    ok(`Gegenprobe: der gespeicherte Eintrag bewegt Zahlen (${bewegt.length})`, bewegt.length > 0,
      'der Vergleich ist blind');

    // ── 5. Wieder loeschen: alles faellt auf den Ausgangswert zurueck ─────────────────────
    const weg = await ruf('DELETE', `/api/entries/${neuer.id}`, adminT, { reason: 'Probe der Höchstzeit-Warnung' });
    ok('Probe-Eintrag wieder entfernt', weg.status === 200, weg.status + ' ' + weg.text.slice(0, 120));
    const nachher = await alleZahlen();
    const unterschiede = vorher.filter((v, i) => v !== nachher[i]);
    ok('nach dem Löschen: alle Zahlen wieder wie am Anfang',
      vorher.length === nachher.length && unterschiede.length === 0,
      unterschiede.slice(0, 3).join(' | '));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(1000);
  }

  ok('Ausgangskopie unberührt',
    crypto.createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex') === pruefsumme);
  try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nHöchstzeit am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
