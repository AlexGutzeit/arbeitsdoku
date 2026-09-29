// Neu zeichnen nur auf der eigenen Seite (R23, 29.09.2026).
//
// Ein Knopf, der nach dem Speichern seine Seite neu zeichnet (`await api(…); renderDocuments();`), überschrieb
// die inzwischen geöffnete Seite: Adresse und Menü „Mein Konto", zu sehen die Dokumente (gemessen 25.09.).
// Jetzt wacht jede Seite selbst (app-1-core.js, SEITEN / seitenWachenEinrichten). Geprüft:
//   A  Jede Seite, die der Router aufruft, steht in SEITEN; jede Seite und jeder Teil-Zeichner ist bewacht.
//   B  Für jede Seite: geöffnet, dann „Mein Konto" geöffnet, dann ruft ein verspäteter Knopf die alte Seite
//      auf → „Mein Konto" bleibt stehen, Menü bleibt auf „Mein Konto". UND: bleibt man auf der Seite,
//      zeichnet derselbe Aufruf wie gewohnt neu (sonst wäre der Schutz ein Ausschalter).
//   C  Echte Klicks mit verzögerter Antwort: Ordner umbenennen (die Messung aus der Bugliste), Werkzeug
//      hinzufügen, Eintrag aus dem Papierkorb holen — gespeichert wird trotzdem.
//   D  Live-Meldungen zeichnen die offene Seite weiter neu (neuer Aushang erscheint).
//
//   node tests/neuzeichnen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3351, DB = '/tmp/neuzeichnen-ui.db', LOG = '/tmp/neuzeichnen-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const VERZ = 1500;
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
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;
    const ordner = (await req('POST', '/api/documents/folders', admin, { name: 'Baupläne' })).body;
    const ordnerId = ordner.id || (ordner.folder && ordner.folder.id);
    const eintrag = (await req('POST', '/api/entries', admin, { date: '2026-09-09', time_from: '07:00', time_to: '15:30', break_minutes: 30, user_id: maxId })).body.entry;
    await req('DELETE', `/api/entries/${eintrag.id}`, admin, { reason: 'Test R23' });
    const notiz = (await req('POST', '/api/notes', admin, { title: 'R23-Notiz' })).body.note;
    if (!ordnerId || !eintrag || !notiz) throw new Error('Testdaten fehlen');

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1100, height: 900 });
    seite.setDefaultTimeout(20000);
    seite.on('pageerror', e => jsFehler.push(e.message));
    // Antworten auf SCHREIBENDE Anfragen zurückhalten, solange `verzoegern` gesetzt ist
    let verzoegern = null;
    await seite.setRequestInterception(true);
    seite.on('request', r => {
      const weiter = () => r.continue().catch(() => {});
      if (verzoegern && r.method() !== 'GET' && verzoegern.test(r.url())) { setTimeout(weiter, VERZ); return; }
      weiter();
    });
    await seite.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'admin'); await seite.type('#login-pass', pwAdmin);
    await seite.click('#login-form button[type="submit"]');
    await seite.waitForFunction(() => document.querySelector('.main')); await sleep(800);

    const hin = async (r, bereit) => {
      await seite.evaluate((r) => { location.hash = r; }, r);
      await seite.waitForFunction((r) => location.hash === '#' + r, {}, r);
      if (bereit) await seite.waitForFunction(bereit, { timeout: 15000 });
      await sleep(700);
      // Dialoge hängen an <body> und bleiben bei einem Seitenwechsel stehen (eigener Punkt, R28) — hier wegräumen
      await seite.evaluate(() => document.querySelectorAll('.modal-overlay, .absence-form-overlay').forEach(m => m.remove()));
    };
    const kontoDa = () => !!document.getElementById('konto-avatar');
    const zustand = () => seite.evaluate(() => ({ hash: location.hash, konto: !!document.getElementById('konto-avatar'),
      menue: (document.querySelector('a.active[href^="#/"]') || {}).getAttribute ? document.querySelector('a.active[href^="#/"]').getAttribute('href') : null }));

    console.log('A. Liste');
    const liste = await seite.evaluate(() => {
      const imRouter = [...new Set(seiteWaehlen.toString().match(/render[A-Z]\w*(?=\()/g))].filter(n => !['renderToken', 'renderLegal', 'renderLogin'].includes(n));
      return { fehlt: imRouter.filter(n => !SEITEN.includes(n)),
        unbewacht: [...SEITEN, ...Object.keys(SEITEN_TEILE)].filter(n => !(window[n] && window[n]._seitenWache)), anzahl: imRouter.length };
    });
    ok(`jede der ${liste.anzahl} Seiten des Routers steht in SEITEN`, liste.fehlt.length === 0, 'fehlt: ' + liste.fehlt.join(', '));
    ok('jede Seite und jeder Teil-Zeichner ist bewacht', liste.unbewacht.length === 0, 'unbewacht: ' + liste.unbewacht.join(', '));

    console.log('B. Jede Seite: verspäteter Aufruf nach dem Wechsel');
    const FAELLE = [
      ['/welcome', ['renderWelcome']], ['/dashboard', ['renderDashboard', 'renderDashboardContent']],
      ['/entry/new', ['renderEntryForm']], ['/users', ['renderUsers']], ['/projects', ['renderProjects', 'renderProjectForm']],
      ['/settings', ['renderSettings']], ['/audit', ['renderAudit']], ['/deleted-entries', ['renderDeletedEntries']],
      ['/deleted-absences', ['renderDeletedAbsences']], ['/deleted-projects', ['renderDeletedProjects']],
      ['/deleted-users', ['renderDeletedUsers']], ['/documents', ['renderDocuments']], ['/pdf', ['renderPdfExport']],
      ['/statistics', ['renderStatistics', 'renderStatisticsContent']], ['/planning', ['renderPlanning', 'renderPlanningContent']],
      ['/planning/new', ['renderPlanningForm']], ['/produkte', ['renderProdukte']], ['/tools', ['renderTools']],
      ['/orders', ['renderOrders']], ['/notes', ['renderNotizen']], ['/notes/' + notiz.id, [['renderNotizEditor', notiz.id]]],
      ['/absences', ['renderAbsences']], ['/absences/urlaub', [['renderAbsenceType', 'urlaub']]],
      ['/bulletin', ['renderBulletin']], ['/bulletin/new', ['renderBulletinForm']],
    ];
    const falsch = [], ohneWirkung = [];
    for (const [route, fns] of FAELLE) {
      for (const f of fns) {
        const [name, arg] = Array.isArray(f) ? f : [f, undefined];
        // bleibt man auf der Seite, muss derselbe Aufruf neu zeichnen
        await hin(route, () => !!document.querySelector('.main') && !document.querySelector('.main .spinner'));
        await seite.evaluate(() => { const m = document.createElement('div'); m.id = 'r23-marke'; document.querySelector('.main').appendChild(m); });
        await seite.evaluate((n, a) => { window[n](a); }, name, arg);
        const neu = await seite.waitForFunction(() => !document.getElementById('r23-marke'), { timeout: 8000 }).then(() => true, () => false);
        if (!neu) ohneWirkung.push(`${route} ${name}`);
        // wechselt man vorher zu „Mein Konto", darf er es nicht übermalen
        await hin('/konto', kontoDa);
        await seite.evaluate((n, a) => { window[n](a); }, name, arg);
        await sleep(1200);
        const z = await zustand();
        if (z.hash !== '#/konto' || !z.konto || z.menue !== '#/konto') falsch.push(`${route} ${name} → ${JSON.stringify(z)}`);
      }
    }
    const zahl = FAELLE.reduce((s, f) => s + f[1].length, 0);
    ok(`auf der Seite geblieben: alle ${zahl} Aufrufe zeichnen wie gewohnt neu`, ohneWirkung.length === 0, ohneWirkung.join(' | '));
    ok(`Seite gewechselt: keiner der ${zahl} Aufrufe übermalt „Mein Konto", Menü bleibt dort`, falsch.length === 0, falsch.slice(0, 4).join(' | '));
    // und umgekehrt: „Mein Konto" selbst übermalt keine andere Seite
    await hin('/konto', kontoDa); await hin('/bulletin', () => !!document.querySelector('.main'));
    await seite.evaluate(() => renderKonto()); await sleep(1200);
    ok('„Mein Konto" verspätet aufgerufen übermalt den Aushang nicht', await seite.evaluate(() => location.hash === '#/bulletin' && !document.getElementById('konto-avatar')));

    console.log('C. Echte Klicks, Antwort 1,5 s verzögert, inzwischen „Mein Konto" geöffnet');
    // Ordner umbenennen — die Messung aus der Bugliste
    await hin('/documents', () => !!document.querySelector('.doc-folder-rename'));
    verzoegern = /\/api\/documents\/folders\//;
    await seite.click(`.doc-folder-rename[data-id="${ordnerId}"]`);
    await seite.waitForSelector('#pm-input');
    await seite.evaluate(() => { document.getElementById('pm-input').value = ''; });
    await seite.type('#pm-input', 'Pläne 2027');
    await seite.click('.dialog-modal [data-act="ok"]');
    await seite.evaluate(() => { location.hash = '/konto'; });
    await seite.waitForFunction(() => !!document.getElementById('konto-avatar'));
    await sleep(VERZ + 1200);
    let z = await zustand(); verzoegern = null;
    ok('Ordner umbenennen: „Mein Konto" bleibt stehen, Menü dort', z.hash === '#/konto' && z.konto && z.menue === '#/konto', JSON.stringify(z));
    const ordnerJetzt = JSON.stringify((await req('GET', '/api/documents', admin)).body);
    ok('… und umbenannt ist er trotzdem', ordnerJetzt.includes('Pläne 2027'), ordnerJetzt.slice(0, 160));
    // ohne Wechsel: die Liste zeigt den neuen Namen sofort
    await hin('/documents', () => !!document.querySelector('.doc-folder-rename'));
    await seite.click(`.doc-folder-rename[data-id="${ordnerId}"]`);
    await seite.waitForSelector('#pm-input');
    await seite.evaluate(() => { document.getElementById('pm-input').value = ''; });
    await seite.type('#pm-input', 'Pläne 2028');
    await seite.click('.dialog-modal [data-act="ok"]');
    ok('ohne Wechsel: die Liste zeigt den neuen Namen sofort', await seite.waitForFunction(() => /Pläne 2028/.test(document.querySelector('.main').innerText), { timeout: 8000 }).then(() => true, () => false));

    // Werkzeug hinzufügen
    await hin('/tools', () => !!document.getElementById('tool-add'));
    verzoegern = /\/api\/tools$/;
    await seite.type('#tool-name', 'Bohrhammer R23');
    await seite.click('#tool-add');
    await seite.evaluate(() => { location.hash = '/konto'; });
    await seite.waitForFunction(() => !!document.getElementById('konto-avatar'));
    await sleep(VERZ + 1200);
    z = await zustand(); verzoegern = null;
    ok('Werkzeug hinzufügen: „Mein Konto" bleibt stehen', z.hash === '#/konto' && z.konto && z.menue === '#/konto', JSON.stringify(z));
    ok('… und angelegt ist es trotzdem', JSON.stringify((await req('GET', '/api/tools', admin)).body).includes('Bohrhammer R23'));

    // Eintrag aus dem Papierkorb holen
    await hin('/deleted-entries', () => !!document.querySelector('.restore-entry'));
    verzoegern = /\/restore$/;
    await seite.click(`.restore-entry[data-id="${eintrag.id}"]`);
    await seite.waitForSelector('.dialog-modal [data-act="ok"]'); await seite.click('.dialog-modal [data-act="ok"]');
    await seite.waitForSelector('#pm-input'); await seite.type('#pm-input', 'R23');
    await seite.click('.dialog-modal [data-act="ok"]');
    await seite.evaluate(() => { location.hash = '/konto'; });
    await seite.waitForFunction(() => !!document.getElementById('konto-avatar'));
    await sleep(VERZ + 1200);
    z = await zustand(); verzoegern = null;
    ok('Papierkorb wiederherstellen: „Mein Konto" bleibt stehen', z.hash === '#/konto' && z.konto && z.menue === '#/konto', JSON.stringify(z));
    const wieder = (await req('GET', `/api/entries?user_id=${maxId}&from=2026-09-01&to=2026-09-30`, admin)).body;
    ok('… und wiederhergestellt ist er trotzdem', JSON.stringify(wieder).includes(`"id":${eintrag.id}`), JSON.stringify(wieder).slice(0, 160));

    console.log('D. Live-Meldungen');
    await hin('/bulletin', () => !!document.querySelector('.main') && !document.querySelector('.main .spinner'));
    await req('POST', '/api/bulletin', admin, { title: 'Live R23', text: 'x' });
    ok('ein neuer Aushang erscheint weiter live auf der offenen Seite',
      await seite.waitForFunction(() => /Live R23/.test(document.querySelector('.main').innerText), { timeout: 8000 }).then(() => true, () => false));
    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nNeu zeichnen nur auf der eigenen Seite: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
