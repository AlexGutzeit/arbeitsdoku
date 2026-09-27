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
  // Ganzes sichtbares Bild, dann zuschneiden — ein clip-Foto löst ein resize aus (siehe farbeSichtbar)
  const ganz = await p.screenshot({ captureBeyondViewport: false });
  const bild = await sharp(ganz).extract({ left: Math.max(0, Math.round(r.x - 1)), top: Math.round(r.y + 2), width: Math.round(r.w + 2), height: Math.max(4, Math.round(r.h - 4)) }).toBuffer();
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
        && /Du/.test(document.getElementById('notiz-anwesend').textContent) && document.getElementById('notiz-leiste').checkVisibility())
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
    // fett – wieder entfetten – fett: Das Entfernen einer Formatierung muss der Server annehmen
    await A.tap('#notiz-leiste .ql-bold'); await sleep(300);
    await A.tap('#notiz-leiste .ql-bold'); await sleep(300);
    await A.tap('#notiz-leiste .ql-bold'); await sleep(600);
    const nachUmschalten = await A.evaluate(() => ({ status: document.getElementById('notiz-status').textContent,
      toast: (document.querySelector('.toast.show') || {}).textContent || '', offen: !!_notizSitzung && _notizSitzung.offen }));
    ok('fett → entfetten → fett über die Knopfleiste: keine Abweisung, Sitzung bleibt offen',
      /Gespeichert|gespeichert/.test(nachUmschalten.status) && !nachUmschalten.toast && nachUmschalten.offen, JSON.stringify(nachUmschalten));
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
    await sleep(2200);   // gespeichert → Meldung an alle Browser → Zähler werden neu geholt
    const tomZaehler = await T.evaluate(() => { const b = document.getElementById('nav-badge-notes'); return b ? (b.style.display === 'none' ? 0 : Number(b.textContent)) : -1; });
    ok('Tom ist drin und sieht Annas Tippen live → sein Notizen-Zähler bleibt bei 0', tomZaehler === 0, String(tomZaehler));
    // Für Anna muss Tom als LETZTER tippen: Beim Speichern steht der zuletzt Tippende als Bearbeiter
    // drin, und eigene Änderungen zählen nie — so gemessen, prüfte die erste Fassung nichts
    // (Gegenprobe ohne Merker blieb grün).
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.keyboard.type(' Nachtrag');
    await sleep(2200);
    const annaZaehler = await A.evaluate(() => { const b = document.getElementById('nav-badge-notes'); return b ? (b.style.display === 'none' ? 0 : Number(b.textContent)) : -1; });
    const letzter = (await req('GET', '/api/notes', tAnna)).body.notes.find(n => n.id === note.id).updated_by;
    ok('… und bei Anna (Eigentümerin) ebenso, wenn Tom zuletzt getippt hat', annaZaehler === 0 && letzter === id.tom, JSON.stringify({ annaZaehler, letzter }));
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
    // Sichtbarkeit, nicht das Attribut: hidden allein half nicht, eine Stilregel überstimmte es (Bildschirmfoto 27.09.2026)
    const rZustand = await R.evaluate(() => ({ leiste: !document.getElementById('notiz-leiste').checkVisibility(), hinweis: document.getElementById('notiz-nur-lesen').checkVisibility(),
      tippbar: document.querySelector('.notiz-editor .ql-editor').getAttribute('contenteditable'), titel: document.getElementById('notiz-titel').disabled }));
    ok('Rita (nur lesen): keine Knopfleiste, Hinweis, Feld und Titel nicht bearbeitbar',
      rZustand.leiste && rZustand.hinweis && rZustand.tippbar === 'false' && rZustand.titel, JSON.stringify(rZustand));
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await A.keyboard.press('Enter'); await A.keyboard.type('Abzweigdosen');
    await sleep(900);
    ok('… liest aber live mit', /Abzweigdosen/.test(await editorText(R) || ''), await editorText(R));

    console.log('\nZwei Cursor an derselben Stelle (Fähnchen stapeln sich)');
    // Beide Namensfähnchen müssen zu SEHEN sein — nicht nur da (Alex am Bildschirmfoto, 27.09.2026)
    const fahnen = (p) => p.evaluate(() => [...document.querySelectorAll('.notiz-editor .ql-cursor-flag')].map(f => {
      const r = f.getBoundingClientRect(); const cs = getComputedStyle(f);
      return { name: f.textContent.trim(), o: cs.opacity, farbe: cs.backgroundColor, x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, rechts: r.right,
        oben: document.querySelector('.notiz-editor .ql-editor').getBoundingClientRect().top };
    }));
    // EIN Foto des sichtbaren Bereichs, ohne Umgröße, dann zuschneiden. Ein Ausschnitt-Foto
    // (clip) vergrößert die Seite kurz (captureBeyondViewport) — das löst ein resize aus, die Fähnchen
    // werden mitten im Foto neu gestapelt, und das Foto zeigt den Zwischenzustand (gemessen
    // 27.09.2026; echte Größenänderungen wie Tastatur auf oder Drehen stapeln korrekt).
    const farbeSichtbar = async (p, f) => {
      const ganz = await p.screenshot({ captureBeyondViewport: false });
      const bild = await sharp(ganz).extract({ left: Math.round(f.x + 2), top: Math.round(f.y + 2), width: Math.max(4, Math.round(f.w - 4)), height: Math.max(4, Math.round(f.h - 4)) }).toBuffer();
      const { data, info } = await sharp(bild).raw().toBuffer({ resolveWithObject: true });
      const [zr, zg, zb] = f.farbe.match(/\d+/g).map(Number);
      let n = 0; for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i] - zr) < 30 && Math.abs(data[i + 1] - zg) < 30 && Math.abs(data[i + 2] - zb) < 30) n++;
      return n > (data.length / info.channels) * 0.3;
    };
    const beideAn = async (index) => {
      for (const p of [A, T]) await p.evaluate((i) => _notizSitzung.quill.setSelection(i, 0, 'user'), index);
      await sleep(700);
      const f = (await fahnen(R)).filter(x => x.o === '1');
      const getrennt = f.length === 2 && !(f[0].x < f[1].rechts && f[1].x < f[0].rechts && f[0].y < f[1].b && f[1].y < f[0].b);
      const farben = f.length === 2 && (await farbeSichtbar(R, f[0])) && (await farbeSichtbar(R, f[1]));
      return { f, getrennt, farben };
    };
    const mitte = await beideAn(await A.evaluate(() => _notizSitzung.quill.getText().indexOf('Wago') + 4));
    ok('mitten im Text: beide Fähnchen sichtbar, überdecken sich nicht, beide Farben zu sehen',
      mitte.getrennt && mitte.farben && mitte.f.map(x => x.name).sort().join('|') === 'Anna Berger|Tom Kraus', JSON.stringify(mitte.f.map(x => [x.name, Math.round(x.y), Math.round(x.h)])));
    await sleep(3200);   // Fähnchen blenden aus
    const zeile1 = await beideAn(2);
    ok('in der ersten Zeile: ebenso — und keins ragt über den Anfang des Schreibfelds hinaus',
      zeile1.getrennt && zeile1.farben && zeile1.f.every(x => x.y >= x.oben - 4), JSON.stringify({ getrennt: zeile1.getrennt, farben: zeile1.farben, f: zeile1.f.map(x => [x.name, Math.round(x.y), Math.round(x.h), Math.round(x.oben), x.farbe]) }));
    await sleep(3200);
    // Nicht an derselben Stelle, aber so nah, dass die Schilder sich berühren würden (Alex, 27.09.2026)
    const nah = await (async () => {
      const i = await A.evaluate(() => _notizSitzung.quill.getText().indexOf('Wago') + 1);
      await A.evaluate((x) => _notizSitzung.quill.setSelection(x, 0, 'user'), i);
      await T.evaluate((x) => _notizSitzung.quill.setSelection(x, 0, 'user'), i + 2);
      await sleep(700);
      const f = (await fahnen(R)).filter(x => x.o === '1');
      return { f, getrennt: f.length === 2 && !(f[0].x < f[1].rechts && f[1].x < f[0].rechts && f[0].y < f[1].b && f[1].y < f[0].b),
        farben: f.length === 2 && (await farbeSichtbar(R, f[0])) && (await farbeSichtbar(R, f[1])) };
    })();
    ok('zwei Zeichen auseinander: Schilder würden sich berühren → sie stapeln sich, beide lesbar', nah.getrennt && nah.farben,
      JSON.stringify(nah.f.map(x => [x.name, Math.round(x.x), Math.round(x.y)])));
    await sleep(3200);
    // Weit auseinander in derselben Zeile: nichts verschieben, was nicht muss
    // Die Stelle wird in Ritas Ansicht GEMESSEN: dieselbe Bildschirmzeile, mindestens 170 px weiter
    // rechts. (Erste Fassung nahm das Zeilenende — die Zeile bricht am Handy um, Tom stand eine
    // Bildschirmzeile tiefer, und die Probe „in derselben Zeile immer stapeln" blieb grün.)
    const weit = await (async () => {
      const [ia, it] = await R.evaluate(() => {
        // +3, nicht +1: Anna stand vom Fall davor schon auf +1 — ohne Bewegung erscheint ihr Schild nicht,
        // und die Prüfung hätte nur ein Schild gesehen (Probe „immer stapeln" blieb deshalb grün)
        const q = _notizSitzung.quill, a = q.getText().indexOf('Wago') + 3, ba = q.getBounds(a);
        let b = -1;
        for (let i = a + 1; i < q.getLength(); i++) { const bi = q.getBounds(i); if (bi.top !== ba.top) break; if (bi.left - ba.left >= 170) { b = i; break; } }
        return [a, b];
      });
      await A.evaluate((x) => _notizSitzung.quill.setSelection(x, 0, 'user'), ia);
      await T.evaluate((x) => _notizSitzung.quill.setSelection(x, 0, 'user'), it);
      await sleep(700);
      const f = await fahnen(R);
      return { it, rand: await R.evaluate(() => [...document.querySelectorAll('.notiz-editor .ql-cursor-flag')].map(x => x.style.marginTop)),
        gleicheZeile: f.length === 2 && Math.abs(f[0].y - f[1].y) < 2, beideSichtbar: f.length === 2 && f.every(x => x.o === '1') };
    })();
    ok('weit auseinander in derselben Bildschirmzeile: kein Schild wird verschoben',
      weit.it > 0 && weit.beideSichtbar && weit.rand.length === 2 && weit.rand.every(m => !m) && weit.gleicheZeile, JSON.stringify(weit));

    console.log('\nHaken „Namensschilder anzeigen"');
    // Striche: Bildpunkte in der Farbe der Person an ihrem Cursor-Strich (Farbe steht am — auch
    // ausgeblendeten — Fähnchen)
    const striche = async (p) => {
      const lagen = await p.evaluate(() => [...document.querySelectorAll('.notiz-editor .ql-cursor')].map(c => {
        const r = c.querySelector('.ql-cursor-caret').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, farbe: getComputedStyle(c.querySelector('.ql-cursor-flag')).backgroundColor };
      }));
      const ganz = await p.screenshot({ captureBeyondViewport: false });
      let sichtbar = 0;
      for (const l of lagen) {
        if (l.h < 4) continue;
        const { data, info } = await sharp(ganz).extract({ left: Math.max(0, Math.round(l.x - 1)), top: Math.round(l.y + 2), width: Math.round(l.w + 2), height: Math.round(l.h - 4) }).raw().toBuffer({ resolveWithObject: true });
        const [zr, zg, zb] = l.farbe.match(/\d+/g).map(Number);
        let n = 0; for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i] - zr) < 40 && Math.abs(data[i + 1] - zg) < 40 && Math.abs(data[i + 2] - zb) < 40) n++;
        if (n >= 3) sichtbar++;
      }
      return sichtbar;
    };
    const fahnenSichtbar = (p) => p.evaluate(() => [...document.querySelectorAll('.notiz-editor .ql-cursor-flag')].filter(f => f.checkVisibility({ checkOpacity: true })).length);
    await sleep(3200);
    await R.tap('#notiz-namen');
    // an verschiedene Stellen — an derselben lägen die zwei 2-px-Striche übereinander
    await A.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getText().indexOf('Wago') + 1, 0, 'user'); });
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getText().indexOf('Wago') + 8, 0, 'user'); });
    await sleep(700);
    ok('Haken aus: kein Namensfähnchen zu sehen, beide farbigen Striche schon', (await fahnenSichtbar(R)) === 0 && (await striche(R)) === 2,
      JSON.stringify({ fahnen: await fahnenSichtbar(R), striche: await striche(R) }));
    await R.reload({ waitUntil: 'domcontentloaded' }); await R.waitForSelector('.notiz-editor .ql-editor'); await bereit(R);
    ok('… nach dem Neuladen bleibt der Haken aus (auf dem Gerät gemerkt)',
      await R.evaluate(() => !document.getElementById('notiz-namen').checked && document.querySelector('.notiz-editor').classList.contains('ohne-namen')));
    await R.tap('#notiz-namen');
    for (const p of [A, T]) await p.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getText().indexOf('Abzweig') + 3, 0, 'user'); });
    await sleep(700);
    ok('Haken wieder an: die Fähnchen erscheinen wieder', (await fahnenSichtbar(R)) === 2, String(await fahnenSichtbar(R)));

    console.log('\nTitel');
    await A.evaluate(() => { const t = document.getElementById('notiz-titel'); t.focus(); t.select(); });
    await A.keyboard.type('Material Dienstag');
    await sleep(1600);
    ok('Anna benennt um → Tom sieht den neuen Titel sofort', (await T.evaluate(() => document.getElementById('notiz-titel').value)) === 'Material Dienstag');

    console.log('\nRechte ändern, während man drin ist');
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'read' }] });
    await T.waitForFunction(() => !document.getElementById('notiz-leiste').checkVisibility(), { timeout: 5000 }).catch(() => {});
    ok('Tom wird auf Lesen gestuft → Knopfleiste weg, Feld gesperrt, Hinweis',
      await T.evaluate(() => !document.getElementById('notiz-leiste').checkVisibility() && document.querySelector('.notiz-editor .ql-editor').getAttribute('contenteditable') === 'false'
        && /nur noch lesen/.test((document.querySelector('.toast') || {}).textContent || '')));
    await R.waitForFunction(() => location.hash === '#/notes', { timeout: 5000 }).catch(() => {});
    ok('Rita verliert die Freigabe → zurück in der Übersicht mit Hinweis',
      (await R.evaluate(() => location.hash)) === '#/notes' && /Freigabe/.test(await R.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')),
      await R.evaluate(() => location.hash + ' ' + ((document.querySelector('.toast') || {}).textContent || '')));
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }] });
    await T.waitForFunction(() => document.getElementById('notiz-leiste').checkVisibility(), { timeout: 5000 }).catch(() => {});

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

    console.log('\nEinfügen aus Word / Webseite / WhatsApp');
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.evaluate(() => {
      window.__sitzungVorher = _notizSitzung;   // nach einer Abweisung öffnete die App NEU — das soll auffallen
      const dt = new DataTransfer();
      dt.setData('text/html', '<h1>Lieferung</h1><p><a href="javascript:window.__xss2=1">Link</a> <span style="color:red">rot</span> <b>fett</b> <i>schräg</i></p>'
        + '<img src="x" onerror="window.__xss3=1"><ul><li>Punkt eins</li></ul><table><tr><td>Zelle</td></tr></table>');
      dt.setData('text/plain', 'Lieferung Link rot fett schräg Punkt eins Zelle');
      document.querySelector('.notiz-editor .ql-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(2200);
    const eingefuegt = await T.evaluate(() => ({
      status: document.getElementById('notiz-status').textContent, offen: _notizSitzung === window.__sitzungVorher && _notizSitzung.offen,
      html: document.querySelector('.notiz-editor .ql-editor').innerHTML, xss: !!(window.__xss2 || window.__xss3) }));
    const beiAnna = await A.evaluate(() => document.querySelector('.notiz-editor .ql-editor').innerHTML);
    ok('eingefügter Text kommt an — nur erlaubte Formatierung (fett/kursiv/Liste), kein Link, kein Bild, keine Farbe',
      /Lieferung/.test(beiAnna) && /<strong>fett<\/strong>/.test(beiAnna) && /<em>schräg<\/em>/.test(beiAnna) && /Punkt eins/.test(beiAnna)
        && !/<a |<img|color|<h1|<table/i.test(beiAnna) && !eingefuegt.xss,
      beiAnna.slice(-400));
    ok('… und der Server hat nichts davon abgewiesen (dieselbe Sitzung, gespeichert)', eingefuegt.offen && /Gespeichert/.test(eingefuegt.status), JSON.stringify({ status: eingefuegt.status, offen: eingefuegt.offen }));

    console.log('\nRiesiger Text eingefügt');
    const annaVorher = await editorText(A);
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Ziemlich viel Text. '.repeat(5000));   // rund 100 KB
      document.querySelector('.notiz-editor .ql-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await T.waitForFunction(() => /zu groß/.test((document.querySelector('.toast') || {}).textContent || ''), { timeout: 5000 }).catch(() => {});
    await bereit(T).catch(() => {});
    await sleep(800);
    const gross = await T.evaluate(() => ({ toast: (document.querySelector('.toast') || {}).textContent || '', status: document.getElementById('notiz-status').textContent,
      laenge: _notizSitzung ? _notizSitzung.quill.getLength() : -1 }));
    ok('klare Meldung „zu groß", die Notiz öffnet sich neu ohne den Text — kein endloses „Keine Verbindung"',
      /zu groß/.test(gross.toast) && /Gespeichert/.test(gross.status) && gross.laenge < 5000, JSON.stringify(gross));
    ok('… bei den anderen ist nichts Halbes angekommen', (await editorText(A)) === annaVorher);

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

    console.log('\nNeuladen direkt nach dem Tippen („Jetzt aktualisieren", Tab zu)');
    await T.evaluate((i) => { location.hash = '/notes/' + i; }, note.id);
    await T.waitForSelector('.notiz-editor .ql-editor'); await bereit(T);
    // Antworten des Servers künstlich verzögern: So ist beim Neuladen sicher noch etwas unterwegs.
    await T.setRequestInterception(true);
    const bremse = r => (r.url().includes('/live/aenderung') ? setTimeout(() => r.continue().catch(() => {}), 1500) : r.continue().catch(() => {}));
    T.on('request', bremse);
    await T.evaluate(() => { const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await T.keyboard.type(' Eilig');
    await T.reload({ waitUntil: 'domcontentloaded' });
    T.off('request', bremse);
    await T.setRequestInterception(false);
    await T.waitForSelector('.notiz-editor .ql-editor', { timeout: 15000 }); await bereit(T);
    await A.waitForFunction(() => /Eilig/.test(document.querySelector('.notiz-editor .ql-editor').innerText), { timeout: 8000 }).catch(() => {});
    ok('nichts geht verloren — die letzten Tastendrücke kommen nach dem Neuladen an', /Eilig/.test(await editorText(A) || ''), (await editorText(A) || '').slice(-60));

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
