// Live-Notizen in der Oberfläche: Vorschau, Öffnen, gemeinsam schreiben, Cursor, Fertig (Etappe A, Schritt 4).
//
// Drei Leute in eigenen Browsern (Handy-Größe, Touch): Anna (Eigentümerin), Tom (Schreibrecht),
// Rita (Leserecht). Geprüft wird, was Alex am Handy erlebt:
//   * Vorschau in der Übersicht (formatiert) — man ist dabei NICHT „drin"; wer drin ist, steht an der Karte.
//   * Öffnen → gemeinsame Bearbeitung: Text, Formatierung, Checkliste kommen beim anderen an.
//   * Der fremde Cursor ist SICHTBAR — gemessen am Bildpunkt, nicht an der Elementzahl: Auf
//     Touch-Geräten lag er hinter der Karte (Alex auf der Probeseite, 26.09.2026).
//   * Leserecht: keine Knopfleiste, nicht tippbar, aber live mitlesen. Rechte-Änderung gilt sofort.
//   * „← Fertig" führt an dieselbe Stelle der Übersicht zurück. Im Hintergrund meldet man sich ab.
//   * Funkloch: Änderungen bleiben auf dem Gerät und werden nachgereicht.
//   * Neue Notiz: Titel eingeben → öffnet sich direkt zum Schreiben.
//
//   node tests/notizen-live-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const sharp = require('sharp');

const PORT = 3338, DB = '/tmp/notizen-live-ui.db', LOG = '/tmp/notizen-live-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
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

// Ist an der Stelle des fremden Cursors wirklich seine Farbe zu SEHEN? (Bildpunkte des Bildschirmfotos)
async function cursorSichtbar(p, farbe) {
  const r = await p.evaluate(() => {
    const c = document.querySelector('.notiz-editor .ql-cursor-caret'); if (!c) return null;
    const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  if (!r || r.h < 4) return { sichtbar: false, grund: 'kein Cursor ' + JSON.stringify(r) };
  const bild = await p.screenshot({ clip: { x: Math.max(0, r.x - 1), y: r.y + 2, width: r.w + 2, height: Math.max(4, r.h - 4) } });
  const { data, info } = await sharp(bild).raw().toBuffer({ resolveWithObject: true });
  const [zr, zg, zb] = [1, 3, 5].map(i => parseInt(farbe.slice(i, i + 2), 16));
  let treffer = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.abs(data[i] - zr) < 40 && Math.abs(data[i + 1] - zg) < 40 && Math.abs(data[i + 2] - zb) < 40) treffer++;
  }
  return { sichtbar: treffer >= 3, grund: `${treffer} Bildpunkte in ${farbe}` };
}

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
    const tAnna = await tok('anna', 'Test1234!'), tTom = await tok('tom', 'Test1234!');
    // Viele eigene Notizen für Tom, damit die Übersicht scrollt (Rückweg an dieselbe Stelle)
    for (let i = 1; i <= 14; i++) await req('POST', '/api/notes', tTom, { title: 'Füller ' + i, body: 'Nur damit die Liste lang wird' });
    const note = (await req('POST', '/api/notes', tAnna, { title: 'Material Montag', body: 'Kabel NYM-J 3×1,5\nWago 221-413' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }, { user_id: id.rita, permission: 'read' }] });
    const boese = (await req('POST', '/api/notes', tAnna, { title: 'Eingefügt', body: '<img src=x onerror="window.__xss=1">Text' })).body.note;
    await req('PUT', `/api/notes/${boese.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'read' }] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u, handy = true) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(u + ': ' + e.message));
      await p.setViewport(handy ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1200, height: 900 });
      p.setDefaultTimeout(15000);
      await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(400);
      return p;
    };
    const liste = async (p) => { await p.evaluate(() => { location.hash = '/notes'; }); await p.waitForSelector('.note-card'); await sleep(300); };
    const karte = (p, titel) => p.evaluateHandle((t) => [...document.querySelectorAll('.note-card')].find(c => c.querySelector('.note-title').textContent.includes(t)), titel);
    const editorText = (p) => p.evaluate(() => { const e = document.querySelector('.notiz-editor .ql-editor'); return e ? e.innerText.replace(/\n+/g, '\n').trim() : null; });
    const bereit = (p) => p.waitForFunction(() => /Gespeichert|Nur lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });

    const A = await seite('anna'), T = await seite('tom'), R = await seite('rita');

    // Tom schaut schon auf die Übersicht, BEVOR Anna öffnet — nur dann muss sie sich live auffrischen.
    // (Erst andersherum gebaut: Da kam „Anna ist drin" mit dem ersten Laden, und die Prüfung „ohne
    // Neuaufbau" war grün, obwohl gar nichts aufgefrischt wurde — die Gegenprobe hat es gezeigt.)
    await liste(T);
    await T.evaluate(() => { document.querySelector('.main .card').dataset.merker = 'da'; });

    console.log('\nÖffnen aus der Übersicht');
    await liste(A);
    await (await karte(A, 'Material Montag')).asElement().$('.note-open-btn').then(b => b.tap());
    await A.waitForSelector('.notiz-editor .ql-editor'); await bereit(A);
    ok('Anna öffnet: Editor mit Titel, Status „Gespeichert", Anwesenheit „Du", Knopfleiste',
      await A.evaluate(() => document.getElementById('notiz-titel').value === 'Material Montag'
        && /Du/.test(document.getElementById('notiz-anwesend').textContent) && !document.getElementById('notiz-leiste').hidden)
      && (await editorText(A)) === 'Kabel NYM-J 3×1,5\nWago 221-413', await editorText(A));
    // Schreibfeld und gemeinsames Dokument müssen Zeichen für Zeichen übereinstimmen. Wurde das Feld
    // vor dem Stand des Servers angebunden, stand am Ende eine Leerzeile zu viel (gemessen 26.09.2026)
    // — die obige Textprobe fasst Leerzeilen zusammen und sähe das nicht.
    const deckung = await A.evaluate(() => [_notizSitzung.quill.getText(), _notizSitzung.doc.getText('notiz').toString()]);
    ok('Schreibfeld und Dokument decken sich exakt (keine Leerzeile zu viel am Ende)', deckung[0] === deckung[1], JSON.stringify(deckung));
    ok('kein altes Sperr-/Speichern-Formular mehr (kein Textfeld, kein „Speichern")',
      await A.evaluate(() => !document.getElementById('nf-body') && ![...document.querySelectorAll('button')].some(b => /^Speichern$/.test(b.textContent.trim()))));

    console.log('\nÜbersicht, während Anna drin ist');
    await T.waitForFunction(() => [...document.querySelectorAll('.note-card')].some(c => /Material Montag/.test(c.textContent) && /Anna Berger/.test((c.querySelector('.notiz-drin') || {}).textContent || '')), { timeout: 5000 }).catch(() => {});
    const chip = await T.evaluate(() => { const c = [...document.querySelectorAll('.note-card')].find(x => /Material Montag/.test(x.textContent)); const d = c && c.querySelector('.notiz-drin'); return d ? d.textContent.trim() : null; });
    ok('Tom sieht an der Karte, dass Anna drin ist', /Anna Berger/.test(chip || ''), chip);
    ok('… ohne dass die Übersicht neu aufgebaut wurde (leises Auffrischen, kein Flackern)',
      await T.evaluate(() => document.querySelector('.main .card').dataset.merker === 'da'));

    console.log('\nFormatieren');
    await A.evaluate(() => { _notizSitzung.quill.setSelection(0, 5, 'user'); });
    await A.tap('#notiz-leiste .ql-bold');
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getText().indexOf('Wago') + 2, 0, 'user'); });
    await A.tap('#notiz-leiste .ql-list[value="check"]');
    await sleep(2500);   // Ruhe → gespeichert → Übersicht frischt sich auf
    const vorschauKarte = await karte(T, 'Material Montag');
    await vorschauKarte.asElement().tap(); await sleep(400);
    const vorschau = await T.evaluate(() => { const c = [...document.querySelectorAll('.note-card')].find(x => /Material Montag/.test(x.textContent)); const b = c && c.querySelector('.note-body-full'); return b ? b.innerHTML : null; });
    ok('Vorschau in der Übersicht zeigt die Formatierung (fett, Checkliste ☐)', /<strong>Kabel<\/strong>/.test(vorschau || '') && /notiz-check/.test(vorschau || '') && /☐/.test(vorschau || ''), vorschau);
    await sleep(500);
    ok('… und Tom ist durch die Vorschau NICHT in der Notiz (Anna sieht nur sich)',
      !/Tom/.test(await A.evaluate(() => document.getElementById('notiz-anwesend').textContent)));

    console.log('\nZu zweit schreiben');
    await T.evaluate(() => window.scrollTo(0, 0));
    const scrollVorher = await T.evaluate(() => { window.scrollTo(0, 400); return window.scrollY; });
    await T.evaluate(() => [...document.querySelectorAll('.note-card')].find(x => /Material Montag/.test(x.textContent)).querySelector('.notiz-oeffnen-gross').click());
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    await A.waitForFunction(() => /Tom Kraus/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 5000 }).catch(() => {});
    ok('beide sehen einander in der Anwesenheit', /Tom Kraus/.test(await A.evaluate(() => document.getElementById('notiz-anwesend').textContent))
      && /Anna Berger/.test(await T.evaluate(() => document.getElementById('notiz-anwesend').textContent)));
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.keyboard.type(' 50 Stück');
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getText().indexOf('\n'), 0, 'user'); });
    await A.keyboard.type(' 2 Ringe');
    await sleep(1200);
    const [ta, tt] = [await editorText(A), await editorText(T)];
    ok('Getipptes von beiden steht bei beiden gleich da', ta === tt && /Kabel NYM-J 3×1,5 2 Ringe/.test(ta) && /Wago 221-413 50 Stück/.test(ta), JSON.stringify([ta, tt]));
    ok('die Checkliste kommt als Checkliste an', await T.evaluate(() => !!document.querySelector('.notiz-editor .ql-editor li[data-list="unchecked"]')));
    const deckungT = await T.evaluate(() => [_notizSitzung.quill.getText(), _notizSitzung.doc.getText('notiz').toString()]);
    ok('… auch bei Tom decken sich Schreibfeld und Dokument exakt', deckungT[0] === deckungT[1], JSON.stringify(deckungT));

    console.log('\nFremder Cursor sichtbar (Touch)');
    const tomFarbe = await T.evaluate(() => _notizSitzung.du.farbe);
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(3, 0, 'user'); });
    await sleep(500);
    const sichtbar = await cursorSichtbar(A, tomFarbe);
    ok('Toms Cursor ist bei Anna zu SEHEN (Bildpunkte in seiner Farbe)', sichtbar.sichtbar, sichtbar.grund);
    const fahne = await A.evaluate(() => { const f = document.querySelector('.notiz-editor .ql-cursor-flag'); return f ? { o: getComputedStyle(f).opacity, t: f.textContent.trim() } : null; });
    ok('… mit Namensfähnchen „Tom Kraus" gleich nach der Bewegung', fahne && fahne.o === '1' && fahne.t === 'Tom Kraus', JSON.stringify(fahne));
    await sleep(3500);
    const fahneSpaeter = await A.evaluate(() => getComputedStyle(document.querySelector('.notiz-editor .ql-cursor-flag')).opacity);
    ok('… das nach 3 s wieder ausgeblendet wird', fahneSpaeter === '0', fahneSpaeter);

    console.log('\nLeserecht');
    await R.evaluate((i) => { location.hash = '/notes/' + i; }, note.id);
    await R.waitForSelector('.notiz-editor .ql-editor'); await bereit(R);
    const rZustand = await R.evaluate(() => ({ leiste: document.getElementById('notiz-leiste').hidden, hinweis: !document.getElementById('notiz-nur-lesen').hidden,
      tippbar: document.querySelector('.notiz-editor .ql-editor').getAttribute('contenteditable'), titel: document.getElementById('notiz-titel').disabled }));
    ok('Rita (nur lesen): keine Knopfleiste, Hinweis, Feld und Titel nicht bearbeitbar',
      rZustand.leiste && rZustand.hinweis && rZustand.tippbar === 'false' && rZustand.titel, JSON.stringify(rZustand));
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await A.keyboard.press('Enter'); await A.keyboard.type('Abzweigdosen');
    await sleep(900);
    ok('… liest aber live mit', /Abzweigdosen/.test(await editorText(R) || ''), await editorText(R));

    console.log('\nTitel');
    await A.evaluate(() => { const t = document.getElementById('notiz-titel'); t.focus(); t.select(); });
    await A.keyboard.type('Material Dienstag');
    await sleep(1600);
    ok('Anna benennt um → Tom sieht den neuen Titel sofort', (await T.evaluate(() => document.getElementById('notiz-titel').value)) === 'Material Dienstag');

    console.log('\nRechte ändern, während man drin ist');
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'read' }] });
    await T.waitForFunction(() => document.getElementById('notiz-leiste').hidden, { timeout: 5000 }).catch(() => {});
    ok('Tom wird auf Lesen gestuft → Knopfleiste weg, Feld gesperrt, Hinweis',
      await T.evaluate(() => document.getElementById('notiz-leiste').hidden && document.querySelector('.notiz-editor .ql-editor').getAttribute('contenteditable') === 'false'
        && /nur noch lesen/.test((document.querySelector('.toast') || {}).textContent || '')));
    await R.waitForFunction(() => location.hash === '#/notes', { timeout: 5000 }).catch(() => {});
    ok('Rita verliert die Freigabe → zurück in der Übersicht mit Hinweis',
      (await R.evaluate(() => location.hash)) === '#/notes' && /Freigabe/.test(await R.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')),
      await R.evaluate(() => location.hash + ' ' + ((document.querySelector('.toast') || {}).textContent || '')));
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }] });
    await T.waitForFunction(() => !document.getElementById('notiz-leiste').hidden, { timeout: 5000 }).catch(() => {});

    console.log('\nIm Hintergrund');
    await T.evaluate(() => { notizZeiten.hintergrundMs = 300; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await A.waitForFunction(() => !/Tom Kraus/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 5000 }).catch(() => {});
    ok('Tom steckt das Handy weg → nach der Wartezeit ist er für Anna nicht mehr drin',
      !/Tom Kraus/.test(await A.evaluate(() => document.getElementById('notiz-anwesend').textContent)));
    await T.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await A.waitForFunction(() => /Tom Kraus/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 8000 }).catch(() => {});
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await bereit(T);
    ok('… holt es wieder hervor → ist von selbst wieder drin', /Tom Kraus/.test(await A.evaluate(() => document.getElementById('notiz-anwesend').textContent)));

    console.log('\nFunkloch');
    await T.setOfflineMode(true);
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.keyboard.type(' Funkloch');
    await sleep(700);
    const offline = await T.evaluate((i) => ({ status: document.getElementById('notiz-status').textContent, gesichert: !!localStorage.getItem('notiz-live:' + i) }), note.id);
    ok('ohne Netz: Anzeige „Keine Verbindung – wird nachgereicht", Änderung auf dem Gerät gesichert',
      /nachgereicht/.test(offline.status) && offline.gesichert, JSON.stringify(offline));
    await T.tap('#notiz-fertig');
    await T.waitForSelector('.confirm-modal, .modal-overlay', { timeout: 5000 }).catch(() => {});
    const frage = await T.evaluate(() => (document.querySelector('.modal-overlay, .confirm-modal') || {}).textContent || '');
    ok('„Fertig" im Funkloch fragt nach, statt still Änderungen zu verlieren', /noch nicht beim Server/.test(frage), frage.slice(0, 80));
    await T.evaluate(() => { const b = [...document.querySelectorAll('.modal-overlay button, .confirm-modal button')].find(x => /Trotzdem/.test(x.textContent)); if (b) b.click(); });
    await sleep(500);
    await T.setOfflineMode(false);
    await sleep(300);
    await T.evaluate((i) => { location.hash = '/notes/' + i; }, note.id);
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    await sleep(1200);
    ok('beim nächsten Öffnen wird nachgereicht — Anna hat „Funkloch"', /Funkloch/.test(await editorText(A) || ''), await editorText(A));
    ok('… und die Sicherung auf dem Gerät ist danach weg', !(await T.evaluate((i) => localStorage.getItem('notiz-live:' + i), note.id)));

    console.log('\nFertig → zurück');
    await liste(T);
    await T.evaluate(() => window.scrollTo(0, 400));
    const vorOeffnen = await T.evaluate(() => window.scrollY);
    await T.evaluate(() => [...document.querySelectorAll('.note-card')].find(x => /Material Dienstag/.test(x.textContent)).querySelector('.note-open-btn').click());
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    await T.tap('#notiz-fertig');
    await T.waitForSelector('#note-list'); await sleep(700);
    const nachher = await T.evaluate(() => ({ hash: location.hash, y: window.scrollY }));
    ok('„← Fertig" führt in die Übersicht an dieselbe Stelle zurück', nachher.hash === '#/notes' && Math.abs(nachher.y - vorOeffnen) < 30 && vorOeffnen > 100,
      JSON.stringify({ vorOeffnen, ...nachher, scrollVorher }));
    await A.waitForFunction(() => !/Tom Kraus/.test(document.getElementById('notiz-anwesend').textContent), { timeout: 5000 }).catch(() => {});
    ok('… und für Anna ist Tom nicht mehr drin', !/Tom Kraus/.test(await A.evaluate(() => document.getElementById('notiz-anwesend').textContent)));

    console.log('\nFremder Text in der Vorschau');
    await T.evaluate(() => [...document.querySelectorAll('.note-card')].find(x => /Eingefügt/.test(x.textContent)).click());
    await sleep(400);
    const xss = await T.evaluate(() => ({ img: !!document.querySelector('.note-body-full img'), lauf: !!window.__xss,
      text: ([...document.querySelectorAll('.note-body-full')].map(b => b.textContent).join('|')) }));
    ok('HTML im Notiztext wird als Text gezeigt, nicht ausgeführt', !xss.img && !xss.lauf && /<img src=x/.test(xss.text), JSON.stringify(xss));

    console.log('\nNeue Notiz');
    await T.evaluate(() => window.scrollTo(0, 0));
    await T.tap('#fab-new');
    await T.waitForSelector('#nf-title');
    ok('Formular für neue Notiz: Titel und Projekt, kein Textfeld', await T.evaluate(() => !document.getElementById('nf-body') && !!document.getElementById('nf-project')));
    await T.type('#nf-title', 'Baustelle Halle 2');
    await T.tap('#note-form button[type="submit"]');
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    ok('„Erstellen und öffnen" → direkt in der Notiz', (await T.evaluate(() => document.getElementById('notiz-titel').value)) === 'Baustelle Halle 2' && /^#\/notes\/\d+$/.test(await T.evaluate(() => location.hash)));
    await T.evaluate(() => _notizSitzung.quill.focus());
    await T.keyboard.type('Erster Punkt');
    await sleep(1800);
    await T.tap('#notiz-fertig'); await T.waitForSelector('#note-list'); await sleep(500);
    ok('… geschrieben, „Fertig" — steht in der Übersicht', await T.evaluate(() => [...document.querySelectorAll('.note-card')].some(c => /Baustelle Halle 2/.test(c.textContent) && /Erster Punkt/.test(c.textContent))));

    ok('keine Skriptfehler in allen drei Browsern', jsFehler.length === 0, JSON.stringify(jsFehler));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  console.log(`\nLive-Notizen (Oberfläche): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
