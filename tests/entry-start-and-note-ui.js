// Puppeteer-Test:
//  Startzeit-Vorschlag: erster Eintrag des Tages 07:00, jeder weitere schliesst an den letzten an;
//                       Datumswechsel im Formular zieht den Vorschlag nach; manuelle Eingabe bleibt stehen.
//  A16: Chef/Buchhalter loeschen beim Bearbeiten NICHT die private Notiz des Mitarbeiters.
// Start: node tests/entry-start-and-note-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3126, DB = '/tmp/entry-start-note.db', BASE = 'http://localhost:' + PORT;
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
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/entry-start-note-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const log = fs.readFileSync('/tmp/entry-start-note-srv.log', 'utf8');
    const apw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const cpw = (log.match(/chef\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;
    const ma = (await req('POST', '/api/users', admin, { username: 'startma', password: 'Test1234!', name: 'Start MA', role: 'mitarbeiter' })).body.user;
    const maTok = (await login('startma', 'Test1234!')).body.token;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width: 1200, height: 950 });
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user', 'startma'); await p.type('#login-pass', 'Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // ── 1) Erster Eintrag des Tages → 07:00 ──
    console.log('Startzeit-Vorschlag:');
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1400);
    await p.waitForSelector('#ef-from');
    let von = await p.evaluate(() => document.getElementById('ef-from').value);
    ok('ohne Einträge am Tag → 07:00', von === '07:00', 'von=' + von);

    // Eintrag 07:00–12:00 anlegen (per API, damit der Test unabhängig vom Formular bleibt)
    await req('POST', '/api/entries', maTok, { date: today, time_from: '07:00', time_to: '12:00', project_text: 'Müller' });

    // ── 2) Zweiter Eintrag → schliesst an (12:00) ──
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(700);
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1400);
    von = await p.evaluate(() => document.getElementById('ef-from').value);
    ok('nach Eintrag 07:00–12:00 → Vorschlag 12:00', von === '12:00', 'von=' + von);

    // ── 3) Datum auf morgen → wieder 07:00 (dort noch nichts gebucht) ──
    await p.evaluate((d) => { const el = document.getElementById('ef-date'); el.value = d; el.dispatchEvent(new Event('change', { bubbles: true })); }, tomorrow);
    await sleep(900);
    von = await p.evaluate(() => document.getElementById('ef-from').value);
    ok('Datum morgen → wieder 07:00', von === '07:00', 'von=' + von);

    // ── 4) Manuell gesetzte Zeit wird NICHT überschrieben ──
    await p.evaluate(() => { const el = document.getElementById('ef-from'); el.value = '09:15'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await p.evaluate((d) => { const el = document.getElementById('ef-date'); el.value = d; el.dispatchEvent(new Event('change', { bubbles: true })); }, today);
    await sleep(900);
    von = await p.evaluate(() => document.getElementById('ef-from').value);
    ok('manuelle Eingabe bleibt bei Datumswechsel stehen', von === '09:15', 'von=' + von);

    // ── 4b) Realität schlägt Planung. Eigener MA ohne Einträge, denn „Planung übernehmen" bucht IMMER
    // auf heute — der MA oben hat heute schon gebucht.
    console.log('Planung vs. Realität:');
    const pma = (await req('POST', '/api/users', admin, { username: 'planma', password: 'Test1234!', name: 'Plan MA', role: 'mitarbeiter' })).body.user;
    const pmaTok = (await login('planma', 'Test1234!')).body.token;
    const plan = await req('POST', '/api/planning', admin, { date: today, time_from: '10:00', time_to: '12:00', assigned_user_ids: [pma.id], client: 'Geplant' });
    const planId = plan.body && plan.body.entry && plan.body.entry.id;
    ok('Planung 10:00–12:00 angelegt', !!planId, JSON.stringify(plan.body).slice(0, 80));

    const ctxP = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const pp = await ctxP.newPage(); await pp.setViewport({ width: 1200, height: 950 });
    await pp.goto(BASE, { waitUntil: 'networkidle2' });
    await pp.waitForSelector('#login-user'); await pp.type('#login-user', 'planma'); await pp.type('#login-pass', 'Test1234!');
    await pp.click('#login-form button[type="submit"]'); await pp.waitForSelector('a[href="#/planning"]'); await sleep(400);

    // Noch nichts gebucht → geplante Startzeit 10:00
    await pp.evaluate((id) => { location.hash = '#/planning/accept/' + id; }, planId); await sleep(1700);
    await pp.waitForSelector('#ef-from');
    let vonP = await pp.evaluate(() => document.getElementById('ef-from').value);
    ok('erster Auftrag des Tages → geplante Zeit 10:00', vonP === '10:00', 'von=' + vonP);

    // Vorgänger endete real erst 11:00 → Vorschlag 11:00 (NICHT die geplanten 10:00 → keine Überlappung)
    await req('POST', '/api/entries', pmaTok, { date: today, time_from: '07:00', time_to: '11:00', project_text: 'Vorgänger' });
    await pp.evaluate(() => { location.hash = '#/'; }); await sleep(800);
    await pp.evaluate((id) => { location.hash = '#/planning/accept/' + id; }, planId); await sleep(1700);
    vonP = await pp.evaluate(() => document.getElementById('ef-from').value);
    ok('Vorgänger endete 11:00 → 11:00 statt geplanter 10:00', vonP === '11:00', 'von=' + vonP);

    // ── 5) A16: Chef bearbeitet EIGENEN Eintrag mit privater Notiz → Notiz bleibt erhalten.
    // (Fremde Einträge darf ohnehin nur der Admin bearbeiten, und der sieht das Notizfeld. Betroffen ist
    // also der Fall „Chef/Buchhalter bearbeitet einen eigenen Eintrag, an dem eine Notiz hängt".)
    console.log('A16 — private Notiz:');
    const chefTok = (await login('chef', cpw)).body.token;
    const e = (await req('POST', '/api/entries', chefTok, { date: today, time_from: '13:00', time_to: '16:00', project_text: 'Schmidt', personal_note: 'GEHEIME NOTIZ' })).body.entry;
    ok('Eintrag des Chefs mit Notiz angelegt', !!e && e.personal_note === 'GEHEIME NOTIZ', JSON.stringify(e && e.personal_note));
    // Eigener Browser-Kontext: sonst teilt sich die zweite Seite die Anmeldung des MA (gleicher localStorage).
    const ctx2 = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const p2 = await ctx2.newPage(); await p2.setViewport({ width: 1200, height: 950 });
    await p2.goto(BASE, { waitUntil: 'networkidle2' });
    await p2.waitForSelector('#login-user'); await p2.type('#login-user', 'chef'); await p2.type('#login-pass', cpw);
    await p2.click('#login-form button[type="submit"]'); await p2.waitForSelector('a[href="#/planning"]'); await sleep(400);
    await p2.evaluate((id) => { location.hash = '#/entry/' + id; }, e.id); await sleep(1500);
    await p2.waitForSelector('#ef-desc');
    const noteFieldVisible = await p2.evaluate(() => !!document.getElementById('ef-note'));
    ok('Chef sieht das Notizfeld nicht', noteFieldVisible === false);
    await p2.evaluate(() => { const d = document.getElementById('ef-desc'); d.value = 'vom Chef ergänzt'; });
    await p2.evaluate(() => document.getElementById('entry-form').requestSubmit());
    await sleep(600);
    // GoBD: Beim Ändern erscheint eine (optionale) Begründungs-Abfrage — bestätigen.
    await p2.evaluate(() => {
      const btn = [...document.querySelectorAll('.dialog-modal button')].find(b => /^OK$/i.test(b.textContent.trim()));
      if (btn) btn.click();
    });
    await sleep(1400);
    const after = (await req('GET', '/api/entries/' + e.id, chefTok)).body.entry;
    ok('Beschreibung wurde übernommen', after && after.description === 'vom Chef ergänzt', JSON.stringify(after && after.description));
    ok('private Notiz ist NICHT gelöscht', after && after.personal_note === 'GEHEIME NOTIZ', JSON.stringify(after && after.personal_note));


    // ── 6) A17: Aushang bearbeiten, der nicht mehr existiert → Hinweis + zurück, KEINE stille Neuanlage.
    console.log('A17 — gelöschter Aushang:');
    const bul = (await req('POST', '/api/bulletin', admin, { title: 'A17-Test', text: 'weg gleich' })).body.entry;
    ok('Aushang angelegt', !!bul);
    const before = ((await req('GET', '/api/bulletin', admin)).body.entries || []).length;
    await req('DELETE', '/api/bulletin/' + bul.id, admin);           // inzwischen gelöscht
    await p.evaluate((id) => { location.hash = '#/bulletin/edit/' + id; }, bul.id);
    await sleep(1500);
    const a17 = await p.evaluate(() => ({
      hash: location.hash,
      toast: document.querySelector('.toast')?.textContent || '',
      formDa: !!document.getElementById('bulletin-form'),
    }));
    ok('Hinweis „existiert nicht mehr"', /existiert nicht mehr/i.test(a17.toast), 'toast=' + a17.toast);
    ok('zurück zur Aushang-Liste (kein Formular)', a17.hash === '#/bulletin' && !a17.formDa, JSON.stringify(a17));
    const after17 = ((await req('GET', '/api/bulletin', admin)).body.entries || []).length;
    ok('kein neuer Aushang entstanden', after17 === before - 1, `vorher ${before} → jetzt ${after17}`);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nStartzeit + Notiz: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
