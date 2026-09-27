// Gäste in Notizen — Oberfläche (Etappe C, 27.09.2026).
//
// Anna (Eigentümerin, Handy) lädt über 🔗 einen Gast ein; der Gast öffnet den Link in einem Browser
// OHNE Konto (eigenes Handy). Geprüft wird, was Alex und der Gast erleben:
//   * Dialog: Name, Recht, Passwort (Vorschlag), freiwillig Ablauf → Link + Passwort EINMAL angezeigt,
//     mit Hinweis „getrennt schicken". Karte zeigt „🔗 1 Gast". Tom (nur Mitarbeiter mit Schreibrecht): kein 🔗.
//   * Gästeseite: Passwort-Maske → falsches Passwort erklärt → richtig → Notiz; lädt KEINE App.
//     „Du bist als Gast dabei: …", Titel fest, Knopfleiste bei Schreibrecht, ⋯ ohne Kopie/Gäste.
//   * Live mit Anna: Text kommt an; Anna sieht „Herr Maier (Gast)", der Gast sieht nur „Anna".
//   * Neu laden → bleibt angemeldet. Lesen → sofort nur lesen. Neues Passwort → zurück zur Maske mit
//     Erklärung, neues geht. PDF herunterladen. Abmelden → Maske, Gerät vergessen. Entfernt → Hinweis.
//   * Unvollständiger / fremder Link → verständlicher Hinweis. Einstellungen: Schalter mit Rückfrage.
//   * Die Gästeseite hängt an der Cache-Nummer (gast.html ?v=) — sonst bekäme ein Gast alten Code.
//
//   node tests/notiz-gaeste-ui.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3343, DB = '/tmp/notiz-gaeste-ui.db', LOG = '/tmp/notiz-gaeste-ui.log';
const BASIS = 'http://localhost:' + PORT;
const APP = path.join(__dirname, '..');
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
  console.log('\nGästeseite hängt an der Cache-Nummer');
  const cache = (fs.readFileSync(path.join(APP, 'public/sw.js'), 'utf8').match(/CACHE_VERSION = (\d+)/) || [])[1];
  const versionen = [...fs.readFileSync(path.join(APP, 'public/gast.html'), 'utf8').matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  ok(`gast.html: alle ?v= gleich der Cache-Nummer (${cache})`, versionen.length >= 3 && versionen.every(v => v === cache), versionen.join(','));

  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const adminPw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: adminPw })).body.token;
    const id = {};
    for (const [u, n] of [['anna', 'Anna Berger'], ['tom', 'Tom Kraus']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter', hours_mon: 8 })).body.user.id;
    }
    const tAnna = (await req('POST', '/api/auth/login', null, { username: 'anna', password: 'Test1234!' })).body.token;
    const note = (await req('POST', '/api/notes', tAnna, { title: 'Übergabe Halle 2', body: 'Schlüssel beim Hausmeister' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neu = async (name) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(name + ': ' + e.message));
      await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p, u, pw = 'Test1234!') => {
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', pw);
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(400);
    };
    const liste = async (p) => { await p.evaluate(() => { location.hash = '/notes'; }); await p.waitForSelector('.note-card'); await sleep(300); };
    // Eine Meldung liegt oben über „⋯" — ein Tipp schlösse nur sie (R14). Wie ein Mensch: warten, bis sie weg ist.
    const meldungWeg = (p) => p.waitForFunction(() => !document.querySelector('.toast.show'), { timeout: 15000 }).catch(() => {});

    const A = await neu('anna'); await anmelden(A, 'anna');
    const T = await neu('tom'); await anmelden(T, 'tom');

    console.log('\nEinladen (Anna, Übersicht)');
    await liste(A);
    ok('Anna: 🔗-Knopf an ihrer Karte', await A.evaluate(() => !!document.querySelector('.note-gaeste-btn')));
    await liste(T);
    ok('Tom (Schreibrecht, nicht Eigentümer): kein 🔗-Knopf', await T.evaluate(() => !document.querySelector('.note-gaeste-btn')));
    await A.tap('.note-gaeste-btn');
    await A.waitForSelector('#gast-neu');
    ok('Dialog: noch keine Gäste, Formular zum Einladen', await A.evaluate(() => /Noch keine Gäste/.test(document.querySelector('.notiz-gaeste-dialog').textContent)));
    await A.type('#gn-name', 'Herr Maier');
    await A.evaluate(() => { document.querySelector('input[name="gn-recht"][value="write"]').checked = true; });
    await A.tap('#gn-vorschlag');
    const vorschlag = await A.evaluate(() => document.getElementById('gn-pw').value);
    ok('„Vorschlagen" füllt ein lesbares Passwort (12 Zeichen in Vierergruppen)', /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/.test(vorschlag) && !/[0O1lI]/.test(vorschlag), vorschlag);
    await A.evaluate(() => document.querySelector('#gast-neu button[type="submit"]').click());
    await A.waitForSelector('#gz-link');
    const zugang = await A.evaluate(() => ({ link: document.getElementById('gz-link').value, pw: document.getElementById('gz-pw').value,
      hinweis: document.querySelector('.gast-zugang').textContent, zeile: (document.querySelector('.gast-zeile') || {}).textContent || '' }));
    ok('danach: Link /gast#… und das Passwort EINMAL angezeigt, mit Hinweis „getrennten Wegen"',
      new RegExp('^' + BASIS + '/gast#[A-Za-z0-9_-]{30,}$').test(zugang.link) && zugang.pw === vorschlag && /getrennten Wegen/.test(zugang.hinweis) && /nur jetzt angezeigt/.test(zugang.hinweis),
      JSON.stringify(zugang).slice(0, 200));
    ok('… und in der Liste: „Herr Maier (Gast)", Schreiben, noch nie da', /Herr Maier/.test(zugang.zeile) && /noch nie da/.test(zugang.zeile)
      && await A.evaluate(() => document.querySelector('.gast-zeile .gast-recht').value === 'write'));
    await A.evaluate(() => document.getElementById('gaeste-zu').click());
    await A.waitForFunction(() => /1 Gast/.test((document.querySelector('.notiz-gaeste-badge') || {}).textContent || ''), { timeout: 5000 }).catch(() => {});
    ok('Karte zeigt „🔗 1 Gast"', /1 Gast/.test(await A.evaluate(() => (document.querySelector('.notiz-gaeste-badge') || {}).textContent || '')));

    console.log('\nGästeseite');
    const G = await neu('gast');
    await G.goto(zugang.link, { waitUntil: 'domcontentloaded' });
    await G.waitForSelector('#gast-pw');
    const seite = await G.evaluate(() => ({ app: typeof api !== 'undefined' || typeof S !== 'undefined' || !!document.querySelector('script[src*="app-1-core"]'),
      text: document.getElementById('gast').textContent, robots: (document.querySelector('meta[name="robots"]') || {}).content }));
    ok('Passwort-Maske mit Erklärung; die App wird NICHT geladen; noindex', !seite.app && /als Gast zu einer Notiz eingeladen/.test(seite.text) && /noindex/.test(seite.robots), JSON.stringify(seite).slice(0, 160));
    await G.type('#gast-pw', 'falsch-falsch');
    await G.evaluate(() => document.getElementById('gast-los').click());
    await G.waitForSelector('.gast-meldung');
    ok('falsches Passwort → „Das Passwort stimmt nicht."', /stimmt nicht/.test(await G.evaluate(() => document.querySelector('.gast-meldung').textContent)));
    await G.evaluate(() => { document.getElementById('gast-pw').value = ''; });
    await G.type('#gast-pw', zugang.pw);
    await G.evaluate(() => document.getElementById('gast-los').click());
    await G.waitForSelector('.notiz-editor .ql-editor');
    await G.waitForFunction(() => /Gespeichert|Nur lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    const gEditor = await G.evaluate(() => ({ du: document.querySelector('.gast-du').textContent, titel: document.getElementById('notiz-titel').value,
      titelFest: document.getElementById('notiz-titel').disabled, leiste: document.getElementById('notiz-leiste').checkVisibility(),
      text: document.querySelector('.ql-editor').innerText.trim(), projekt: !!document.getElementById('notiz-projekt'), tabTitel: document.title }));
    ok('Notiz offen: „Du bist als Gast dabei: Herr Maier", Titel fest, Knopfleiste da, Inhalt da, kein Projekt',
      /Herr Maier/.test(gEditor.du) && gEditor.titel === 'Übergabe Halle 2' && gEditor.titelFest && gEditor.leiste && /Schlüssel beim Hausmeister/.test(gEditor.text) && !gEditor.projekt && gEditor.tabTitel === 'Übergabe Halle 2',
      JSON.stringify(gEditor));
    await G.tap('#notiz-mehr'); await G.waitForSelector('.modal-overlay [data-val]');
    const gMenue = await G.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val).filter(Boolean));
    ok('⋯ beim Gast: Drucken, PDF, Word, ODT — keine Kopie, kein „Gäste verwalten"', JSON.stringify(gMenue) === '["drucken","pdf","docx","odt"]', JSON.stringify(gMenue));
    await G.evaluate(() => { window.__dateien = []; window.dateiHerunterladen = async (blob, name) => { const b = new Uint8Array(await blob.arrayBuffer()); window.__dateien.push({ name, anfang: String.fromCharCode(...b.slice(0, 4)) }); }; });
    await G.evaluate(() => document.querySelector('.modal-overlay [data-val="pdf"]').click());
    await G.waitForFunction(() => window.__dateien.length > 0, { timeout: 10000 }).catch(() => {});
    const gDatei = await G.evaluate(() => window.__dateien[0] || null);
    ok('Gast lädt die Notiz als PDF (Name „Übergabe Halle 2 – Stand …pdf")', gDatei && gDatei.anfang === '%PDF' && /^Übergabe Halle 2 – Stand .*\.pdf$/.test(gDatei.name), JSON.stringify(gDatei));

    console.log('\nLive mit Anna');
    await A.evaluate((i) => { location.hash = '/notes/' + i; }, note.id);
    await A.waitForSelector('.notiz-editor .ql-editor');
    await A.waitForFunction(() => /Gespeichert/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    await G.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await G.keyboard.type(' Hallo vom Gast');
    await A.waitForFunction(() => /Hallo vom Gast/.test(document.querySelector('.ql-editor').innerText), { timeout: 8000 }).catch(() => {});
    ok('Gast tippt → Anna sieht es live', /Hallo vom Gast/.test(await A.evaluate(() => document.querySelector('.ql-editor').innerText)));
    // Ohne Fokus meldet das Schreibfeld keine Auswahl — Annas Fenster nach vorn (sonst käme kein Cursor)
    await A.bringToFront();
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(3, 0, 'user'); });
    await G.waitForFunction(() => document.querySelectorAll('.notiz-editor .ql-cursor').length > 0, { timeout: 5000 }).catch(() => {});
    await A.waitForFunction(() => /Herr Maier \(Gast\)/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 5000 }).catch(() => {});
    await G.waitForFunction(() => /Anna/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 5000 }).catch(() => {});
    const drin = { anna: await A.evaluate(() => document.getElementById('notiz-anwesend').textContent), gast: await G.evaluate(() => document.getElementById('notiz-anwesend').textContent) };
    ok('Anna sieht „Herr Maier (Gast)"; der Gast sieht „Anna" — ohne Nachnamen', /Herr Maier \(Gast\)/.test(drin.anna) && /Anna/.test(drin.gast) && !/Berger/.test(drin.gast), JSON.stringify(drin));
    const fahne = await G.evaluate(() => [...document.querySelectorAll('.notiz-editor .ql-cursor-name')].map(e => e.textContent));
    ok('… auch am Cursor-Namensschild steht beim Gast nur „Anna"', fahne.includes('Anna') && !fahne.some(f => /Berger/.test(f)), JSON.stringify(fahne));

    console.log('\nNeu laden, Rechte, Passwort');
    await G.reload({ waitUntil: 'domcontentloaded' });
    await G.waitForSelector('.notiz-editor .ql-editor, #gast-pw');
    ok('neu geladen: bleibt angemeldet (kein Passwort nötig)', await G.evaluate(() => !document.getElementById('gast-pw') && !!document.querySelector('.gast-du')));
    await G.waitForFunction(() => /Gespeichert/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    // Anna stellt über ⋯ → „Gäste verwalten" im geöffneten Editor auf Lesen
    await meldungWeg(A);
    await A.tap('#notiz-mehr'); await A.waitForSelector('.modal-overlay [data-val]');
    const aMenue = await A.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val).filter(Boolean));
    ok('⋯ bei Anna (Eigentümerin): zusätzlich „Kopie" und „Gäste verwalten"', aMenue.includes('kopie') && aMenue.includes('gaeste'), JSON.stringify(aMenue));
    await A.evaluate(() => document.querySelector('.modal-overlay [data-val="gaeste"]').click());
    await A.waitForSelector('.gast-zeile .gast-recht');
    await A.select('.gast-zeile .gast-recht', 'read');
    await G.waitForFunction(() => !document.getElementById('notiz-leiste').checkVisibility() && document.getElementById('notiz-nur-lesen').checkVisibility(), { timeout: 5000 }).catch(() => {});
    const gLesen = await G.evaluate(() => ({ leiste: document.getElementById('notiz-leiste').checkVisibility(), hinweis: document.getElementById('notiz-nur-lesen').checkVisibility(),
      toast: (document.querySelector('.toast') || {}).textContent || '', tippbar: document.querySelector('.ql-editor').isContentEditable }));
    ok('Lesen: beim Gast sofort keine Knopfleiste, Hinweis „nur lesen", nicht tippbar, Meldung', !gLesen.leiste && gLesen.hinweis && !gLesen.tippbar && /nur noch lesen/.test(gLesen.toast), JSON.stringify(gLesen));
    // Neues Passwort
    await A.waitForSelector('.gast-neues-pw');
    await A.evaluate(() => document.querySelector('.gast-neues-pw').click());
    await A.waitForSelector('.modal-overlay.dialog-modal input, .modal-overlay.dialog-modal textarea');
    const neuesPw = await A.evaluate(() => (document.querySelector('.modal-overlay.dialog-modal input, .modal-overlay.dialog-modal textarea') || {}).value);
    await A.evaluate(() => { const b = [...document.querySelectorAll('.modal-overlay.dialog-modal button')].find(x => /Passwort setzen/.test(x.textContent)); b.click(); });
    await G.waitForSelector('#gast-pw', { timeout: 8000 }).catch(() => {});
    const gMaske = await G.evaluate(() => (document.querySelector('.gast-meldung') || {}).textContent || '');
    ok('neues Passwort → Gast landet an der Maske: „Das Passwort wurde geändert …"', /Passwort wurde geändert/.test(gMaske), gMaske);
    await A.waitForSelector('#gz-pw');
    ok('… Anna sieht das neue Passwort einmal', (await A.evaluate(() => document.getElementById('gz-pw').value)) === neuesPw && neuesPw.length >= 8, neuesPw);
    await G.type('#gast-pw', neuesPw);
    await G.evaluate(() => document.getElementById('gast-los').click());
    await G.waitForSelector('.notiz-editor .ql-editor');
    ok('mit dem neuen Passwort wieder drin (jetzt Lesen)', await G.waitForFunction(() => /Nur lesen/.test(document.getElementById('notiz-status').textContent), { timeout: 8000 }).then(() => true).catch(() => false));

    console.log('\nAbmelden und Entfernen');
    await G.evaluate(() => document.getElementById('gast-abmelden').click());
    await G.waitForSelector('.modal-overlay [data-val="ja"]');
    await G.evaluate(() => document.querySelector('.modal-overlay [data-val="ja"]').click());
    await G.waitForSelector('#gast-pw');
    const ab = await G.evaluate(() => ({ text: document.getElementById('gast').textContent, gemerkt: Object.keys(localStorage).filter(k => k.startsWith('notiz-gast:')) }));
    ok('Abmelden → Maske „Du bist abgemeldet", Gerät hat den Zugang vergessen', /abgemeldet/.test(ab.text) && ab.gemerkt.length === 0, JSON.stringify(ab));
    await G.type('#gast-pw', neuesPw);
    await G.evaluate(() => document.getElementById('gast-los').click());
    await G.waitForSelector('.notiz-editor .ql-editor');
    await A.waitForSelector('.gast-entfernen');
    await A.evaluate(() => document.querySelector('.gast-entfernen').click());
    await A.waitForSelector('.modal-overlay.dialog-modal');
    await A.evaluate(() => { const b = [...document.querySelectorAll('.modal-overlay.dialog-modal button')].find(x => /Entfernen/.test(x.textContent)); b.click(); });
    await G.waitForFunction(() => /entfernt/.test(document.getElementById('gast').textContent), { timeout: 8000 }).catch(() => {});
    ok('Anna entfernt den Gast → beim Gast „Dein Zugang zu dieser Notiz wurde entfernt."', /Dein Zugang zu dieser Notiz wurde entfernt/.test(await G.evaluate(() => document.getElementById('gast').textContent)));

    console.log('\nFalsche Links');
    const L = await neu('links');
    await L.goto(BASIS + '/gast', { waitUntil: 'domcontentloaded' }); await L.waitForSelector('.gast-karte');
    ok('ohne Kennung → „Dieser Link ist unvollständig"', /unvollständig/.test(await L.evaluate(() => document.getElementById('gast').textContent)));
    await L.goto(BASIS + '/gast#gibt-es-nicht-1234567890', { waitUntil: 'domcontentloaded' }); await L.waitForSelector('#gast-pw');
    await L.type('#gast-pw', 'irgendwas12');
    await L.evaluate(() => document.getElementById('gast-los').click());
    await L.waitForFunction(() => /gilt nicht/.test(document.getElementById('gast').textContent), { timeout: 5000 }).catch(() => {});
    ok('fremde Kennung → „Dieser Link gilt nicht (mehr)" statt Passwortfehler', /Dieser Link gilt nicht/.test(await L.evaluate(() => document.getElementById('gast').textContent)));

    console.log('\nEinstellungen (Admin)');
    const Ad = await neu('admin'); await anmelden(Ad, 'admin', adminPw);
    await Ad.evaluate(() => { location.hash = '/settings'; });
    await Ad.waitForSelector('#s-notiz-gaeste');
    ok('Schalter „Gäste in Notizen erlauben" ist da und an', await Ad.evaluate(() => document.getElementById('s-notiz-gaeste').checked));
    await Ad.evaluate(() => document.getElementById('s-notiz-gaeste').click());
    await Ad.waitForSelector('.modal-overlay.dialog-modal');
    const frage = await Ad.evaluate(() => document.querySelector('.modal-overlay.dialog-modal').textContent);
    await Ad.evaluate(() => { const b = [...document.querySelectorAll('.modal-overlay.dialog-modal button')].find(x => /Abschalten/.test(x.textContent)); b.click(); });
    await sleep(600);
    const nachAus = (await req('GET', '/api/settings', admin)).body.settings.notiz_gaeste;
    ok('Ausschalten fragt nach (Gäste fliegen raus) und speichert „aus"', /fliegen sofort hinaus/.test(frage) && nachAus === 'aus', `${nachAus} | ${frage.slice(0, 80)}`);
    await A.evaluate(() => { const b = document.getElementById('gaeste-zu'); if (b) b.click(); });   // Annas Dialog von vorhin schließen
    await liste(A); await meldungWeg(A);
    await A.tap('.note-gaeste-btn'); await A.waitForSelector('.notiz-gaeste-dialog .gast-hinweis');
    ok('… im Gäste-Dialog: Hinweis „abgeschaltet", kein Formular', await A.evaluate(() => /abgeschaltet/.test(document.querySelector('.notiz-gaeste-dialog').textContent) && !document.getElementById('gast-neu')));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nNotiz-Gäste (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
