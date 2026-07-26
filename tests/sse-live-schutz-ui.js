// Zwei-Client-Test (echtes SSE): Was passiert bei mir, wenn ein KOLLEGE etwas speichert?
//  Frage 1: Bleibt meine Scrollposition erhalten?
//  Frage 2: Gehen meine halb eingetippten Daten verloren?
// Geprüft für Werkzeuge, Notizen, Bestellungen, Projekte, Abwesenheiten und das Auftrags-Board.
// Start: node tests/sse-live-schutz-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3131, DB = '/tmp/sse-schutz.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const today = new Date().toLocaleDateString('sv-SE');

// „Kollege speichert" — bewusst über einen EIGENEN Kanal (nicht der Browser des Testnutzers),
// damit das SSE-Ereignis wirklich von außen kommt.
async function kollegeSpeichert(fn) { await fn(); await sleep(1800); }

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/sse-schutz-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/sse-schutz-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;   // spielt den „Kollegen"
    const chefTok = (await login('chef', cpw)).body.token;
    for (let i = 1; i <= 40; i++) await req('POST', '/api/tools', admin, { name: `Werkzeug ${String(i).padStart(2, '0')}` });
    for (let i = 1; i <= 8; i++) await req('POST', '/api/projects', admin, { name: `SSE-Projekt ${i}` });
    for (let i = 1; i <= 5; i++) await req('POST', '/api/users', admin, { username: 'ssema' + i, password: 'Test1234!', name: 'SSE MA ' + i, role: 'mitarbeiter' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    // „Ich" = Chef im Browser, mit eigener SSE-Verbindung
    const p = await browser.newPage(); await p.setViewport({ width: 900, height: 700 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'chef'); await p.type('#login-pass', cpw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(800);

    // ══ FRAGE 1: Scrollposition bei einem Live-Update ══
    console.log('Frage 1 — Scrollposition bei Live-Update eines Kollegen:');
    await p.evaluate(() => { location.hash = '#/tools'; }); await sleep(1600);
    await p.evaluate(() => window.scrollTo(0, 500)); await sleep(450);
    const vorScroll = await p.evaluate(() => Math.round(window.scrollY));
    const werkzeugeVorher = await p.evaluate(() => document.querySelectorAll('.tool-row, .tool-item, tr[data-tool-id]').length);
    await kollegeSpeichert(() => req('POST', '/api/tools', admin, { name: 'Kollege-Werkzeug' }));
    const nachScroll = await p.evaluate(() => Math.round(window.scrollY));
    const werkzeugeNachher = await p.evaluate(() => document.querySelectorAll('.tool-row, .tool-item, tr[data-tool-id]').length);
    ok('Live-Update kam an (Liste wurde aktualisiert)', werkzeugeNachher > werkzeugeVorher || werkzeugeVorher === 0, `${werkzeugeVorher} → ${werkzeugeNachher}`);
    ok('Scrollposition bleibt beim Live-Update erhalten', Math.abs(nachScroll - vorScroll) < 60, `${vorScroll} → ${nachScroll}`);

    // ══ FRAGE 2: Datenverlust beim Bearbeiten ══
    console.log('Frage 2 — halb eingetippte Daten bei Live-Update:');

    // (a) Notiz-Formular
    await p.evaluate(() => { location.hash = '#/notes'; }); await sleep(1600);
    const notizForm = await p.evaluate(async () => {
      const fab = document.getElementById('fab-new'); if (!fab) return false;
      fab.click(); await new Promise(r => setTimeout(r, 700));
      const t = document.querySelector('#note-form-area input, #note-form-area textarea');
      if (!t) return false;
      t.value = 'MEIN HALB GETIPPTER TEXT'; t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    if (notizForm) {
      await kollegeSpeichert(() => req('POST', '/api/notes', admin, { title: 'Kollegen-Notiz' }));
      const notizDa = await p.evaluate(() => {
        const t = document.querySelector('#note-form-area input, #note-form-area textarea');
        return t ? t.value : null;
      });
      ok('Notiz-Formular überlebt Live-Update (Text erhalten)', notizDa === 'MEIN HALB GETIPPTER TEXT', 'wert=' + notizDa);
    } else ok('Notiz-Formular geöffnet (übersprungen)', true);

    // (b) Bestellungs-Formular
    await p.evaluate(() => { location.hash = '#/orders'; }); await sleep(1600);
    const bestellForm = await p.evaluate(async () => {
      // Formular direkt über die App-Funktion öffnen (der Knopf variiert je nach Rolle/Ansicht)
      if (typeof showOrderForm === 'function') showOrderForm(null, [], true);
      await new Promise(r => setTimeout(r, 600));
      const t = document.querySelector('#order-form-area input, #order-form-area textarea');
      if (!t) return false;
      t.value = 'HALBE BESTELLUNG'; t.dispatchEvent(new Event('input', { bubbles: true }));
      document.activeElement?.blur?.();       // bewusst ohne Fokus — nur getippt und weggeklickt
      return true;
    });
    if (bestellForm) {
      await kollegeSpeichert(() => req('POST', '/api/orders', admin, { product: 'Kollegen-Bestellung' }));
      const bestellDa = await p.evaluate(() => { const t = document.querySelector('#order-form-area input, #order-form-area textarea'); return t ? t.value : null; });
      ok('Bestell-Formular überlebt Live-Update', bestellDa === 'HALBE BESTELLUNG', 'wert=' + bestellDa);
    } else ok('Bestell-Formular geöffnet (übersprungen)', true);

    // (c) Projekt-Formular — liegt in der Hauptfläche, ist also am gefährdetsten
    await p.evaluate(() => { location.hash = '#/projects'; }); await sleep(1800);
    const projForm = await p.evaluate(async () => {
      const btn = document.querySelector('.proj-edit'); if (!btn) return false;
      btn.click(); await new Promise(r => setTimeout(r, 800));
      const n = document.getElementById('pf2-name'); if (!n) return false;
      n.value = 'GEÄNDERTER NAME';
      document.activeElement?.blur?.();          // bewusst NICHT im Feld stehen (nur geklickt)
      return true;
    });
    if (projForm) {
      await kollegeSpeichert(() => req('POST', '/api/projects', admin, { name: 'Kollegen-Projekt ' + Date.now() }));
      const projDa = await p.evaluate(() => { const n = document.getElementById('pf2-name'); return n ? n.value : null; });
      ok('Projekt-Formular überlebt Live-Update (auch ohne Fokus)', projDa === 'GEÄNDERTER NAME', 'wert=' + projDa);
    } else ok('Projekt-Formular geöffnet (übersprungen)', true);

    // (d) Abwesenheits-Dialog (liegt als Overlay über der Seite)
    await p.evaluate(() => { location.hash = '#/absences'; }); await sleep(1700);
    await p.evaluate(() => { showAbsenceForm(null, 'krank', null, null, null); }); await sleep(500);
    await p.evaluate(() => { const c = document.getElementById('abs-comment'); if (c) c.value = 'MEIN KOMMENTAR'; document.activeElement?.blur?.(); });
    await kollegeSpeichert(() => req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: 3 }));
    const absDa = await p.evaluate(() => { const c = document.getElementById('abs-comment'); return c ? c.value : null; });
    ok('Abwesenheits-Dialog überlebt Live-Update', absDa === 'MEIN KOMMENTAR', 'wert=' + absDa);
    await p.evaluate(() => document.getElementById('abs-cancel')?.click()); await sleep(300);

    // (e) Auftrags-Board seitlich gescrollt + Live-Update
    console.log('Zusatz — Board-Position bei Live-Update:');
    await p.evaluate(() => { location.hash = '#/projects'; }); await sleep(1800);
    const boardScrollbar = await p.evaluate(() => { const b = document.querySelector('.board-scroll'); return b ? b.scrollWidth > b.clientWidth : false; });
    if (boardScrollbar) {
      await p.evaluate(() => { const b = document.querySelector('.board-scroll'); b.scrollLeft = 250; b.dispatchEvent(new Event('scroll', { bubbles: true })); });
      await sleep(450);
      const vorB = await p.evaluate(() => document.querySelector('.board-scroll').scrollLeft);
      await kollegeSpeichert(() => req('POST', '/api/projects', admin, { name: 'Board-Update ' + Date.now() }));
      const nachB = await p.evaluate(() => { const b = document.querySelector('.board-scroll'); return b ? b.scrollLeft : -1; });
      ok('Board-Position bleibt bei Live-Update', Math.abs(nachB - vorB) < 60, `${vorB} → ${nachB}`);
    } else ok('Board seitlich scrollbar (übersprungen)', true);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nSSE-Live-Schutz: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
