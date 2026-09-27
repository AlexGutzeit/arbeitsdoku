// Notiz als PDF, Word, OpenDocument und „Stand als eigene Notiz" — Server (Etappe B, 27.09.2026).
//
// Die Dateien werden nicht nur erzeugt, sondern wieder GELESEN: das PDF mit pdftotext, Word und ODT
// mit LibreOffice (das dabei zugleich beweist, dass ein Office-Programm sie öffnet). Geprüft wird:
//   * Inhalt zeichengleich: Titel, „Stand:", Umlaute, Pfeil, Haken, Listen, Nummerierung, die nach
//     einer Zwischenzeile wieder bei 1 beginnt, Checklisten als ☐/☑; Emojis im PDF als „□".
//   * Wer darf: Eigentümer und Leserecht ja, ohne Freigabe nein.
//   * Der Stand VON EBEN: Was gerade getippt und noch nicht gespeichert ist, steht schon in der Datei.
//   * Dateiname mit Umlauten (filename*) und ASCII-Rückfall.
//   * „Stand als eigene Notiz": gehört dem, der klickt (auch mit Leserecht), Titel mit Stand,
//     gleiche Formatierung, keine Freigaben, Projekt übernommen, Original unberührt.
//
//   node tests/notizen-export.js
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { geraetOeffnen } = require('./hilfen/notiz-live-geraet');

const PORT = 3339, DB = '/tmp/notizen-export.db', LOG = '/tmp/notizen-export.log';
const APP = path.join(__dirname, '..');
const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), 'notiz-export-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const st = []; x.on('data', c => st.push(c)); x.on('end', () => { const buf = Buffer.concat(st); let j = null; if (!roh) { try { j = JSON.parse(buf.toString()); } catch (_) {} }
        res({ status: x.statusCode, body: j, buf, kopf: x.headers }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const hatProgramm = (p) => spawnSync('which', [p]).status === 0;
function alsText(datei) {
  if (datei.endsWith('.pdf')) return spawnSync('pdftotext', ['-layout', datei, '-'], { encoding: 'utf8' }).stdout;
  const aus = path.join(ORDNER, 'txt');
  spawnSync('soffice', ['-env:UserInstallation=file://' + path.join(ORDNER, 'lo'), '--headless', '--convert-to', 'txt:Text', '--outdir', aus, datei], { encoding: 'utf8', timeout: 120000 });
  const txt = path.join(aus, path.basename(datei).replace(/\.\w+$/, '.txt'));
  return fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').replace(/^\uFEFF/, '') : null;
}
const zeilenVon = (t) => (t || '').split('\n').map(z => z.replace(/\s+/g, ' ').trim()).filter(Boolean);

const DELTA = [
  { insert: 'Material für Montag', attributes: { bold: true } }, { insert: '\n' },
  { insert: 'Kabel NYM-J 3×1,5 → 2 Ringe ✓' }, { insert: '\n', attributes: { list: 'checked' } },
  { insert: 'Wago 221-413' }, { insert: '\n', attributes: { list: 'unchecked' } },
  { insert: 'Erster Schritt' }, { insert: '\n', attributes: { list: 'ordered' } },
  { insert: 'Zweiter ' }, { insert: 'Schritt', attributes: { italic: true, underline: true } }, { insert: '\n', attributes: { list: 'ordered' } },
  { insert: 'Zwischenzeile 👍' }, { insert: '\n' },
  { insert: 'Neu eins' }, { insert: '\n', attributes: { list: 'ordered' } },
  { insert: 'Schlüssel beim Hausmeister' }, { insert: '\n', attributes: { list: 'bullet' } },
  { insert: 'Ende & <Test> "Ä"' }, { insert: '\n' },
];
// So muss es gelesen werden (Office: ☑/☐ als Zeichen, 👍 bleibt; PDF: Kästchen gezeichnet, 👍 → □)
const ERWARTET_OFFICE = ['Material für Montag', '☑ Kabel NYM-J 3×1,5 → 2 Ringe ✓', '☐ Wago 221-413', '1. Erster Schritt', '2. Zweiter Schritt',
  'Zwischenzeile 👍', '1. Neu eins', '• Schlüssel beim Hausmeister', 'Ende & <Test> "Ä"'];
const ERWARTET_PDF = ['Material für Montag', 'Kabel NYM-J 3×1,5 → 2 Ringe ✓', 'Wago 221-413', '1. Erster Schritt', '2. Zweiter Schritt',
  'Zwischenzeile □', '1. Neu eins', '• Schlüssel beim Hausmeister', 'Ende & <Test> "Ä"'];

(async () => {
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
    for (const [u, name] of [['olga', 'Olga Eigen'], ['rita', 'Rita Lies'], ['xaver', 'Xaver Fremd']]) {
      n[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name, role: 'mitarbeiter', hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
      n[u].token = await tok(u, 'Test1234!');
    }
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Halle 2' })).body;
    const projektId = projekt && (projekt.project ? projekt.project.id : projekt.id);
    const note = (await req('POST', '/api/notes', n.olga.token, { title: 'Zählerstände: Halle/2', project_id: projektId })).body.note;
    await req('PUT', `/api/notes/${note.id}/shares`, n.olga.token, { shares: [{ user_id: n.rita.id, permission: 'read' }] });
    const ticket = async (u) => (await req('GET', '/api/events/ticket', u.token)).body.ticket;
    const g = await geraetOeffnen({ port: PORT, ticket: await ticket(n.olga), noteId: note.id, token: n.olga.token }); offen.push(g);
    await g.schreibe(t => { t.delete(0, t.length); t.applyDelta(DELTA); });
    g.schliessen(); await sleep(2000);

    const pruefeDatei = async (wer, format) => {
      const r = await req('GET', `/api/notes/${note.id}/export/${format}`, wer.token, null, true);
      const cd = r.kopf['content-disposition'] || '';
      const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || '');
      const datei = path.join(ORDNER, wer.username + '.' + format);
      fs.writeFileSync(datei, r.buf);
      return { r, cd, name, datei };
    };

    console.log('\nDateien — Inhalt wieder gelesen');
    const hatPdf = hatProgramm('pdftotext'), hatOffice = hatProgramm('soffice');
    for (const format of ['pdf', 'docx', 'odt']) {
      const { r, cd, name, datei } = await pruefeDatei(n.olga, format);
      ok(`${format}: 200, richtiger Typ, Dateiname mit Umlauten und ohne verbotene Zeichen, ASCII-Rückfall`,
        r.status === 200 && r.kopf['content-type'].startsWith(format === 'pdf' ? 'application/pdf' : format === 'docx' ? 'application/vnd.openxmlformats' : 'application/vnd.oasis')
          && /^Zählerstände Halle 2 – Stand \d{4}-\d\d-\d\d \d\d-\d\d\.\w+$/.test(name) && name.endsWith('.' + format) && /filename="Zahlerstande Halle 2 - Stand /.test(cd),
        `${r.status} ${r.kopf['content-type']} | ${name} | ${cd.slice(0, 60)}`);
      if ((format === 'pdf' && !hatPdf) || (format !== 'pdf' && !hatOffice)) { console.log(`    (${format === 'pdf' ? 'pdftotext' : 'LibreOffice'} fehlt — Inhalt nicht gelesen)`); continue; }
      const z = zeilenVon(alsText(datei));
      const soll = format === 'pdf' ? ERWARTET_PDF : ERWARTET_OFFICE;
      ok(`${format}: Titel, „Stand:", und jede Zeile in der richtigen Reihenfolge`,
        z[0] === 'Zählerstände: Halle/2' && /^Stand: \d\d\.\d\d\.\d{4}, \d\d:\d\d$/.test(z[1]) && JSON.stringify(z.slice(2)) === JSON.stringify(soll),
        JSON.stringify(z));
    }
    if (hatPdf) {
      const schriften = spawnSync('pdffonts', [path.join(ORDNER, 'olga.pdf')], { encoding: 'utf8' }).stdout;
      ok('PDF: Schrift eingebettet (DejaVu), nicht die Standardschrift', /DejaVuSans/.test(schriften) && /yes\s+yes/.test(schriften) && !/Helvetica/.test(schriften), schriften.split('\n').slice(2).join(' | '));
    }

    console.log('\nWer darf');
    const rLesen = await req('GET', `/api/notes/${note.id}/export/pdf`, n.rita.token, null, true);
    const rFremd = await req('GET', `/api/notes/${note.id}/export/pdf`, n.xaver.token);
    const rFehlt = await req('GET', `/api/notes/999999/export/pdf`, n.olga.token);
    const rFormat = await req('GET', `/api/notes/${note.id}/export/exe`, n.olga.token);
    const rOhne = await req('GET', `/api/notes/${note.id}/export/pdf`, null);
    ok('Leserecht: darf (200); ohne Freigabe 403; fehlende Notiz 404; unbekanntes Format 404; ohne Anmeldung 401',
      rLesen.status === 200 && rFremd.status === 403 && rFehlt.status === 404 && rFormat.status === 404 && rOhne.status === 401,
      [rLesen.status, rFremd.status, rFehlt.status, rFormat.status, rOhne.status].join('/'));

    console.log('\nDer Stand von eben');
    const g2 = await geraetOeffnen({ port: PORT, ticket: await ticket(n.olga), noteId: note.id, token: n.olga.token }); offen.push(g2);
    await g2.schreibe(t => t.insert(t.length - 1, ' Gerade getippt'));
    const sofort = await pruefeDatei(n.olga, 'odt');   // noch innerhalb der 1,5 s bis zum Speichern
    ok('noch nicht gespeicherte Änderung steht schon in der Datei', hatOffice ? /Gerade getippt/.test(alsText(sofort.datei) || '') : sofort.r.status === 200);

    console.log('\nStand als eigene Notiz');
    const k = await req('POST', `/api/notes/${note.id}/kopie`, n.rita.token);
    const kopie = k.body && k.body.note;
    ok('mit Leserecht: Kopie angelegt, gehört Rita, Titel mit „(Stand TT.MM.JJJJ, HH:MM)", Projekt übernommen',
      k.status === 201 && kopie.user_id === n.rita.id && /^Zählerstände: Halle\/2 \(Stand \d\d\.\d\d\.\d{4}, \d\d:\d\d\)$/.test(kopie.title) && kopie.project_id === projektId,
      JSON.stringify(k.body).slice(0, 200));
    // Die Kopie nimmt den Stand VON EBEN (Raum); das Original steht erst nach dem Speichertakt (1,5 s) in der Liste.
    await sleep(2500);
    const original = ((await req('GET', '/api/notes', n.olga.token)).body.notes || []).find(x => x.id === note.id);
    ok('gleicher Inhalt und gleiche Formatierung wie das Original von eben (samt „Gerade getippt")',
      kopie.body === original.body && kopie.body_delta === original.body_delta && /Gerade getippt/.test(kopie.body), JSON.stringify([kopie.body.slice(-30), original.body.slice(-30)]));
    const kFreigaben = await req('GET', `/api/notes/${kopie.id}/shares`, n.rita.token);
    ok('die Kopie hat keine Freigaben — Olga sieht sie nicht', kFreigaben.status === 200 && kFreigaben.body.shares.length === 0
      && !((await req('GET', '/api/notes', n.olga.token)).body.notes || []).some(x => x.id === kopie.id));
    const g3 = await geraetOeffnen({ port: PORT, ticket: await ticket(n.rita), noteId: kopie.id, token: n.rita.token }); offen.push(g3);
    ok('Rita kann ihre Kopie öffnen und darin schreiben (Eigentümerin)', g3.zugriff === 'owner' && (await g3.schreibe(t => t.insert(0, 'Meins: '))).status === 200);
    await sleep(300);
    ok('… das Original bleibt davon unberührt', !/Meins:/.test(g2.text()));
    const k2 = await req('POST', `/api/notes/${kopie.id}/kopie`, n.rita.token);
    ok('Kopie der Kopie: der alte „(Stand …)" wird ersetzt, nicht angehängt',
      k2.status === 201 && /^Zählerstände: Halle\/2 \(Stand \d\d\.\d\d\.\d{4}, \d\d:\d\d\)$/.test(k2.body.note.title), k2.body && k2.body.note && k2.body.note.title);
    const kFremd = await req('POST', `/api/notes/${note.id}/kopie`, n.xaver.token);
    ok('ohne Freigabe: keine Kopie (403)', kFremd.status === 403, String(kFremd.status));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const g of offen) g.schliessen();
    srv.kill();
    try { fs.rmSync(ORDNER, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\nNotiz-Export: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
