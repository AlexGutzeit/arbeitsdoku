// Projektnotiz — Oberfläche (28.09.2026): die gemeinsame Notiz eines Projekts, im Board unter Projekte.
//
// Carla (Chef), Anna (dem Projekt zugeteilt) und Tom (nicht zugeteilt) am Handy. Geprüft:
//   * Board: in der aufgeklappten Kachel „📝 Projektnotiz" mit Vorschau („Noch leer."), das alte Feld
//     heißt „Kurzinfo"; Knopf „Öffnen und mitschreiben" (Anna) bzw. „… mitlesen" (Tom).
//   * Öffnen → Live-Editor unter #/projects/<id>/notiz: Titel = Projektname und fest, Hinweis, kein
//     Projektfeld, Menü „Projekte" aktiv; Anna schreibt, Tom liest nur (keine Knopfleiste).
//   * ⋯: „Gäste verwalten" nur beim Chef.
//   * Carla schaut aufs Board, während Anna das Erste schreibt → 📝 erscheint ohne Neuladen.
//   * „← Fertig" führt zurück aufs Board, die Kachel ist noch offen, die Vorschau zeigt den Text.
//   * Projekt gelöscht, während Tom drin ist → Meldung, zurück aufs Board.
//
//   node tests/projektnotiz-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3345, DB = '/tmp/projektnotiz-ui.db', LOG = '/tmp/projektnotiz-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    const id = {};
    for (const [u, n, rolle] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'], ['tom', 'Tom Kraus', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: rolle, hours_mon: 8 })).body.user.id;
    }
    const tCarla = (await req('POST', '/api/auth/login', null, { username: 'carla', password: 'Test1234!' })).body.token;
    const projekt = (await req('POST', '/api/projects', tCarla, { name: 'Halle 2', note: 'Schlüssel beim Hausmeister', assigned_user_ids: [id.anna] })).body.project;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(u + ': ' + e.message));
      await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      p.setDefaultTimeout(15000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(400);
      return p;
    };
    // Die frische Datenbank bringt ein Beispielprojekt mit — immer gezielt die Kachel von „Halle 2" nehmen
    const K = `.proj-tile[data-id="${projekt.id}"]`;
    const board = async (p) => { await p.evaluate(() => { location.hash = '/projects'; }); await p.waitForSelector(K); await sleep(300); };
    const aufklappen = async (p) => { await p.evaluate((k) => { const t = document.querySelector(k); if (!t.classList.contains('expanded')) t.querySelector('.proj-name').click(); }, K);
      await p.waitForFunction((k) => document.querySelector(k + ' .proj-notiz').checkVisibility(), {}, K); await sleep(300); };
    const bereit = (p) => p.waitForFunction(() => /Gespeichert|Nur lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });

    const A = await seite('anna'), T = await seite('tom'), C = await seite('carla');

    console.log('\nBoard');
    await board(T); await aufklappen(T);
    const tKachel = await T.evaluate((sel) => { const k = document.querySelector(sel);
      return { marke: !!k.querySelector('.proj-notiz-marke'), bereich: k.querySelector('.proj-notiz').innerText, knopf: k.querySelector('.proj-notiz-oeffnen').textContent.trim(),
        kurzinfo: (k.querySelector('.proj-note') || {}).innerText || '' }; }, K);
    ok('Tom: „📝 Projektnotiz — Noch leer.", Knopf „Öffnen und mitlesen", kein 📝 an der Kachel; altes Feld heißt „Kurzinfo"',
      !tKachel.marke && /Projektnotiz/.test(tKachel.bereich) && /Noch leer/.test(tKachel.bereich) && /mitlesen/.test(tKachel.knopf) && /^Kurzinfo\s+Schlüssel beim Hausmeister/.test(tKachel.kurzinfo), JSON.stringify(tKachel));
    await board(C);   // Carla schaut aufs Board, während Anna gleich das Erste schreibt
    await board(A); await aufklappen(A);
    ok('Anna (zugeteilt): Knopf „Öffnen und mitschreiben"', /mitschreiben/.test(await A.evaluate((k) => document.querySelector(k + ' .proj-notiz-oeffnen').textContent, K)));

    console.log('\nÖffnen und schreiben');
    await A.tap(K + ' .proj-notiz-oeffnen');
    await A.waitForSelector('.notiz-editor .ql-editor'); await bereit(A);
    const aEd = await A.evaluate(() => ({ hash: location.hash, titel: document.getElementById('notiz-titel').value, titelFest: document.getElementById('notiz-titel').disabled,
      hinweis: (document.querySelector('.notiz-projekt-hinweis') || {}).textContent || '', projektFeld: !!document.getElementById('notiz-projekt'),
      leiste: document.getElementById('notiz-leiste').checkVisibility(), menue: (document.querySelector('.nav-link.active, .sidebar a.active, [data-nav].active') || {}).textContent || '' }));
    ok('Editor unter #/projects/<id>/notiz: Titel „Halle 2" fest, Hinweis, kein Projektfeld, Knopfleiste da',
      aEd.hash === `#/projects/${projekt.id}/notiz` && aEd.titel === 'Halle 2' && aEd.titelFest && /Projektnotiz/.test(aEd.hinweis) && !aEd.projektFeld && aEd.leiste, JSON.stringify(aEd));
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(0, 0, 'user'); });
    await A.keyboard.type('Gerüst steht, Strom im OG ab Montag');
    await A.waitForFunction(() => /Gespeichert/.test(document.getElementById('notiz-status').textContent), { timeout: 8000 });
    await C.waitForFunction((k) => !!document.querySelector(k + ' .proj-notiz-marke'), { timeout: 8000 }, K).catch(() => {});
    ok('Carla (schaut aufs Board): 📝 erscheint ohne Neuladen, sobald die Notiz Inhalt hat', await C.evaluate((k) => !!document.querySelector(k + ' .proj-notiz-marke'), K));
    await A.tap('#notiz-mehr'); await A.waitForSelector('.modal-overlay [data-val]');
    const aMenue = await A.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val).filter(Boolean));
    await A.evaluate(() => document.querySelector('.modal-overlay [data-act="cancel"]').click());
    ok('⋯ bei Anna: Drucken/Speichern/Kopie, aber kein „Gäste verwalten"', aMenue.includes('pdf') && aMenue.includes('kopie') && !aMenue.includes('gaeste'), JSON.stringify(aMenue));

    console.log('\nLesen und Chef');
    await board(T); await aufklappen(T);
    await T.tap(K + ' .proj-notiz-oeffnen');
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    const tEd = await T.evaluate(() => ({ text: document.querySelector('.ql-editor').innerText, leiste: document.getElementById('notiz-leiste').checkVisibility(),
      hinweis: document.getElementById('notiz-nur-lesen').checkVisibility(), tippbar: document.querySelector('.ql-editor').isContentEditable }));
    ok('Tom liest: Text da, keine Knopfleiste, Hinweis „nur lesen", nicht tippbar', /Gerüst steht/.test(tEd.text) && !tEd.leiste && tEd.hinweis && !tEd.tippbar, JSON.stringify(tEd));
    await C.evaluate((pid) => { location.hash = `/projects/${pid}/notiz`; }, projekt.id);
    await C.waitForSelector('.notiz-editor .ql-editor'); await bereit(C);
    await C.tap('#notiz-mehr'); await C.waitForSelector('.modal-overlay [data-val]');
    const cMenue = await C.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val).filter(Boolean));
    await C.evaluate(() => document.querySelector('.modal-overlay [data-act="cancel"]').click());
    ok('⋯ beim Chef: „Gäste verwalten" dabei', cMenue.includes('gaeste'), JSON.stringify(cMenue));

    console.log('\nZurück zum Board');
    await A.waitForFunction(() => !document.querySelector('.toast.show'), { timeout: 15000 }).catch(() => {});
    await A.tap('#notiz-fertig');
    await A.waitForFunction((k) => location.hash === '#/projects' && !!document.querySelector(k), { timeout: 8000 }, K).catch(() => {});
    await A.waitForFunction((k) => /Gerüst steht/.test((document.querySelector(k + ' .proj-notiz-vorschau') || {}).innerText || ''), { timeout: 8000 }, K).catch(() => {});
    const zurueck = await A.evaluate((k) => ({ hash: location.hash, offen: document.querySelector(k).classList.contains('expanded'),
      vorschau: (document.querySelector(k + ' .proj-notiz-vorschau') || {}).innerText || '', stand: (document.querySelector(k + ' .proj-notiz-stand') || {}).innerText || '' }), K);
    ok('„← Fertig" → Board, Kachel noch offen, Vorschau zeigt den Text, „bearbeitet … von Anna Berger"',
      zurueck.hash === '#/projects' && zurueck.offen && /Gerüst steht/.test(zurueck.vorschau) && /Anna Berger/.test(zurueck.stand), JSON.stringify(zurueck));
    await board(C); await aufklappen(C);
    await C.evaluate((k) => document.querySelector(k + ' .proj-edit').click(), K);
    await C.waitForSelector('#pf2-note');
    ok('Projekt bearbeiten: das Feld heißt „Kurzinfo" (mit Erklärung)', /^Kurzinfo/.test(await C.evaluate(() => document.querySelector('label[for="pf2-note"]').textContent.trim())));

    console.log('\nProjekt gelöscht, während Tom drin ist');
    await req('DELETE', `/api/projects/${projekt.id}`, tCarla);
    await T.waitForFunction(() => location.hash === '#/projects', { timeout: 8000 }).catch(() => {});
    const tRaus = await T.evaluate(() => ({ hash: location.hash, toast: (document.querySelector('.toast') || {}).textContent || '' }));
    ok('Tom: Meldung „Das Projekt wurde gelöscht …", zurück aufs Board', tRaus.hash === '#/projects' && /Projekt wurde gelöscht/.test(tRaus.toast), JSON.stringify(tRaus));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nProjektnotiz (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
