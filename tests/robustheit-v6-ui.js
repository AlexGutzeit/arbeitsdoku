// Test der Robustheits-Runde (letzte offene Punkte der Bugliste v6):
//  R1 Restore eines alten Backups: users-Spalten werden im Restore-Pfad nachgezogen (kein Total-Ausfall).
//  R2 Verspätete Antwort überschreibt NICHT die inzwischen geöffnete Seite (renderToken).
//  R3 Ladefehler zeigt Meldung + „Erneut versuchen" statt endlosem Spinner.
//  R4 Abwesenheit für ungültigen Mitarbeiter → 400.
//  R5 Kaputter localStorage legt die App nicht lahm.
//  R6 Gruppenplanung behält den ursprünglichen Ersteller.
//  R7 Service Worker lädt beim ERSTEN Besuch nicht neu.
// Start: node tests/robustheit-v6-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3128, DB = '/tmp/robust-v6.db', BASE = 'http://localhost:' + PORT;
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

(async () => {
  // ── R1: Restore-Pfad ohne Server (direkt auf der DB-Schicht) ──
  console.log('R1 — Restore eines alten Backups:');
  {
    const stamp = Date.now();
    const initDb = '/tmp/robust-init-' + stamp + '.db';   // normale DB, damit die Schicht initialisiert ist
    const tmpDb = '/tmp/robust-old-' + stamp + '.db';     // das „alte" Backup, das restauriert wird
    process.env.DB_PATH = initDb;
    process.env.JWT_SECRET = 'x'.repeat(40);
    const dbmodInit = require('../database/init');
    await dbmodInit.initDatabase();                       // setzt die sql.js-Engine auf
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    // „Altes" Backup nachbauen: users OHNE start_overtime/active/target_hours_per_week
    const old = new SQL.Database();
    old.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, name TEXT, role TEXT);
             INSERT INTO users (username,password_hash,name,role) VALUES ('admin','x','Admin','admin');
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
    fs.writeFileSync(tmpDb, Buffer.from(old.export()));
    old.close();

    const dbmod = require('../database/init');
    dbmod.reloadFromFile(tmpDb);                       // genau der Pfad, den ein Restore nimmt
    const db = dbmod.getDb();
    const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    for (const c of ['start_overtime', 'active', 'target_hours_per_week', 'can_plan', 'can_plan_all']) {
      ok(`Spalte ${c} nach Restore vorhanden`, cols.includes(c), 'cols=' + cols.join(','));
    }
    // Genau die Abfrage der Anmelde-Prüfung muss laufen
    let authOk = true, authErr = '';
    try {
      db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, COALESCE(active,1) AS active FROM users WHERE id = ?').get(1);
    } catch (e) { authOk = false; authErr = e.message; }
    ok('Anmelde-Abfrage läuft nach Restore', authOk, authErr);
    try { fs.unlinkSync(tmpDb); fs.unlinkSync(initDb); } catch (_) {}
  }

  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/robust-v6-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/robust-v6-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'robma', password: 'Test1234!', name: 'Rob MA', role: 'mitarbeiter' })).body.user;

    // ── R4: Abwesenheit für ungültigen MA ──
    console.log('R4 — Abwesenheit für ungültigen Mitarbeiter:');
    let r = await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: 999999 });
    ok('nicht existierender Mitarbeiter → 400', r.status === 400, 'status=' + r.status);
    r = await req('POST', '/api/absences', admin, { type: 'krank', date_from: today, date_to: today, target_user_id: ma.id });
    ok('gültiger Mitarbeiter → weiterhin möglich', r.status === 201 || r.status === 200, 'status=' + r.status);

    // ── R6: Gruppenplanung behält Ersteller ──
    console.log('R6 — Ersteller einer Gruppenplanung:');
    const chefPw = (fs.readFileSync('/tmp/robust-v6-srv.log', 'utf8').match(/chef\s+->\s+(\S+)/) || [])[1];
    const chefTok = (await login('chef', chefPw)).body.token;
    const chefId = (await login('chef', chefPw)).body.user.id;
    const grp = await req('POST', '/api/planning', chefTok, { days: [{ date: '2027-11-01', time_from: '07:00', time_to: '12:00' }, { date: '2027-11-02', time_from: '07:00', time_to: '12:00' }], assigned_user_ids: [ma.id] });
    const gid = grp.body.group_id;
    await req('PUT', '/api/planning/group/' + gid, admin, { days: [{ date: '2027-11-01', time_from: '08:00', time_to: '12:00' }, { date: '2027-11-02', time_from: '08:00', time_to: '12:00' }], assigned_user_ids: [ma.id] });
    const after = (await req('GET', '/api/planning?date_from=2027-11-01&date_to=2027-11-02', admin)).body.entries || [];
    ok('nach Admin-Änderung bleibt der Chef Ersteller', after.length > 0 && after.every(e => e.created_by === chefId), JSON.stringify(after.map(e => e.created_by)));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 900 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ── R2: Render-Marke verwirft verspätete Antworten ──
    console.log('R2 — verspätete Antwort überschreibt nicht:');
    const r2 = await p.evaluate(() => {
      const alt = renderToken();      // „alter" Render startet
      renderToken();                  // ein neuerer Render beginnt danach
      return { altVeraltet: renderStale(alt), neuAktuell: !renderStale(_renderSeq) };
    });
    ok('alte Render-Marke gilt als veraltet', r2.altVeraltet === true);
    ok('neueste Marke ist aktuell', r2.neuAktuell === true);

    // ── R3: Ladefehler zeigt Retry ──
    console.log('R3 — Ladefehler mit „Erneut versuchen":');
    const r3 = await p.evaluate(async () => {
      const box = document.createElement('div'); box.id = 'r3box'; document.body.appendChild(box);
      let calls = 0;
      renderLoadError('#r3box', 'Keine Verbindung', () => { calls++; });
      const hatText = /nicht geladen/i.test(box.innerText);
      const btn = box.querySelector('button');
      btn.click();
      const res = { hatText, hatButton: !!btn, retryGerufen: calls === 1, spinner: !!box.querySelector('.spinner') };
      box.remove(); return res;
    });
    ok('Fehlermeldung sichtbar', r3.hatText);
    ok('„Erneut versuchen"-Knopf vorhanden', r3.hatButton);
    ok('Knopf löst erneuten Versuch aus', r3.retryGerufen);
    ok('kein Spinner mehr', r3.spinner === false);

    // ── R5: kaputter localStorage ──
    console.log('R5 — beschädigter Browser-Speicher:');
    const r5 = await p.evaluate(() => {
      localStorage.setItem('user', '{kaputt');   // ungültiges JSON
      let crashed = false, result = null;
      try { result = _readStoredUser(); } catch (_) { crashed = true; }
      return { crashed, result, aufgeraeumt: localStorage.getItem('user') === null };
    });
    ok('kein Absturz beim Lesen', r5.crashed === false);
    ok('liefert null statt Fehler', r5.result === null);
    ok('kaputter Eintrag wird aufgeräumt', r5.aufgeraeumt);

    // ── R7: Service Worker lädt beim ersten Besuch nicht neu ──
    console.log('R7 — Service Worker beim ersten Besuch:');
    const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const fresh = await ctx.newPage();
    await fresh.goto(BASE, { waitUntil: 'networkidle2' });
    // Marke setzen + etwas ins Login-Feld tippen: Beides überlebt einen Reload NICHT.
    await fresh.evaluate(() => { window.__ueberlebt = true; });
    await fresh.type('#login-user', 'tippt.gerade');
    await sleep(3000);                                  // SW installiert sich + clients.claim()
    const r7 = await fresh.evaluate(() => ({
      swAktiv: !!navigator.serviceWorker.controller,
      marke: window.__ueberlebt === true,
      eingabe: document.getElementById('login-user')?.value || '',
    }));
    ok('Service Worker hat übernommen', r7.swAktiv);
    ok('kein Reload beim ersten Besuch (Seite blieb bestehen)', r7.marke === true);
    ok('getippte Anmeldung ging nicht verloren', r7.eingabe === 'tippt.gerade', 'eingabe=' + r7.eingabe);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nRobustheit-v6: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
