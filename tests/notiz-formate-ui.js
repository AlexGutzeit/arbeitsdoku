// Schriftfarbe, Schriftgröße und Durchstreichen in Notizen — Oberfläche (24.11.2026).
//
// Anna am Handy (Touch), Tom am Rechner, beide in derselben Notiz. Geprüft wird, was man sieht:
//   * Knopfleiste: Durchstreichen, Größe und Farbe da, deutsch beschriftet, Tippziele groß genug.
//   * Antippen wirkt: Farbe/Größe/Strich am markierten Wort — bei Anna UND live bei Tom, mit der
//     tatsächlich angezeigten Farbe/Größe gemessen (nicht nur am Klassennamen).
//   * Gespeichert: die Formatierung steht im gespeicherten Stand, die Vorschau in der Übersicht zeigt sie.
//   * Einfügen aus einer Webseite mit fremden Farben/Größen: kommt als Text an, fremde Farben fallen
//     weg, der Server weist nichts ab (dieselbe Sitzung bleibt offen).
//   * Drucken zeigt die Farben.
//
//   node tests/notiz-formate-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const puppeteer = require('puppeteer');

const PORT = 3415, DB = '/tmp/notiz-formate-ui.db', LOG = '/tmp/notiz-formate-ui.log';
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
    for (const [u, n] of [['anna', 'Anna Berger'], ['tom', 'Tom Kraus']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user.id;
    }
    const tAnna = await tok('anna', 'Test1234!');
    const note = (await req('POST', '/api/notes', tAnna, { title: 'Baustelle Farben', body: 'Achtung Leitung\nAlt und weg' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, tAnna, { shares: [{ user_id: id.tom, permission: 'write' }] });

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
      await bereit(p);
    };
    const bereit = (p) => p.waitForFunction(() => /Gespeichert/.test((document.getElementById('notiz-status') || {}).textContent || ''), { timeout: 8000 });
    const markiere = (p, wort) => p.evaluate((w) => { const q = _notizSitzung.quill; q.focus(); q.setSelection(q.getText().indexOf(w), w.length, 'user'); }, wort);
    // Wie sieht ein Wort im Schreibfeld aus? (berechneter Stil des innersten Elements um das Wort)
    const aussehen = (p, wort) => p.evaluate((w) => {
      const feld = document.querySelector('.notiz-editor .ql-editor');
      const it = document.createTreeWalker(feld, NodeFilter.SHOW_TEXT);
      let n; while ((n = it.nextNode())) if (n.textContent.includes(w)) break;
      if (!n) return null;
      const el = n.parentElement, st = getComputedStyle(el);
      let durch = false; for (let e = el; e && e !== feld; e = e.parentElement) if (getComputedStyle(e).textDecorationLine.includes('line-through')) durch = true;
      return { farbe: st.color, groesse: parseFloat(st.fontSize), durch };
    }, wort);

    const A = await seite('anna', true), T = await seite('tom', false);
    await oeffnen(A); await oeffnen(T);

    console.log('\nKnopfleiste');
    const leiste = await A.evaluate(() => {
      const r = (s) => { const e = document.querySelector('#notiz-leiste ' + s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, sichtbar: e.checkVisibility() }; };
      const vorher = (s) => { const e = document.querySelector('#notiz-leiste ' + s); return e ? getComputedStyle(e, '::before').content : null; };
      return { strike: r('button.ql-strike'), groesse: r('.ql-size .ql-picker-label'), farbe: r('.ql-color .ql-picker-label'),
        groesseText: vorher('.ql-size .ql-picker-label'),
        eintraege: [...document.querySelectorAll('#notiz-leiste .ql-size .ql-picker-item')].map(i => i.getAttribute('aria-label')),
        farben: [...document.querySelectorAll('#notiz-leiste .ql-color .ql-picker-item')].map(i => i.getAttribute('aria-label')),
        namen: [...document.querySelectorAll('#notiz-leiste .ql-picker-label')].map(l => l.getAttribute('aria-label')) };
    });
    const gross = (x) => x && x.sichtbar && x.w >= 44 && x.h >= 44;
    ok('Durchstreichen, Größe und Farbe sichtbar, je mindestens 44 × 44 px', gross(leiste.strike) && gross(leiste.groesse) && gross(leiste.farbe), JSON.stringify(leiste));
    ok('Größe zeigt „Normal", Auswahl deutsch: Klein, Normal, Groß, Sehr groß',
      leiste.groesseText === '"Normal"' && JSON.stringify(leiste.eintraege) === '["Klein","Normal","Groß","Sehr groß"]', JSON.stringify([leiste.groesseText, leiste.eintraege]));
    ok('Farben: Standard + Rot, Orange, Grün, Blau, Lila, Grau; Listen benannt (Screenreader)',
      JSON.stringify(leiste.farben) === '["Standard","Rot","Orange","Grün","Blau","Lila","Grau"]' && JSON.stringify(leiste.namen) === '["Schriftgröße","Schriftfarbe"]',
      JSON.stringify([leiste.farben, leiste.namen]));

    console.log('\nAntippen wirkt — bei Anna und live bei Tom');
    const normal = await aussehen(A, 'Achtung');
    await markiere(A, 'Leitung');
    await A.tap('#notiz-leiste .ql-color .ql-picker-label'); await sleep(200);
    const felder = await A.evaluate(() => [...document.querySelectorAll('#notiz-leiste .ql-color .ql-picker-item')].map(i => { const b = i.getBoundingClientRect(); return { w: b.width, h: b.height, top: Math.round(b.top), sichtbar: i.checkVisibility(), bg: getComputedStyle(i).backgroundColor }; }));
    // Orange eigens: „orange" ist ein CSS-Farbname, den Quill als Inline-Farbe setzt — es kam Quills Hellorange
    // statt unseres Tons (gefunden am Bildschirmfoto). Und im Raster, nicht einzeln untereinander.
    ok('Farbfelder offen, groß genug für den Finger (≥ 32 px), in IHRER Farbe (auch Orange), mehrere je Reihe',
      felder.length === 7 && felder.every(f => f.sichtbar && f.w >= 32 && f.h >= 32) && felder[1].bg === 'rgb(220, 38, 38)'
        && felder[2].bg === 'rgb(194, 65, 12)' && felder[0].top === felder[3].top, JSON.stringify(felder.slice(0, 4)));
    await A.tap('#notiz-leiste .ql-color .ql-picker-item[data-value="rot"]'); await sleep(200);
    const strich = await A.evaluate(() => getComputedStyle(document.querySelector('#notiz-leiste .ql-color .ql-color-label')).stroke);
    ok('Strich unter dem „A" zeigt jetzt Rot', strich === 'rgb(220, 38, 38)', strich);
    await markiere(A, 'Achtung');
    await A.tap('#notiz-leiste .ql-size .ql-picker-label'); await sleep(200);
    await A.tap('#notiz-leiste .ql-size .ql-picker-item[data-value="huge"]'); await sleep(200);
    const groesseJetzt = await A.evaluate(() => getComputedStyle(document.querySelector('#notiz-leiste .ql-size .ql-picker-label'), '::before').content);
    await markiere(A, 'Alt und weg');
    await A.tap('#notiz-leiste button.ql-strike'); await sleep(200);
    const aA = { leitung: await aussehen(A, 'Leitung'), achtung: await aussehen(A, 'Achtung'), alt: await aussehen(A, 'Alt und weg') };
    ok('bei Anna: „Leitung" rot, „Achtung" 2,5-fach groß, „Alt und weg" durchgestrichen; Auswahl zeigt „Sehr groß"',
      aA.leitung.farbe === 'rgb(220, 38, 38)' && aA.achtung.groesse === normal.groesse * 2.5 && aA.alt.durch && !aA.leitung.durch
        && groesseJetzt === '"Sehr groß"', JSON.stringify({ aA, normal, groesseJetzt }));
    await T.waitForFunction(() => document.querySelector('.notiz-editor .ql-editor s'), { timeout: 5000 }).catch(() => {});
    const aT = { leitung: await aussehen(T, 'Leitung'), achtung: await aussehen(T, 'Achtung'), alt: await aussehen(T, 'Alt und weg'), normal: await aussehen(T, 'Leitung') };
    ok('bei Tom live genauso', aT.leitung.farbe === 'rgb(220, 38, 38)' && aT.achtung.groesse === 40 && aT.alt.durch, JSON.stringify(aT));
    // Farbe wieder weg: „Standard"
    await markiere(T, 'Leitung');
    await T.click('#notiz-leiste .ql-color .ql-picker-label'); await sleep(150);
    await T.click('#notiz-leiste .ql-color .ql-picker-item:not([data-value])'); await sleep(200);
    await A.waitForFunction(() => !document.querySelector('.notiz-editor .ql-editor .ql-color-rot'), { timeout: 5000 }).catch(() => {});
    ok('„Standard" nimmt die Farbe wieder weg — auch bei Anna', (await aussehen(A, 'Leitung')).farbe === normal.farbe, JSON.stringify(await aussehen(A, 'Leitung')));
    await markiere(T, 'Leitung');
    await T.click('#notiz-leiste .ql-color .ql-picker-label'); await sleep(150);
    await T.click('#notiz-leiste .ql-color .ql-picker-item[data-value="blau"]'); await sleep(200);
    await bereit(A); await bereit(T);

    console.log('\nEinfügen aus einer Webseite');
    await A.evaluate(() => { window.__sitzungVorher = _notizSitzung; const q = _notizSitzung.quill; q.setSelection(q.getLength() - 1, 0, 'user');
      const dt = new DataTransfer();
      dt.setData('text/html', '<p><span style="color:#ff00ff;font-size:40px">pink</span> <span class="ql-color-red ql-size-huge">rotfremd</span> '
        + '<span class="ql-color-gruen">gruenrichtig</span> <s>alt</s> <font color="red" size="7">font</font></p>');
      dt.setData('text/plain', 'pink rotfremd gruenrichtig alt font');
      document.querySelector('.notiz-editor .ql-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(2200);
    const nachEinfuegen = await A.evaluate(() => ({ offen: _notizSitzung === window.__sitzungVorher && _notizSitzung.offen,
      status: document.getElementById('notiz-status').textContent,
      attrs: _notizSitzung.quill.getContents().ops.filter(o => /pink|rotfremd|gruenrichtig|alt|font/.test(o.insert)).map(o => [o.insert, o.attributes || {}]) }));
    const attrVon = (w) => (nachEinfuegen.attrs.find(([t]) => t.includes(w)) || [])[1] || {};
    ok('fremde Farben/Größen fallen weg, eigene Farbe und Durchstreichen bleiben',
      !attrVon('pink').color && !attrVon('pink').size && !attrVon('rotfremd').color && attrVon('gruenrichtig').color === 'gruen' && attrVon('alt').strike === true && !attrVon('font').color,
      JSON.stringify(nachEinfuegen.attrs));
    ok('… und der Server hat nichts abgewiesen (dieselbe Sitzung, gespeichert)', nachEinfuegen.offen && /Gespeichert/.test(nachEinfuegen.status), JSON.stringify(nachEinfuegen));

    console.log('\nGespeichert und Vorschau');
    await sleep(2000);
    const gespeichert = ((await req('GET', '/api/notes', tAnna)).body.notes || []).find(n => n.id === note.id);
    const delta = JSON.parse(gespeichert.body_delta);
    const attr = (w) => (delta.find(o => typeof o.insert === 'string' && o.insert.includes(w)) || {}).attributes || {};
    ok('gespeicherter Stand: Achtung huge, Leitung blau, Alt und weg durchgestrichen',
      attr('Achtung').size === 'huge' && attr('Leitung').color === 'blau' && attr('Alt und weg').strike === true, gespeichert.body_delta);
    await A.tap('#notiz-fertig');
    await A.waitForSelector('.note-card');
    await A.evaluate((t) => { const k = [...document.querySelectorAll('.note-card')].find(c => c.textContent.includes(t)); k.querySelector('.note-title').click(); }, 'Baustelle Farben');
    await A.waitForSelector('.note-body-full .notiz-inhalt', { timeout: 5000 }).catch(() => {});
    const vorschau = await A.evaluate(() => {
      const box = document.querySelector('.note-body-full .notiz-inhalt'); if (!box) return null;
      const stil = (sel) => { const e = box.querySelector(sel); return e ? { farbe: getComputedStyle(e).color, groesse: parseFloat(getComputedStyle(e).fontSize), text: e.textContent } : null; };
      return { blau: stil('.ql-color-blau'), riesig: stil('.ql-size-huge'), durch: stil('s'), grund: parseFloat(getComputedStyle(box).fontSize) };
    });
    ok('Vorschau in der Übersicht: Farbe, Größe und Durchstreichen sichtbar',
      vorschau && vorschau.blau && vorschau.blau.farbe === 'rgb(29, 78, 216)' && vorschau.riesig && vorschau.riesig.groesse === vorschau.grund * 2.5
        && vorschau.durch && /Alt und weg/.test(vorschau.durch.text), JSON.stringify(vorschau));

    console.log('\nDrucken');
    await A.emulateMediaType('print');
    await A.evaluate(() => { window.print = () => {}; notizDrucken('Baustelle Farben', JSON.stringify([{ insert: 'Rot', attributes: { color: 'rot' } }, { insert: '\n' }])); });
    const druck = await A.evaluate(() => { const e = document.querySelector('#notiz-druck .ql-color-rot'); return e && e.checkVisibility() ? getComputedStyle(e).color : null; });
    ok('Druck: Farbe kommt aufs Papier', druck === 'rgb(220, 38, 38)', druck);
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
