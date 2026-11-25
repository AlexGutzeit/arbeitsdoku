// Zeichenflächen in Notizen — Oberfläche (24.11.2026).
//
// Anna am Handy (Finger), Tom am Rechner (Maus), Rita mit Leserecht. Geprüft wird, was man sieht und tut:
//   * Umschalter Text/Zeichnen; im Zeichenmodus ist das Schreibfeld gesperrt (keine Tastatur), die
//     Textknöpfe weg, die Werkzeuge da — am Handy in höchstens zwei Reihen.
//   * Umschalten legt die erste Fläche unter der Cursorzeile an; „＋ Fläche" weitere.
//   * Stift, Linie, Pfeil, Kasten, Kreis mit dem Finger; Farbe und Dicke; alles live beim anderen.
//   * Radierer, Rückgängig/Wiederholen (nur eigene Schritte — Toms Strich bleibt), Strg+Z am Rechner.
//   * Größe und Einzug ziehen; ist die Fläche breiter als das Handy, wird sie verkleinert gezeigt.
//   * Hand-Werkzeug und Textmodus zeichnen nicht; Löschen mit Rückfrage, Rückgängig holt sie zurück.
//   * Leserecht: sieht die Zeichnung, keine Leiste, keine Griffe.
//   * Kopierte Fläche wird nicht mit eingefügt; Vorschau in der Übersicht und Druck zeigen die Zeichnung.
//
//   node tests/notiz-zeichnen-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const PORT = 3417, DB = '/tmp/notiz-zeichnen-ui.db', LOG = '/tmp/notiz-zeichnen-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = require('./hilfen/chrome');
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
    const tAnna = await tok('anna', 'Test1234!');
    const note = (await req('POST', '/api/notes', tAnna, { title: 'Skizze Verteilung', body: 'Oben\nUnten' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }, { user_id: id.rita, permission: 'read' }] });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = async (u, handy) => {
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
    const oeffnen = async (p) => {
      await p.evaluate((i) => { location.hash = '/notes/' + i; }, note.id);
      await p.waitForSelector('.notiz-editor .ql-editor');
      await p.waitForFunction(() => /Gespeichert|Nur lesen/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    };
    // Antippen/Klicken eines Knopfs — mit Pause: Der Browser schickt den Klick nach einem Tap etwas
    // später, und direkt danach anzufangen zu zeichnen, schafft auch kein Mensch.
    // Am Handy wie ein Finger: kurz (80 ms) auflegen. Puppeteers tap() legt in derselben Millisekunde auf und
    // ab — nach einem Zeichenzug erkannte Chrome das jedes zweite Mal nicht als Tippen (kein click).
    const druecke = async (p, sel) => {
      if (!p.__handy) { await p.click(sel); await sleep(350); return; }
      const m = await p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' });
        const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
      if (!m) throw new Error('nicht da: ' + sel);
      const cdp = p.__cdp || (p.__cdp = await p.target().createCDPSession());
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [m] });
      await sleep(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(350);
    };
    // Ein Zug auf der n-ten Fläche: Punkte als Anteile der Fläche (0..1). Handy: Finger, Rechner: Maus.
    const zug = async (p, punkte, n = 0) => {
      const r = await p.evaluate((i) => { const s = document.querySelectorAll('.notiz-editor .nz-svg')[i]; s.scrollIntoView({ block: 'center' });
        const b = s.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, n);
      const xy = punkte.map(([fx, fy]) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h }));
      if (p.__handy) {
        const cdp = p.__cdp || (p.__cdp = await p.target().createCDPSession());
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [xy[0]] });
        for (const q of xy.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [q] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await p.mouse.move(xy[0].x, xy[0].y); await p.mouse.down();
        for (const q of xy.slice(1)) await p.mouse.move(q.x, q.y, { steps: 2 });
        await p.mouse.up();
      }
      await sleep(400);
    };
    const welle = Array.from({ length: 30 }, (_, i) => [0.05 + i * 0.025, 0.3 + Math.sin(i / 3) * 0.12]);
    const formen = (p, n = 0) => p.evaluate((i) => { const g = document.querySelectorAll('.notiz-editor .nz-striche')[i];
      return g ? [...g.children].map(c => c.tagName + (c.getAttribute('stroke') ? ':' + c.getAttribute('stroke') + ':' + c.getAttribute('stroke-width') : '')) : null; }, n);
    const flaechen = (p) => p.evaluate(() => document.querySelectorAll('.notiz-editor .notiz-zeichnung').length);
    const warteBis = (p, fn, arg) => p.waitForFunction(fn, { timeout: 6000 }, arg).catch(() => {});

    const A = await seite('anna', true); A.__handy = true;
    const T = await seite('tom', false), R = await seite('rita', true); R.__handy = true;
    await oeffnen(A); await oeffnen(T); await oeffnen(R);

    console.log('\nUmschalter');
    const sicht = (p) => p.evaluate(() => {
      const v = (s) => { const e = document.querySelector('#notiz-leiste ' + s); return !!e && e.checkVisibility(); };
      return { umschalter: v('.nz-modus'), text: document.querySelector('.nz-modus-knopf[data-modus="text"]').getAttribute('aria-pressed'),
        fett: v('.ql-bold'), stift: v('[data-werkzeug="frei"]'), neu: v('[data-akt="neu"]'),
        tippbar: document.querySelector('.notiz-editor .ql-editor').getAttribute('contenteditable'),
        hoehe: document.getElementById('notiz-leiste').getBoundingClientRect().height };
    });
    const s0 = await sicht(A);
    ok('Anfang: Umschalter sichtbar, „Text" an, Textknöpfe da, Zeichenwerkzeuge nicht', s0.umschalter && s0.text === 'true' && s0.fett && !s0.stift && !s0.neu && s0.tippbar === 'true', JSON.stringify(s0));
    await A.evaluate(() => { const q = _notizSitzung.quill; q.focus(); q.setSelection(2, 0, 'user'); });   // Cursor in „Oben"
    await druecke(A, '.nz-modus-knopf[data-modus="zeichnen"]');
    await warteBis(A, () => document.querySelector('.notiz-editor .notiz-zeichnung .nz-svg'));
    const s1 = await sicht(A);
    ok('Zeichnen: Schreibfeld gesperrt (keine Tastatur), Textknöpfe weg, Werkzeuge da', s1.text === 'false' && !s1.fett && s1.stift && s1.neu && s1.tippbar === 'false', JSON.stringify(s1));
    ok('… am Handy höchstens zwei Reihen Knöpfe (≤ 110 px)', s1.hoehe <= 110, String(s1.hoehe));
    const reihenfolge = await A.evaluate(() => [...document.querySelector('.notiz-editor .ql-editor').children].map(e => e.classList.contains('notiz-zeichnung') ? '[Fläche]' : e.textContent));
    ok('die erste Fläche entsteht von selbst — unter der Zeile mit dem Cursor', JSON.stringify(reihenfolge) === '["Oben","[Fläche]","Unten"]', JSON.stringify(reihenfolge));
    await warteBis(T, () => document.querySelector('.notiz-editor .notiz-zeichnung .nz-svg'));
    ok('… und bei Tom live (gleiche Stelle)', JSON.stringify(await T.evaluate(() => [...document.querySelector('.notiz-editor .ql-editor').children].map(e => e.classList.contains('notiz-zeichnung') ? '[Fläche]' : e.textContent))) === '["Oben","[Fläche]","Unten"]');

    console.log('\nZeichnen mit dem Finger');
    const lage = await A.evaluate(() => { const r = document.querySelector('.notiz-editor .nz-rahmen').getBoundingClientRect(), v = document.querySelector('.notiz-editor .nz-svg').getBoundingClientRect();
      return [r.top - v.top, r.left - v.left, r.width - v.width, r.height - v.height].map(x => Math.round(x)); });
    // Das Schreibfeld zeigt Leerraum an (pre-wrap): Zwischenraum im Baustein der Fläche wurde zur Leerzeile, die
    // Zeichenfläche rutschte 52 px unter ihren Rahmen, und Striche erschienen außerhalb (gefunden am Bild).
    ok('die Zeichenfläche liegt genau in ihrem Rahmen', JSON.stringify(lage) === '[0,0,0,0]', JSON.stringify(lage));
    // Quill soll Änderungen IN der Fläche nicht als mögliche Textänderung untersuchen (updateContent im Block) —
    // sonst liest es bei jedem Fingerzucken das ganze Dokument neu.
    await A.evaluate(() => { window.__quillPruefungen = 0; _notizSitzung.quill.emitter.on('scroll-update', () => window.__quillPruefungen++); });
    await zug(A, welle);
    ok('Quill untersucht die Fläche beim Zeichnen nicht (kein scroll-update)', await A.evaluate(() => window.__quillPruefungen) === 0, String(await A.evaluate(() => window.__quillPruefungen)));
    ok('Stift: ein Freihand-Strich (Pfad) bei Anna', JSON.stringify(await formen(A)) === '["path:#1e293b:4"]', JSON.stringify(await formen(A)));
    await warteBis(T, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length >= 1);
    ok('… live bei Tom', JSON.stringify(await formen(T)) === '["path:#1e293b:4"]', JSON.stringify(await formen(T)));
    for (const [w, punkte] of [['linie', [[0.1, 0.8], [0.4, 0.8]]], ['pfeil', [[0.1, 0.6], [0.3, 0.5], [0.5, 0.4]]], ['kasten', [[0.6, 0.1], [0.9, 0.5]]], ['kreis', [[0.55, 0.55], [0.9, 0.95]]]]) {
      await druecke(A, `[data-werkzeug="${w}"]`);
      await zug(A, punkte);
    }
    // Zugleich die Probe fürs Antippen direkt nach einem Strich: Chrome verschluckte vorher jeden zweiten Tipp
    // (touch-action: none, „Schwung anhalten") — dann stünde hier zweimal dieselbe Form.
    const f1 = (await formen(A)).map(x => x.split(':')[0]);
    ok('Linie, Pfeil (Linie + Spitze), Kasten, Kreis', JSON.stringify(f1) === '["path","line","line","polygon","rect","ellipse"]', JSON.stringify(f1));
    await druecke(A, '.nz-stift-knopf');
    ok('Farbe und Dicke: Auswahl öffnet sich (7 Farben, 3 Dicken)', await A.evaluate(() => document.querySelector('.nz-stift-wahl').checkVisibility()
      && document.querySelectorAll('.nz-farbe').length === 7 && document.querySelectorAll('.nz-dicke').length === 3));
    // Die Auswahl war erst in eine 44-px-Spalte gequetscht (allgemeine max-width) und lief rechts aus dem Bild
    const wahlLage = await A.evaluate(() => { const w = document.querySelector('.nz-stift-wahl').getBoundingClientRect();
      const f = [...document.querySelectorAll('.nz-farbe')].map(e => Math.round(e.getBoundingClientRect().top));
      return { links: w.left, rechts: w.right, breit: innerWidth, ersteReihe: f.filter(t => t === f[0]).length }; });
    ok('… ganz im Bild, die Farben nebeneinander (nicht untereinander)', wahlLage.links >= 0 && wahlLage.rechts <= wahlLage.breit && wahlLage.ersteReihe >= 5, JSON.stringify(wahlLage));
    await druecke(A, '.nz-farbe[data-farbe="rot"]');
    await druecke(A, '.nz-dicke[data-dicke="8"]');
    ok('… Dicke gewählt schließt die Auswahl; Knopf zeigt Rot', await A.evaluate(() => !document.querySelector('.nz-stift-wahl').checkVisibility()
      && getComputedStyle(document.querySelector('.nz-stift-punkt')).backgroundColor === 'rgb(220, 38, 38)'));
    await druecke(A, '[data-werkzeug="frei"]');
    await zug(A, [[0.2, 0.15], [0.3, 0.2], [0.4, 0.15]]);
    const letzte = (await formen(A)).slice(-1)[0];
    ok('nächster Strich rot und dick', letzte === 'path:#dc2626:8', letzte);
    ok('Stift-Einstellung gemerkt (je Gerät)', await A.evaluate(() => localStorage.getItem('notiz-stift')) === '{"farbe":"rot","dicke":8}');
    await warteBis(T, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length === 7);
    ok('alles live bei Tom (7 Elemente)', (await formen(T)).length === 7, JSON.stringify(await formen(T)));

    console.log('\nRadieren und Rückgängig');
    await druecke(A, '[data-werkzeug="radierer"]');
    await zug(A, [[0.25, 0.05], [0.25, 0.25], [0.25, 0.45]]);   // quer über die Welle und den roten Strich
    const nachRadieren = await formen(A);
    ok('Radierer: Welle und roter Strich weg, die Formen bleiben', nachRadieren.length === 5 && !nachRadieren.some(x => x.startsWith('path')), JSON.stringify(nachRadieren));
    await warteBis(T, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length === 5);
    ok('… auch bei Tom', (await formen(T)).length === 5);
    // Tom zeichnet eine Linie (Maus)
    await druecke(T, '.nz-modus-knopf[data-modus="zeichnen"]');
    ok('Tom schaltet um: keine zweite Fläche, weil schon eine da ist', (await flaechen(T)) === 1);
    await druecke(T, '[data-werkzeug="linie"]');
    await zug(T, [[0.05, 0.95], [0.95, 0.95]]);
    await warteBis(A, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length === 6);
    ok('Toms Linie (Maus) kommt bei Anna an', (await formen(A)).length === 6);
    await druecke(A, '[data-akt="rückgängig"]');
    const nachUndo = await formen(A);
    ok('Anna: Rückgängig holt IHR Radieren zurück — Toms Linie bleibt', nachUndo.length === 8 && nachUndo.filter(x => x.startsWith('path')).length === 2, JSON.stringify(nachUndo));
    await druecke(A, '[data-akt="wiederholen"]');
    ok('Wiederholen radiert wieder', (await formen(A)).length === 6);
    await T.click('.notiz-editor .ql-editor');   // Fokus irgendwo auf der Seite
    await T.keyboard.down('Control'); await T.keyboard.press('z'); await T.keyboard.up('Control'); await sleep(400);
    ok('Tom: Strg+Z nimmt seine Linie zurück', (await formen(T)).length === 5, JSON.stringify(await formen(T)));
    await warteBis(A, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length === 5);

    console.log('\nGröße und Einzug');
    const mass = (p) => p.evaluate(() => { const r = document.querySelector('.notiz-editor .nz-rahmen').getBoundingClientRect();
      const vb = document.querySelector('.notiz-editor .nz-svg').getAttribute('viewBox').split(' ').map(Number);
      return { w: r.width, h: r.height, links: r.left - document.querySelector('.notiz-editor .notiz-zeichnung').getBoundingClientRect().left, b: vb[2], hh: vb[3],
        platz: document.querySelector('.notiz-editor .notiz-zeichnung').clientWidth }; });
    const vorGr = await mass(A);
    const ziehe = async (p, sel, dx, dy) => {
      const g = await p.evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
      if (p.__handy) {
        const cdp = p.__cdp; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [g] });
        for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g.x + dx * i / 5, y: g.y + dy * i / 5 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else { await p.mouse.move(g.x, g.y); await p.mouse.down(); await p.mouse.move(g.x + dx, g.y + dy, { steps: 5 }); await p.mouse.up(); }
      await sleep(500);
    };
    await ziehe(A, '.nz-griff-groesse', 100, 80);
    const nachGr = await mass(A);
    ok('Größe ziehen am Handy: 80 px höher; breiter als die Zeile geht nicht', Math.abs(nachGr.hh - vorGr.hh - 80) <= 2 && nachGr.w <= nachGr.platz + 1, JSON.stringify({ vorGr, nachGr }));
    await warteBis(T, (h) => document.querySelector('.notiz-editor .nz-svg').getAttribute('viewBox').endsWith(' ' + h), nachGr.hh);
    const tGr = await mass(T);
    ok('… Tom sieht die neue Höhe; am Rechner in voller Größe (Maßstab 1)', tGr.hh === nachGr.hh && Math.abs(tGr.w - tGr.b) <= 1, JSON.stringify(tGr));
    await ziehe(T, '.nz-griff-groesse', 400, 0);   // Tom macht sie am Rechner breiter als ein Handy
    await ziehe(T, '.nz-griff-schieben', 60, 0);
    const tNeu = await mass(T);
    ok('Tom: 400 px breiter und 60 px eingerückt', Math.abs(tNeu.b - tGr.b - 400) <= 2 && Math.abs(tNeu.links - 60) <= 2, JSON.stringify(tNeu));
    await warteBis(A, (b) => document.querySelector('.notiz-editor .nz-svg').getAttribute('viewBox').split(' ')[2] === String(b), tNeu.b);
    const aNeu = await mass(A);
    ok('Anna am Handy: dieselbe Fläche verkleinert, passt samt Einzug in die Zeile, Seitenverhältnis gleich',
      aNeu.b === tNeu.b && aNeu.links + aNeu.w <= aNeu.platz + 2 && aNeu.links > 0 && Math.abs(aNeu.w / aNeu.h - aNeu.b / aNeu.hh) < 0.03, JSON.stringify(aNeu));

    console.log('\nHand und Textmodus zeichnen nicht');
    const anzahl = async () => (await formen(A)).length;
    const vorHand = await anzahl();
    await druecke(A, '[data-werkzeug="hand"]');
    ok('Hand: Fläche lässt Wischen zum Scrollen durch (touch-action)', await A.evaluate(() => getComputedStyle(document.querySelector('.notiz-editor .nz-svg')).touchAction) === 'auto');
    await druecke(A, '[data-werkzeug="frei"]');
    ok('Stift: Fläche fängt Wischen ab (touch-action none)', await A.evaluate(() => getComputedStyle(document.querySelector('.notiz-editor .nz-svg')).touchAction) === 'none');
    await druecke(A, '.nz-modus-knopf[data-modus="text"]');
    await zug(A, welle);
    const s2 = await sicht(A);
    ok('Textmodus: Wischen über die Fläche malt nichts, Schreibfeld wieder tippbar, keine Griffe',
      (await anzahl()) === vorHand && s2.tippbar === 'true' && s2.fett && !(await A.evaluate(() => document.querySelector('.nz-griff').checkVisibility())), JSON.stringify(s2));
    await A.evaluate(() => { const q = _notizSitzung.quill; q.focus(); q.setSelection(q.getLength() - 1, 0, 'user'); });
    await A.keyboard.type(' weiter');
    await warteBis(T, () => /Unten weiter/.test(document.querySelector('.notiz-editor .ql-editor').textContent));
    ok('… Tippen geht und kommt bei Tom an', await T.evaluate(() => /Unten weiter/.test(document.querySelector('.notiz-editor .ql-editor').textContent)));

    console.log('\nLeserecht');
    await warteBis(R, () => document.querySelectorAll('.notiz-editor .nz-striche > *').length === 5);
    const rita = await R.evaluate(() => ({ striche: document.querySelectorAll('.notiz-editor .nz-striche > *').length,
      leiste: document.getElementById('notiz-leiste').checkVisibility(), griffe: [...document.querySelectorAll('.nz-griff')].some(g => g.checkVisibility()) }));
    ok('Rita sieht die Zeichnung live, aber keine Leiste und keine Griffe', rita.striche === 5 && !rita.leiste && !rita.griffe, JSON.stringify(rita));

    console.log('\nNeue Fläche, Löschen, Einfügen');
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(0, 0, 'user'); });   // Cursor in „Oben"
    await druecke(A, '.nz-modus-knopf[data-modus="zeichnen"]');
    ok('zurück im Zeichenmodus: keine neue Fläche von selbst (es gibt schon eine)', (await flaechen(A)) === 1);
    await druecke(A, '[data-akt="neu"]');
    await warteBis(A, () => document.querySelectorAll('.notiz-editor .notiz-zeichnung').length === 2);
    const r2 = await A.evaluate(() => [...document.querySelector('.notiz-editor .ql-editor').children].map(e => e.classList.contains('notiz-zeichnung') ? '[Fläche]' : e.textContent));
    ok('„＋ Fläche": zweite Fläche unter „Oben" (über der ersten)', JSON.stringify(r2) === '["Oben","[Fläche]","[Fläche]","Unten weiter"]', JSON.stringify(r2));
    await zug(A, [[0.2, 0.2], [0.6, 0.6]], 0);
    await A.evaluate(() => document.querySelector('.notiz-editor .notiz-zeichnung .nz-griff-loeschen').scrollIntoView({ block: 'center' }));
    await druecke(A, '.notiz-editor .notiz-zeichnung .nz-griff-loeschen');
    const frage = await A.evaluate(() => (document.querySelector('.modal-overlay .modal-body') || {}).textContent || '');
    ok('Löschen einer bemalten Fläche fragt nach', /Zeichenfläche/.test(frage), frage);
    await A.evaluate(() => document.querySelector('.modal-overlay [data-act="ok"]').click()); await sleep(500);
    ok('… gelöscht: eine Fläche übrig, bei Tom auch', (await flaechen(A)) === 1 && await T.waitForFunction(() => document.querySelectorAll('.notiz-editor .notiz-zeichnung').length === 1, { timeout: 5000 }).then(() => true, () => false));
    await druecke(A, '[data-akt="rückgängig"]');
    await warteBis(A, () => document.querySelectorAll('.notiz-editor .notiz-zeichnung').length === 2);
    ok('Rückgängig holt die gelöschte Fläche samt Strich zurück', (await flaechen(A)) === 2 && (await formen(A, 0)).length === 1, JSON.stringify(await formen(A, 0)));
    await druecke(A, '.nz-modus-knopf[data-modus="text"]');
    await A.evaluate(() => { window.__vorher = _notizSitzung; const q = _notizSitzung.quill; q.focus(); q.setSelection(q.getLength() - 1, 0, 'user');
      const dt = new DataTransfer();
      dt.setData('text/html', '<p>Kopie:</p>' + document.querySelector('.notiz-editor .notiz-zeichnung').outerHTML + '<p>Ende</p>');
      dt.setData('text/plain', 'Kopie: Ende');
      document.querySelector('.notiz-editor .ql-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    await sleep(1500);
    const eingefuegt = await A.evaluate(() => ({ flaechen: document.querySelectorAll('.notiz-editor .notiz-zeichnung').length, text: document.querySelector('.notiz-editor .ql-editor').textContent,
      gleich: _notizSitzung === window.__vorher, status: document.getElementById('notiz-status').textContent }));
    ok('eine kopierte Fläche wird nicht mit eingefügt (der Text schon), keine Abweisung', eingefuegt.flaechen === 2 && /Kopie:/.test(eingefuegt.text) && /Ende/.test(eingefuegt.text)
      && eingefuegt.gleich && /Gespeichert/.test(eingefuegt.status), JSON.stringify(eingefuegt));

    console.log('\nVorschau und Druck');
    await sleep(2000);
    await A.tap('#notiz-fertig');
    await A.waitForSelector('.note-card');
    await A.evaluate(() => document.querySelector('.note-card .note-title').click());
    await warteBis(A, () => document.querySelector('.note-body-full .notiz-inhalt'));
    const vorschau = await A.evaluate(() => [...document.querySelectorAll('.note-body-full .notiz-zeichnung-bild')].map(b => ({
      striche: b.querySelectorAll('svg > *').length, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, sichtbar: b.checkVisibility() })));
    ok('Vorschau: beide Zeichnungen mit ihren Strichen, sichtbar und nicht breiter als die Karte',
      vorschau.length === 2 && vorschau.every(v => v.sichtbar && v.w > 50 && v.h > 30 && v.w <= 360) && vorschau.map(v => v.striche).sort().join() === '1,5', JSON.stringify(vorschau));
    await A.emulateMediaType('print');
    await A.evaluate((d) => { window.print = () => {}; notizDrucken('Skizze', d); }, (await req('GET', '/api/notes', tAnna)).body.notes.find(n => n.id === note.id).body_delta);
    const druck = await A.evaluate(() => [...document.querySelectorAll('#notiz-druck .notiz-zeichnung-bild svg')].filter(s => s.checkVisibility()).length);
    ok('Druck: beide Zeichnungen auf dem Papier', druck === 2, String(druck));
    await A.emulateMediaType('screen');

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) { fail++; fails.push('Ausnahme: ' + e.message); console.log(e); }
  finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
