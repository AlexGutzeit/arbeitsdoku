// Zeichenflächen in Notizen — Server, Prüfung und Dateien (24.11.2026).
//
// Geprüft wird ohne Browser:
//   * Die Prüfung (zulaessig): eine echte Zeichnung geht durch; alles, was die Knopfleiste nicht kann
//     (fremde Blöcke, falsche Kennungen, fremde Felder, Farben, Dicken, Formen, Koordinaten, Größen,
//     Yjs-Typen an falscher Stelle), wird abgewiesen.
//   * Abgeleitete Spalten: Klartext „[Zeichnung]", body_delta mit Inhalt; Kopie aus body_delta baut
//     die Zeichnung vollständig wieder auf (Weitergeben, „Stand als eigene Notiz").
//   * Live über den Server: Zeichnung kommt beim anderen an, Manipuliertes nicht; Zeichnung am Schluss →
//     Zeilenende wird ergänzt; die ganze Notiz ist auf 2 MB begrenzt, Radieren gibt Platz frei.
//   * Dateien: PDF zeichnet die Formen (gerendert, Bildpunkte je Farbe gezählt), Word und ODT tragen sie
//     als Bild — LibreOffice öffnet beide und zeigt die Farben.
//
//   node tests/notiz-zeichnen.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { geraetOeffnen } = require('./hilfen/notiz-live-geraet');
const APP = path.join(__dirname, '..');
const dok = require(path.join(APP, 'notiz-dokument'));
const Z = require(path.join(APP, 'public/js/zeichnung'));
const exporte = require(path.join(APP, 'notiz-export'));
const Y = dok.Y;

const PORT = 3416, DB = '/tmp/notiz-zeichnen.db', LOG = '/tmp/notiz-zeichnen.log';
const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), 'notiz-zeichnen-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const hatProgramm = (p) => spawnSync('which', [p]).status === 0;

function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const st = []; x.on('data', c => st.push(c)); x.on('end', () => { const buf = Buffer.concat(st); let j = null; if (!roh) { try { j = JSON.parse(buf.toString()); } catch (_) {} }
        res({ status: x.statusCode, body: j, buf }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const STRICHE = [
  { k: 'frei0001', t: 'frei', f: 'schwarz', d: 4, p: [20, 60, 40, 80, 60, 60, 80, 80] },
  { k: 'pfeil001', t: 'pfeil', f: 'blau', d: 4, p: [40, 180, 220, 120] },
  { k: 'kast0001', t: 'kasten', f: 'rot', d: 8, p: [240, 40, 330, 150] },
  { k: 'kreis001', t: 'kreis', f: 'gruen', d: 2, p: [60, 110, 180, 200] },
];
// Ein Dokument mit Text, einer Zeichnung dazwischen und Text danach — wie es das Schreibfeld anlegt
function mitZeichnung(veraendern) {
  const doc = new Y.Doc(); const t = doc.getText(dok.TEXT); const karte = doc.getMap(dok.ZEICHNUNGEN);
  doc.transact(() => {
    t.insert(0, 'Oben\n');
    karte.set('flaeche00001', dok.neueZeichnung({ b: 342, h: 205, e: 10, s: STRICHE }));
    t.insertEmbed(5, { zeichnung: 'flaeche00001' });
    t.insert(6, 'Unten\n');
  });
  if (veraendern) doc.transact(() => veraendern(doc, t, karte, karte.get('flaeche00001')));
  const r = dok.zulaessig(doc); doc.destroy(); return r;
}

(async () => {
  console.log('\nPrüfung (zulaessig)');
  ok('Text + Zeichnung (alle Formen, Farben, Dicken) geht durch', mitZeichnung());
  ok('… auch formatiert (wer Text samt Fläche markiert und „fett" drückt)', mitZeichnung((d, t) => t.format(0, 8, { bold: true })));
  ok('… und mehrere Flächen, leere Fläche, Fläche ohne Text-Stelle (nach Rückgängig/Löschen)', mitZeichnung((d, t, k) => {
    k.set('flaeche00002', dok.neueZeichnung({ b: 80, h: 60, e: 0 })); t.insertEmbed(0, { zeichnung: 'flaeche00002' });
    k.set('verwaist0001', dok.neueZeichnung({ b: 2000, h: 3000, e: 1500 })); }));
  const falsch = {
    'fremde Wurzel im Dokument': (d) => d.getMap('anderes').set('x', 1),
    'fremder Block im Text (Bild)': (d, t) => t.insertEmbed(0, { image: 'https://x/y.png' }),
    'Block mit Zusatzfeld': (d, t) => t.insertEmbed(0, { zeichnung: 'flaeche00001', x: 1 }),
    'Kennung mit Sonderzeichen': (d, t) => t.insertEmbed(0, { zeichnung: 'a"><img' }),
    'Kennung als Objekt': (d, t) => t.insertEmbed(0, { zeichnung: { id: 'flaeche00001' } }),
    'Fläche ist kein Y.Map': (d, t, k) => k.set('flaeche00003', { b: 100, h: 100, e: 0 }),
    'Fläche mit fremdem Feld': (d, t, k, f) => f.set('farbe', 'rot'),
    'Breite zu klein': (d, t, k, f) => f.set('b', 10),
    'Höhe zu groß': (d, t, k, f) => f.set('h', 99999),
    'Einzug als Text': (d, t, k, f) => f.set('e', '10'),
    'Striche kein Y.Array': (d, t, k, f) => f.set('s', [STRICHE[0]]),
    'Strich mit Zusatzfeld': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], onclick: 'x' }]),
    'Strich: fremde Farbe': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', f: '#ff00ff' }]),
    'Strich: fremde Dicke': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', d: 5 }]),
    'Strich: unbekannte Form': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', t: 'text' }]),
    'Form mit drei Punkten': (d, t, k, f) => f.get('s').push([{ ...STRICHE[1], k: 'xxxx', p: [1, 2, 3, 4, 5, 6] }]),
    'Koordinate weit draußen': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', p: [1, 2, 99999, 4] }]),
    'Koordinate mit Komma': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', p: [1.5, 2] }]),
    'ungerade Punktzahl': (d, t, k, f) => f.get('s').push([{ ...STRICHE[0], k: 'xxxx', p: [1, 2, 3] }]),
    'Yjs-Typ statt Strich': (d, t, k, f) => f.get('s').push([new Y.Map()]),
    'Karte als Liste befüllt': (d) => { const k = d.getMap(dok.ZEICHNUNGEN); k._start = {}; },
  };
  const durch = Object.entries(falsch).filter(([, f]) => { try { return mitZeichnung(f); } catch (_) { return false; } }).map(([n]) => n);
  ok(`${Object.keys(falsch).length} Manipulationen werden abgewiesen`, durch.length === 0, JSON.stringify(durch));
  ok('mehr als 3000 Striche auf einer Fläche: abgewiesen', !mitZeichnung((d, t, k, f) =>
    f.get('s').push(Array.from({ length: 3000 }, (_, i) => ({ k: 'v' + String(i).padStart(4, '0'), t: 'frei', f: 'rot', d: 2, p: [1, 1] })))));

  console.log('\nAbgeleitete Spalten und Kopie');
  const doc = new Y.Doc(); const t = doc.getText(dok.TEXT);
  doc.transact(() => { t.insert(0, 'Oben\n'); doc.getMap(dok.ZEICHNUNGEN).set('flaeche00001', dok.neueZeichnung({ b: 342, h: 205, e: 10, s: STRICHE }));
    t.insertEmbed(5, { zeichnung: 'flaeche00001' }); t.insert(6, 'Unten\n'); });
  const f = dok.felder(doc);
  const zd = JSON.parse(f.body_delta)[1].insert.zeichnung;
  ok('Klartext: „[Zeichnung]" an ihrer Stelle (Suche, Push, MCP)', f.body === 'Oben\n[Zeichnung]\nUnten', JSON.stringify(f.body));
  ok('body_delta: Zeichnung mit Inhalt (Kennung, Größe, Einzug, Striche)', zd.id === 'flaeche00001' && zd.b === 342 && zd.h === 205 && zd.e === 10 && JSON.stringify(zd.s) === JSON.stringify(STRICHE), JSON.stringify(zd).slice(0, 200));
  const kopie = dok.zeileAusDelta(f.body_delta, f.body);
  const kDoc = dok.laden(kopie.ydoc);
  ok('Kopie aus body_delta: gleiche Spalten, Zeichnung wieder als Karte + Block, und zulässig',
    kopie.body === f.body && kopie.body_delta === f.body_delta && kDoc.getMap(dok.ZEICHNUNGEN).get('flaeche00001').get('s').length === 4 && dok.zulaessig(kDoc));
  const boese = JSON.stringify([{ insert: 'x\n' }, { insert: { zeichnung: { id: 'flaeche00009', b: 1e9, h: -5, s: [{ k: 'boese1', t: 'frei', f: 'pink', d: 4, p: [1, 1] }, STRICHE[0]] } } },
    { insert: { image: 'x' } }, { insert: { zeichnung: { id: '<script>' } } }]);
  const kb = dok.zeileAusDelta(boese, 'x');
  const kbDoc = dok.laden(kb.ydoc), kbF = kbDoc.getMap(dok.ZEICHNUNGEN).get('flaeche00009');
  ok('Kopie aus manipuliertem body_delta: Größe eingegrenzt, falsche Striche/Blöcke fallen weg, Ergebnis zulässig',
    dok.zulaessig(kbDoc) && kbF.get('b') === 2000 && kbF.get('h') === 60 && kbF.get('s').length === 1 && kbDoc.getMap(dok.ZEICHNUNGEN).size === 1,
    JSON.stringify(dok.felder(kbDoc)).slice(0, 300));
  const z2 = new Y.Doc(); z2.getText(dok.TEXT).insert(0, 'a\n'); z2.getText(dok.TEXT).insertEmbed(2, { zeichnung: 'flaeche00001' });
  ok('Zeichnung am Schluss: „endet mit Zeilenende" sieht den Block (toString() sähe ihn nicht)',
    !dok.endetMitZeilenende(z2.getText(dok.TEXT)) && z2.getText(dok.TEXT).toString().endsWith('\n'));

  console.log('\nLive über den Server');
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  const offen = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const n = {};
    for (const [u, name] of [['olga', 'Olga Eigen'], ['tom', 'Tom Mit']]) {
      n[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name, role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
      n[u].token = await tok(u, 'Test1234!');
    }
    const note = (await req('POST', '/api/notes', n.olga.token, { title: 'Skizze Keller', body: 'Oben' })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, n.olga.token, { shares: [{ user_id: n.tom.id, permission: 'write' }] });
    const ticket = async (u) => (await req('GET', '/api/events/ticket', u.token)).body.ticket;
    const geraet = async (u) => { const g = await geraetOeffnen({ port: PORT, ticket: await ticket(u), noteId: note.id, token: u.token }); offen.push(g); return g; };
    const O = await geraet(n.olga), T = await geraet(n.tom);

    const r1 = await O.schreibe(tx => {
      tx.doc.getMap('zeichnungen').set('flaeche00001', dok.neueZeichnung({ b: 342, h: 205, e: 0, s: STRICHE.slice(0, 2) }));
      tx.insertEmbed(tx.length, { zeichnung: 'flaeche00001' });   // ans Ende — OHNE Zeilenende danach
    });
    await T.warte('aenderung', () => T.doc.getMap('zeichnungen').has('flaeche00001'));
    await sleep(300);
    const tFl = T.doc.getMap('zeichnungen').get('flaeche00001');
    ok('Olga legt eine Fläche an: angenommen, Tom hat sie samt Strichen', r1.status === 200 && tFl && tFl.get('s').length === 2, JSON.stringify(r1));
    for (const g of [O, T]) if (!dok.endetMitZeilenende(g.doc.getText('notiz'))) await g.warte('aenderung', () => dok.endetMitZeilenende(g.doc.getText('notiz')));
    ok('Fläche am Schluss: der Server hängt das Zeilenende an — bei beiden', dok.endetMitZeilenende(O.doc.getText('notiz')) && dok.endetMitZeilenende(T.doc.getText('notiz')),
      JSON.stringify(T.doc.getText('notiz').toDelta()).slice(0, 200));
    const r2 = await T.schreibe(tx => tx.doc.getMap('zeichnungen').get('flaeche00001').get('s').push([STRICHE[2]]));
    await O.warte('aenderung', () => O.doc.getMap('zeichnungen').get('flaeche00001').get('s').length === 3);
    ok('Tom malt dazu: bei Olga live', r2.status === 200 && O.doc.getMap('zeichnungen').get('flaeche00001').get('s').length === 3);

    const B = await geraet(n.tom);
    const vorher = O.doc.getMap('zeichnungen').get('flaeche00001').get('s').length;
    const r3 = await B.schreibe(tx => tx.doc.getMap('zeichnungen').get('flaeche00001').get('s').push([{ ...STRICHE[0], k: 'boese001', f: 'url(#x)' }]));
    await sleep(600);
    ok('manipulierter Strich: abgewiesen (BESCHAEDIGT), bei Olga kommt nichts an', r3.status === 400 && r3.body.code === 'BESCHAEDIGT'
      && O.doc.getMap('zeichnungen').get('flaeche00001').get('s').length === vorher, JSON.stringify(r3.body));
    B.schliessen();

    await sleep(2200);   // Speichertakt 1,5 s
    const gespeichert = ((await req('GET', '/api/notes', n.olga.token)).body.notes || []).find(x => x.id === note.id);
    ok('gespeichert: Klartext mit „[Zeichnung]", body_delta mit den drei Strichen',
      /\[Zeichnung\]/.test(gespeichert.body) && JSON.parse(gespeichert.body_delta).some(op => op.insert && op.insert.zeichnung && op.insert.zeichnung.s.length === 3), gespeichert.body);
    const k = await req('POST', `/api/notes/${note.id}/kopie`, n.tom.token);
    ok('„Stand als eigene Notiz": die Kopie hat die Zeichnung mit', k.status === 201 && k.body.note.body_delta === gespeichert.body_delta);

    // Größengrenze: lauter lange Striche, bis die Notiz über 2 MB käme
    const lang = (i) => ({ k: 'l' + String(i).padStart(6, '0'), t: 'frei', f: 'rot', d: 2,
      p: Array.from({ length: 4000 }, (_, j) => 1000 + ((i * 7 + j * 13) % 2000)) });
    let r4 = null, runden = 0;
    for (; runden < 60; runden++) {
      r4 = await O.schreibe(tx => { const s = tx.doc.getMap('zeichnungen').get('flaeche00001').get('s'); for (let j = 0; j < 4; j++) s.push([lang(runden * 4 + j)]); });
      if (r4.status !== 200) break;
    }
    ok('ganze Notiz über 2 MB: abgewiesen mit „zu groß" (nach einigen Runden, nicht gleich)', r4.status === 413 && r4.body.code === 'ZU_GROSS' && runden > 5, JSON.stringify([runden, r4.body]));
    // Neues Gerät (das alte trägt die abgewiesene Änderung noch bei sich) — Radieren gibt Platz frei
    O.schliessen();
    const O2 = await geraet(n.olga);
    const r5 = await O2.schreibe(tx => { const s = tx.doc.getMap('zeichnungen').get('flaeche00001').get('s'); s.delete(3, s.length - 3); });
    const r6 = await O2.schreibe(tx => tx.doc.getMap('zeichnungen').get('flaeche00001').get('s').push([STRICHE[3]]));
    ok('nach dem Radieren passt wieder etwas hinein', r5.status === 200 && r6.status === 200, JSON.stringify([r5.body, r6.body]));
  } finally {
    for (const g of offen) g.schliessen();
    srv.kill();
    try { fs.unlinkSync(DB); } catch (_) {}
  }

  console.log('\nDateien');
  const welle = []; for (let i = 0; i <= 40; i++) welle.push(20 + i * 6, Math.round(60 + Math.sin(i / 4) * 30));
  const zeichnung = { id: 'flaeche00001', b: 342, h: 205, e: 40, s: [{ k: 'welle001', t: 'frei', f: 'schwarz', d: 4, p: welle }, ...STRICHE.slice(1)] };
  const daten = { titel: 'Skizze', deltaJson: JSON.stringify([{ insert: 'Oben\n' }, { insert: { zeichnung } },
    { insert: { zeichnung: { id: 'leer00000001', b: 300, h: 300, e: 0, s: [] } } }, { insert: 'Unten\n' }]), klartext: '', stand: 'x' };
  const zaehlen = async (png) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const n = { rot: 0, blau: 0, gruen: 0 };
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 180 && g < 90 && b < 90) n.rot++;
      if (b > 170 && r < 90 && g < 130) n.blau++;
      if (g > 100 && r < 70 && b < 110) n.gruen++;
    }
    return n;
  };
  const farbenDa = (n) => n.rot > 50 && n.blau > 20 && n.gruen > 10;
  const pdf = await exporte.pdf(daten);
  fs.writeFileSync(path.join(ORDNER, 'z.pdf'), pdf);
  if (hatProgramm('pdftoppm')) {
    spawnSync('pdftoppm', ['-r', '100', '-png', '-singlefile', path.join(ORDNER, 'z.pdf'), path.join(ORDNER, 'z-pdf')]);
    const n = await zaehlen(path.join(ORDNER, 'z-pdf.png'));
    const txt = spawnSync('pdftotext', ['-bbox', path.join(ORDNER, 'z.pdf'), '-'], { encoding: 'utf8' }).stdout;
    const yVon = (w) => Number((txt.match(new RegExp(`yMin="([\\d.]+)"[^>]*>${w}<`)) || [])[1]);
    ok('PDF: Formen in ihren Farben gezeichnet; „Unten" steht unter der Zeichnung (Abstand ≈ Höhe × 11/16)',
      farbenDa(n) && yVon('Unten') - yVon('Oben') > 205 * 11 / 16, JSON.stringify({ n, oben: yVon('Oben'), unten: yVon('Unten') }));
    ok('PDF: leere Fläche hinterlässt keinen weißen Block (Abstand nicht + 300 × 11/16)', yVon('Unten') - yVon('Oben') < (205 + 300) * 11 / 16);
  } else console.log('    (pdftoppm fehlt)');
  const docx = await exporte.docx(daten), odt = await exporte.odt(daten);
  const dz = new AdmZip(docx), oz = new AdmZip(odt);
  ok('Word: ein Bild (leere Fläche nicht), Beziehung + Typ eingetragen, Größe 342 × 205 × 11/16 pt, Einzug',
    dz.getEntries().filter(e => /^word\/media\//.test(e.entryName)).length === 1
      && /Target="media\/zeichnung1\.png"/.test(dz.readAsText('word/_rels/document.xml.rels')) && /Extension="png"/.test(dz.readAsText('[Content_Types].xml'))
      && dz.readAsText('word/document.xml').includes(`<wp:extent cx="${Math.round(342 * 11 / 16 * 12700)}" cy="${Math.round(205 * 11 / 16 * 12700)}"/>`)
      && dz.readAsText('word/document.xml').includes(`<w:ind w:left="${Math.round(40 * 11 / 16 * 20)}"/>`));
  ok('ODT: ein Bild, im Manifest, Rahmen mit Größe',
    oz.getEntries().filter(e => /^Pictures\//.test(e.entryName)).length === 1 && /Pictures\/zeichnung1\.png/.test(oz.readAsText('META-INF/manifest.xml'))
      && oz.readAsText('content.xml').includes(`svg:width="${(342 * 11 / 16).toFixed(2)}pt"`));
  if (hatProgramm('soffice') && hatProgramm('pdftoppm')) {
    for (const [endung, buf] of [['docx', docx], ['odt', odt]]) {
      const datei = path.join(ORDNER, 'z.' + endung); fs.writeFileSync(datei, buf);
      const aus = path.join(ORDNER, 'pdf-' + endung);
      spawnSync('soffice', ['-env:UserInstallation=file://' + path.join(ORDNER, 'lo'), '--headless', '--convert-to', 'pdf', '--outdir', aus, datei], { timeout: 120000 });
      const p = path.join(aus, 'z.pdf');
      let n = null;
      if (fs.existsSync(p)) { spawnSync('pdftoppm', ['-r', '100', '-png', '-singlefile', p, path.join(ORDNER, 'z-' + endung)]); n = await zaehlen(path.join(ORDNER, `z-${endung}.png`)); }
      ok(`${endung}: LibreOffice öffnet die Datei und zeigt die Zeichnung in ihren Farben`, n && farbenDa(n), JSON.stringify(n));
    }
  } else console.log('    (LibreOffice fehlt — Word/ODT nicht geöffnet)');

  fs.rmSync(ORDNER, { recursive: true, force: true });
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
