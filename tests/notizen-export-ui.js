// Drucken und „Speichern als" in der geöffneten Notiz — Oberfläche (Etappe B, 27.09.2026).
//
// Anna (Eigentümerin) und Rita (Leserecht) am Handy (Touch), Tom (Schreibrecht) schreibt mit.
// Geprüft wird, was Alex am Handy erlebt:
//   * „⋯" neben „← Fertig" öffnet das Menü mit fünf Einträgen; Abbrechen tut nichts.
//   * Drucken: auf dem Papier NUR die Notiz — Titel, „Stand:", Inhalt; kein Menü, kein Editor,
//     keine fremden Cursor. Gemessen mit dem Druck-Medium, nicht nur am Vorhandensein.
//     Was eben getippt wurde, wird mitgedruckt. Danach ist alles wie vorher.
//   * PDF/Word/ODT: die Datei kommt mit dem richtigen Namen (Umlaute) und Inhalt — auch das,
//     was eine Sekunde vorher getippt wurde.
//   * Öffnet sich kein Druckfenster, sagt die App es und bietet das PDF an.
//   * Im Funkloch keine Datei ohne die letzten Änderungen, sondern eine klare Meldung.
//   * Leserecht: Menü geht; „Stand als eigene Notiz" legt Rita eine eigene Notiz an und öffnet sie
//     zum Schreiben. Anna sieht die Kopie nicht.
//
//   node tests/notizen-export-ui.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3340, DB = '/tmp/notizen-export-ui.db', LOG = '/tmp/notizen-export-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), 'notiz-export-ui-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const pdfText = (buf) => { const f = path.join(ORDNER, 'x.pdf'); fs.writeFileSync(f, buf); return spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }).stdout || ''; };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {};
    for (const [u, n] of [['anna', 'Anna Berger'], ['tom', 'Tom Kraus'], ['rita', 'Rita Lehmann']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user.id;
    }
    const tAnna = await tok('anna', 'Test1234!'), tRita = await tok('rita', 'Test1234!');
    const note = (await req('POST', '/api/notes', tAnna, { title: 'Zähler & Material', body: 'Kabel NYM-J 3×1,5\nWago 221-413' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }, { user_id: id.rita, permission: 'read' }] });

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
      // Downloads abfangen: Name, Typ und Inhalt landen in window.__dateien statt im Download-Ordner
      await p.evaluate(() => {
        window.__dateien = [];
        window.dateiHerunterladen = async (blob, name) => {
          const b = new Uint8Array(await blob.arrayBuffer()); let s = '';
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
          window.__dateien.push({ name, typ: blob.type, b64: btoa(s) });
        };
      });
      return p;
    };
    const oeffnen = async (p, nid) => {
      await p.evaluate((i) => { location.hash = '/notes/' + i; }, nid);
      await p.waitForSelector('.notiz-editor .ql-editor');
      await p.waitForFunction(() => /Gespeichert|Nur lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    };
    const menue = async (p) => { await p.tap('#notiz-mehr'); await p.waitForSelector('.modal-overlay [data-val]'); await sleep(150); };
    const waehle = (p, wert) => p.evaluate((w) => document.querySelector(`.modal-overlay [data-val="${w}"]`).click(), wert);
    const ansEnde = (p) => p.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    const datei = async (p, anzahlVorher) => {
      await p.waitForFunction((n) => window.__dateien.length > n, { timeout: 10000 }, anzahlVorher).catch(() => {});
      const d = await p.evaluate(() => window.__dateien[window.__dateien.length - 1] || null);
      return d && { ...d, buf: Buffer.from(d.b64, 'base64') };
    };

    const A = await seite('anna'), T = await seite('tom'), R = await seite('rita');
    await oeffnen(A, note.id); await oeffnen(T, note.id);
    // Formatierung, damit im Druck mehr als Klartext steht
    await A.evaluate(() => { const q = _notizSitzung.quill; q.formatLine(0, 1, 'list', 'checked', 'user'); q.formatLine(q.getText().indexOf('Wago'), 1, 'list', 'unchecked', 'user'); });
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(3, 0, 'user'); });   // Toms Cursor steht bei Anna im Text
    await A.waitForFunction(() => document.querySelectorAll('.notiz-editor .ql-cursor').length >= 1, { timeout: 5000 }).catch(() => {});

    console.log('\nDas Menü „⋯"');
    const knopf = await A.evaluate(() => { const b = document.getElementById('notiz-mehr'), f = document.getElementById('notiz-fertig');
      const r = b.getBoundingClientRect(), rf = f.getBoundingClientRect();
      return { sichtbar: b.checkVisibility(), w: r.width, h: r.height, nebenFertig: Math.abs((r.top + r.bottom) / 2 - (rf.top + rf.bottom) / 2) < 8 }; });
    ok('„⋯" steht sichtbar neben „← Fertig", Tippziel mindestens 36 × 44 px', knopf.sichtbar && knopf.nebenFertig && knopf.w >= 44 && knopf.h >= 36, JSON.stringify(knopf));
    await menue(A);
    const eintraege = await A.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val + ':' + b.textContent.trim()));
    // Anna ist Eigentümerin: seit Etappe C (Gäste) zusätzlich „Gäste verwalten" — Rita sieht es nicht (unten).
    // Seit 02.10.2026 für jeden in der App auch „🔔 Erinnern" (notiz-erinnerungen-ui.js prüft es genauer).
    ok('Einträge: Drucken, PDF, Word, OpenDocument, Stand als eigene Notiz, Erinnern (+ Gäste verwalten für die Eigentümerin)',
      JSON.stringify(eintraege.map(e => e.split(':')[0])) === '["drucken","pdf","docx","odt","kopie","erinnern","gaeste"]' && /Drucken/.test(eintraege[0]) && /eigene Notiz/.test(eintraege[4]), JSON.stringify(eintraege));
    await A.evaluate(() => document.querySelector('.modal-overlay [data-act="cancel"]').click()); await sleep(300);
    ok('Abbrechen: Menü zu, nichts gedruckt oder geladen, Sitzung offen', await A.evaluate(() =>
      !document.querySelector('.modal-overlay') && !document.getElementById('notiz-druck') && window.__dateien.length === 0 && _notizSitzung.offen));

    console.log('\nDrucken');
    await ansEnde(A); await A.keyboard.type(' eben getippt');
    await A.emulateMediaType('print');
    await A.evaluate(() => {
      window.print = () => {
        window.dispatchEvent(new Event('beforeprint'));   // wie ein echter Browser, der sein Druckfenster öffnet
        const d = document.getElementById('notiz-druck');
        const sichtbar = (sel) => [...document.querySelectorAll(sel)].some(e => e.checkVisibility());
        window.__druck = {
          klasse: document.body.classList.contains('notiz-druckt'),
          titel: d && (d.querySelector('h1') || {}).textContent,
          stand: d && (d.querySelector('.druck-stand') || {}).textContent,
          text: d && d.innerText,
          haken: d && d.querySelectorAll('li.erledigt').length,
          druckSichtbar: !!d && d.checkVisibility(),
          andereSichtbar: ['.main', '.notiz-editor', '#notiz-mehr', '.ql-toolbar, #notiz-leiste', 'nav, header, .topbar, .sidebar', '.ql-cursor', '.toast.show']
            .filter(s => sichtbar(s)),
          cursorImDruck: !!d && !!d.querySelector('.ql-cursor, .ql-cursor-flag'),
        };
      };
    });
    await menue(A); await waehle(A, 'drucken'); await sleep(300);
    const druck = await A.evaluate(() => window.__druck || null);
    ok('auf dem Papier: Titel, „Stand: TT.MM.JJJJ, HH:MM", Inhalt samt Checkliste',
      druck && druck.klasse && druck.titel === 'Zähler & Material' && /^Stand: \d\d\.\d\d\.\d{4}, \d\d:\d\d$/.test(druck.stand)
        && /Kabel NYM-J 3×1,5/.test(druck.text) && /Wago 221-413/.test(druck.text) && druck.haken === 1, JSON.stringify(druck));
    ok('… was eben getippt wurde, wird mitgedruckt', druck && /eben getippt/.test(druck.text), druck && druck.text);
    ok('… und NUR die Notiz: kein Menü, kein Editor, keine Knopfleiste, keine fremden Cursor (Druck-Medium gemessen)',
      druck && druck.druckSichtbar && druck.andereSichtbar.length === 0 && !druck.cursorImDruck, druck && JSON.stringify(druck.andereSichtbar));
    await A.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await A.emulateMediaType('screen'); await sleep(200);
    const nachher = await A.evaluate(() => ({ druck: !!document.getElementById('notiz-druck'), klasse: document.body.classList.contains('notiz-druckt'),
      editor: document.querySelector('.notiz-editor').checkVisibility(), offen: _notizSitzung.offen,
      cursor: [...document.querySelectorAll('.notiz-editor .ql-cursor-caret')].some(e => e.checkVisibility()) }));
    ok('nach dem Drucken ist alles wie vorher (Editor da, Toms Cursor wieder zu sehen, Sitzung offen)',
      !nachher.druck && !nachher.klasse && nachher.editor && nachher.offen && nachher.cursor, JSON.stringify(nachher));
    const bildschirm = await A.evaluate(() => { const d = document.createElement('div'); d.id = 'notiz-druck'; d.textContent = 'x'; document.body.appendChild(d);
      const s = d.checkVisibility(); d.remove(); return s; });
    ok('am Bildschirm ist der Druckbereich nie zu sehen', bildschirm === false);
    await sleep(2800);
    ok('Druckfenster kam: kein Hinweis hinterher', await A.evaluate(() => !document.querySelector('.toast.show')),
      await A.evaluate(() => (document.querySelector('.toast.show') || {}).textContent));

    console.log('\nDrucken ohne Druckfenster');
    // Nicht jeder Browser öffnet eins (als App vom Startbildschirm nicht überall sicher) — dann darf
    // nicht einfach nichts passieren
    const nOhne = await A.evaluate(() => { window.print = () => {}; return window.__dateien.length; });
    await menue(A); await waehle(A, 'drucken');
    await A.waitForFunction(() => /kein Druckfenster/.test((document.querySelector('.toast.show') || {}).textContent || ''), { timeout: 5000 }).catch(() => {});
    const hinweis = await A.evaluate(() => { const t = document.querySelector('.toast.show'); const b = t && t.querySelector('.toast-aktion');
      return { text: t ? t.textContent : '', knopf: b ? b.textContent : null, druckt: document.body.classList.contains('notiz-druckt') }; });
    ok('kein Druckfenster: Hinweis mit Knopf „Als PDF speichern"; der Druckbereich bleibt (falls das Fenster doch offen ist)',
      /kein Druckfenster/.test(hinweis.text) && hinweis.knopf === 'Als PDF speichern' && hinweis.druckt, JSON.stringify(hinweis));
    await A.evaluate(() => document.querySelector('.toast.show .toast-aktion').click());
    const ersatzPdf = await datei(A, nOhne);
    ok('… der Knopf lädt das PDF', !!ersatzPdf && /\.pdf$/.test(ersatzPdf.name) && ersatzPdf.buf.slice(0, 4).toString() === '%PDF', ersatzPdf && ersatzPdf.name);
    await A.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await sleep(200);

    console.log('\nSpeichern als PDF, Word, OpenDocument');
    for (const [format, magie] of [['pdf', '%PDF'], ['docx', 'PK'], ['odt', 'PK']]) {
      const n = await A.evaluate(() => window.__dateien.length);
      await ansEnde(A); await A.keyboard.type(' ' + format + 'x');   // eine Sekunde vorher getippt
      await menue(A); await waehle(A, format);
      const d = await datei(A, n);
      ok(`${format}: Datei kommt, Name „Zähler & Material – Stand JJJJ-MM-TT HH-MM.${format}", richtiger Inhaltstyp`,
        d && new RegExp(`^Zähler & Material – Stand \\d{4}-\\d\\d-\\d\\d \\d\\d-\\d\\d\\.${format}$`).test(d.name) && d.buf.slice(0, magie.length).toString() === magie
          && d.typ.length > 10, d && `${d.name} | ${d.typ} | ${d.buf.slice(0, 4)}`);
      if (format === 'pdf') {
        const t = pdfText(d.buf).replace(/\s+/g, ' ');
        ok('PDF: enthält, was eine Sekunde vorher getippt wurde (und das Ältere)', /pdfx/.test(t) && /eben getippt/.test(t) && /Zähler & Material/.test(t), t.slice(0, 200));
      }
    }

    console.log('\nFunkloch');
    const nFunk = await A.evaluate(() => window.__dateien.length);
    await A.setOfflineMode(true);
    await ansEnde(A); await A.keyboard.type(' offline');
    await menue(A); await waehle(A, 'pdf');
    await A.waitForFunction(() => /noch nicht beim Server/.test((document.querySelector('.toast') || {}).textContent || ''), { timeout: 8000 }).catch(() => {});
    const funk = await A.evaluate(() => ({ toast: (document.querySelector('.toast') || {}).textContent || '', dateien: window.__dateien.length }));
    ok('ohne Netz: keine Datei ohne die letzten Änderungen, sondern eine klare Meldung', /noch nicht beim Server/.test(funk.toast) && funk.dateien === nFunk, JSON.stringify(funk));
    // Die Meldung darf „⋯" und „← Fertig" nicht verdecken (vorher: der nächste Tipp schloss nur sie).
    // Erst messen, wenn sie ausgefahren ist (0,3 s Bewegung) — mittendrin lag sie noch oberhalb, und „frei" wäre Zufall.
    await sleep(600);
    const frei = await A.evaluate(() => ['notiz-mehr', 'notiz-fertig'].map(k => { const r = document.getElementById(k).getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('#' + k) !== null; }));
    const sichtbar = await A.evaluate(() => { const t = document.querySelector('.toast.show'); if (!t) return null; const r = t.getBoundingClientRect(); return { oben: Math.round(r.top), unten: Math.round(r.bottom) }; });
    ok('… und sie liegt unter der Knopfreihe: „⋯" und „← Fertig" bleiben antippbar, die Meldung ist zu sehen', frei.every(Boolean) && sichtbar && sichtbar.oben >= 110, JSON.stringify({ frei, sichtbar }));
    await A.setOfflineMode(false);
    await A.waitForFunction(() => /Gespeichert/.test(document.getElementById('notiz-status').textContent), { timeout: 30000 }).catch(() => {});
    // Die Meldung liegt oben über „⋯" (gemessen: elementFromPoint traf die Meldung) — deshalb hat sie
    // selbst den Knopf „Nochmal versuchen"
    const knopfInMeldung = await A.evaluate(() => { const b = document.querySelector('.toast.show .toast-aktion'); return b ? b.textContent : null; });
    await A.evaluate(() => { const b = document.querySelector('.toast.show .toast-aktion'); if (b) b.click(); });
    const nachFunk = await datei(A, nFunk);
    ok('… wieder mit Netz: „Nochmal versuchen" in der Meldung holt die Datei, mit „offline"',
      knopfInMeldung === 'Nochmal versuchen' && !!nachFunk && /offline/.test(pdfText(nachFunk.buf)), `${knopfInMeldung} | ${nachFunk && nachFunk.name}`);
    await sleep(300);
    ok('… und die Meldung ist danach weg, „⋯" wieder frei', await A.evaluate(() => { const b = document.getElementById('notiz-mehr').getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2).closest('#notiz-mehr') !== null; }));

    console.log('\nLeserecht und „Stand als eigene Notiz"');
    await oeffnen(R, note.id);
    const nR = await R.evaluate(() => window.__dateien.length);
    await menue(R);
    const rEintraege = await R.evaluate(() => [...document.querySelectorAll('.modal-overlay [data-val]')].map(b => b.dataset.val));
    await waehle(R, 'odt');
    const rDatei = await datei(R, nR);
    ok('Rita (nur lesen) hat das Menü — ohne „Gäste verwalten" — und bekommt die Datei',
      !!rDatei && /\.odt$/.test(rDatei.name) && rEintraege.includes('kopie') && !rEintraege.includes('gaeste'), `${rDatei && rDatei.name} ${JSON.stringify(rEintraege)}`);
    await menue(R); await waehle(R, 'kopie');
    await R.waitForFunction((alt) => /^#\/notes\/\d+$/.test(location.hash) && location.hash !== alt, { timeout: 8000 }, '#/notes/' + note.id).catch(() => {});
    await R.waitForFunction(() => /Gespeichert/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 }).catch(() => {});
    const kopie = await R.evaluate(() => ({ hash: location.hash, titel: document.getElementById('notiz-titel').value,
      leiste: document.getElementById('notiz-leiste').checkVisibility(), text: document.querySelector('.notiz-editor .ql-editor').innerText,
      toast: (document.querySelector('.toast') || {}).textContent || '', anwesend: document.getElementById('notiz-anwesend').textContent }));
    ok('Kopie geöffnet: eigener Titel „… (Stand TT.MM.JJJJ, HH:MM)", Knopfleiste da (Rita darf schreiben), Inhalt samt „offline"',
      kopie.hash !== '#/notes/' + note.id && /^Zähler & Material \(Stand \d\d\.\d\d\.\d{4}, \d\d:\d\d\)$/.test(kopie.titel) && kopie.leiste
        && /offline/.test(kopie.text) && /Eigene Notiz angelegt/.test(kopie.toast), JSON.stringify(kopie));
    ok('in der Kopie ist Rita allein (Anna und Tom sind im Original)', !/Anna|Tom/.test(kopie.anwesend), kopie.anwesend);
    await ansEnde(R); await R.keyboard.type(' Ritas Zusatz');
    await sleep(2500);
    const kId = Number(kopie.hash.split('/').pop());
    const annaListe = (await req('GET', '/api/notes', tAnna)).body.notes;
    const ritaKopie = ((await req('GET', '/api/notes', tRita)).body.notes || []).find(x => x.id === kId);
    ok('Ritas Zusatz ist in ihrer Kopie gespeichert, das Original und Anna bleiben unberührt',
      ritaKopie && /Ritas Zusatz/.test(ritaKopie.body) && !annaListe.some(x => x.id === kId) && !/Ritas Zusatz/.test(await A.evaluate(() => _notizSitzung.quill.getText())),
      ritaKopie && ritaKopie.body);

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    try { fs.rmSync(ORDNER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nNotiz-Export (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
