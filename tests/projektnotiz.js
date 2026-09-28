// Projektnotiz — Server (28.09.2026): eine gemeinsame Live-Notiz je Projekt.
//
// Alex: Lesen alle; Schreiben Chef, Admin und dem Projekt Zugeteilte; nicht im Menü Notizen; Meldungen
// nur an die Zugeteilte (push-targeting); erledigt weiter beschreibbar; Gäste laden Chef/Admin ein.
// Geprüft:
//   * Anfangs keine Notiz — „Öffnen" legt sie an (einmal, auch bei zwei Öffnungen), leer, ohne Eigentümer,
//     Titel = Projektname; nicht in den persönlichen Notizlisten.
//   * Rechte: Chef/zugeteilt schreiben, Buchhalterin/nicht zugeteilt lesen (403 NUR_LESEN); Zuteilung
//     und Rolle ändern gilt sofort für die, die drin sind; erledigt → weiter beschreibbar.
//   * Titel folgt dem Projektnamen (auch live), über die Notiz nicht änderbar; nicht löschbar/teilbar
//     über die Notiz-Wege.
//   * Papierkorb: alle raus (auch Gäste), kein Zugriff; wiederhergestellt → alles wieder da; endgültig → weg.
//   * Drucken/Export für Leser; Kopie gehört dem Klickenden und hängt am Projekt; Board zeigt 📝.
//
//   node tests/projektnotiz.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const { geraetOeffnen } = require('./hilfen/notiz-live-geraet');

const PORT = 3344, DB = '/tmp/projektnotiz.db', LOG = '/tmp/projektnotiz.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b, roh) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { const st = []; x.on('data', c => st.push(c)); x.on('end', () => { const buf = Buffer.concat(st); let j = null; if (!roh) { try { j = JSON.parse(buf.toString()); } catch (_) {} } res({ status: x.statusCode, body: j, buf }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  const offen = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {}, t = {};
    for (const [u, n, rolle] of [['carla', 'Carla Chef', 'chef'], ['bea', 'Bea Buch', 'buchhalter'], ['anna', 'Anna Berger', 'mitarbeiter'], ['tom', 'Tom Kraus', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: rolle, hours_mon: 8 })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }
    const projekt = (await req('POST', '/api/projects', t.carla, { name: 'Halle 2', note: 'Schlüssel beim Hausmeister', assigned_user_ids: [id.anna] })).body.project;
    const P = (x) => `/api/projects/${projekt.id}${x || ''}`;
    const ticket = async (u) => (await req('GET', '/api/events/ticket', t[u])).body.ticket;
    const oeffne = async (u, nid) => { const g = await geraetOeffnen({ port: PORT, ticket: await ticket(u), noteId: nid, token: t[u] }); offen.push(g); return g; };

    console.log('\nAnfangs leer — Öffnen legt an');
    const board0 = ((await req('GET', '/api/projects', t.tom)).body.projects || []).find(p => p.id === projekt.id);
    const blick = await req('GET', P('/notiz'), t.tom);
    ok('Board: noch keine Notiz; Vorschau für Tom: leer, darf nicht schreiben', board0.notiz === null && blick.status === 200 && blick.body.notiz === null && blick.body.darf_schreiben === false, JSON.stringify(blick.body));
    const recht = {}; for (const u of ['carla', 'bea', 'anna', 'tom']) recht[u] = (await req('GET', P('/notiz'), t[u])).body;
    ok('darf schreiben: Chef ja, zugeteilte Anna ja, Buchhalterin nein, Tom nein; Gäste einladen nur Chef',
      recht.carla.darf_schreiben && recht.anna.darf_schreiben && !recht.bea.darf_schreiben && !recht.tom.darf_schreiben && recht.carla.darf_gaeste && !recht.anna.darf_gaeste,
      JSON.stringify(Object.fromEntries(Object.entries(recht).map(([k, v]) => [k, [v.darf_schreiben, v.darf_gaeste]]))));
    const [a1, a2] = await Promise.all([req('POST', P('/notiz'), t.tom), req('POST', P('/notiz'), t.anna)]);
    const nid = a1.body.notiz.id;
    ok('Öffnen (Tom und Anna gleichzeitig): EINE Notiz, Titel = Projektname', a1.status === 200 && a2.status === 200 && a2.body.notiz.id === nid && a1.body.notiz.title === 'Halle 2', JSON.stringify([a1.body, a2.body]));
    const listen = {}; for (const u of ['carla', 'anna', 'tom']) listen[u] = ((await req('GET', '/api/notes', t[u])).body.notes || []).map(n => n.id);
    ok('nicht in den persönlichen Notizlisten', Object.values(listen).every(l => !l.includes(nid)), JSON.stringify(listen));

    console.log('\nWer darf was');
    const gAnna = await oeffne('anna', nid), gTom = await oeffne('tom', nid), gBea = await oeffne('bea', nid), gCarla = await oeffne('carla', nid);
    ok('Anna (zugeteilt) und Carla (Chef) schreiben, Tom und Bea (Buchhaltung) lesen', gAnna.zugriff === 'write' && gCarla.zugriff === 'write' && gTom.zugriff === 'read' && gBea.zugriff === 'read',
      [gAnna.zugriff, gCarla.zugriff, gTom.zugriff, gBea.zugriff].join('/'));
    const startKopf = gAnna.ereignisse.find(e => e.typ === 'start').daten.kopf;
    ok('Kopf nennt das Projekt', startKopf.projekt && startKopf.projekt.id === projekt.id && startKopf.projekt.name === 'Halle 2', JSON.stringify(startKopf));
    const wTom = await gTom.schreibe(x => x.insert(0, 'Tom war hier'));
    ok('Tom schreiben → 403 NUR_LESEN', wTom.status === 403 && wTom.body.code === 'NUR_LESEN', JSON.stringify(wTom));
    const wAnna = await gAnna.schreibe(x => x.insert(0, 'Material bestellt'));
    await gBea.warte('aenderung');
    // An Beas Gerät prüfen: Toms Gerät trägt seinen abgewiesenen Versuch noch bei sich (der echte Browser
    // öffnet danach neu) — je nach Reihenfolge im Dokument stünde Annas Text dort vorn oder hinten.
    ok('Anna schreibt → die anderen sehen es live', wAnna.status === 200 && gBea.text().startsWith('Material bestellt'), gBea.text());
    await sleep(2200);
    const board1 = ((await req('GET', '/api/projects', t.tom)).body.projects || []).find(p => p.id === projekt.id);
    ok('Board: 📝 (hat Inhalt), zuletzt von Anna, wer drin ist', board1.notiz && board1.notiz.hat_inhalt && board1.notiz.von === 'Anna Berger' && board1.notiz.live.length === 4, JSON.stringify(board1.notiz));

    console.log('\nZuteilung, Rolle, erledigt, Titel');
    await req('PUT', P(), t.carla, { assigned_user_ids: [id.tom] });
    const zTom = await gTom.warte('zugriff'), zAnna = await gAnna.warte('zugriff');
    ok('Zuteilung Anna → Tom: sofort Tom schreibt, Anna liest (ohne Rauswurf)', zTom && zTom.zugriff === 'write' && zAnna && zAnna.zugriff === 'read' && gAnna.offen, JSON.stringify([zTom, zAnna]));
    await req('PUT', `/api/users/${id.bea}`, admin, { role: 'chef' });
    const zBea = await gBea.warte('zugriff');
    ok('Bea wird Chef → schreibt sofort', zBea && zBea.zugriff === 'write', JSON.stringify(zBea));
    await req('POST', P('/done'), t.carla);
    const wErledigt = await gTom.schreibe(x => x.insert(0, 'Nachtrag: '));
    ok('Projekt erledigt → Zugeteilter schreibt weiter', wErledigt.status === 200, JSON.stringify(wErledigt));
    await req('POST', P('/reopen'), t.carla);
    await req('PUT', P(), t.carla, { name: 'Halle 2 Nord' });
    const kopf = await gAnna.warte('kopf');
    const titelNotiz = await req('PUT', `/api/notes/${nid}`, t.carla, { title: 'Anders' });
    ok('Projekt umbenannt → Titel der Notiz folgt, live; über die Notiz nicht umbenennbar (403)',
      kopf && kopf.title === 'Halle 2 Nord' && kopf.projekt.name === 'Halle 2 Nord' && titelNotiz.status === 403, JSON.stringify([kopf, titelNotiz.status]));
    const loeschenNotiz = await req('DELETE', `/api/notes/${nid}`, t.carla);
    const teilenNotiz = await req('PUT', `/api/notes/${nid}/shares`, t.carla, { shares: [{ user_id: id.anna, permission: 'write' }] });
    ok('über die Notiz-Wege weder löschbar noch teilbar (auch nicht für den Chef)', loeschenNotiz.status === 403 && teilenNotiz.status === 403, `${loeschenNotiz.status} ${teilenNotiz.status}`);

    console.log('\nDrucken, Kopie');
    const pdf = await req('GET', `/api/notes/${nid}/export/pdf`, t.anna, null, true);
    ok('Anna (liest nur noch) lädt das PDF', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF');
    const kopie = await req('POST', `/api/notes/${nid}/kopie`, t.anna);
    ok('Stand als eigene Notiz: gehört Anna, hängt am Projekt, Titel „Halle 2 Nord (Stand …)"',
      kopie.status === 201 && kopie.body.note.user_id === id.anna && kopie.body.note.project_id === projekt.id && /^Halle 2 Nord \(Stand /.test(kopie.body.note.title), JSON.stringify(kopie.body.note).slice(0, 160));

    console.log('\nGäste');
    const gastAnna = await req('POST', `/api/notes/${nid}/gaeste`, t.anna, { name: 'Architekt', passwort: 'Geheim123', permission: 'read' });
    const gastTom = await req('POST', `/api/notes/${nid}/gaeste`, t.tom, { name: 'Architekt', passwort: 'Geheim123', permission: 'read' });
    const gastCarla = await req('POST', `/api/notes/${nid}/gaeste`, t.carla, { name: 'Architekt', passwort: 'Geheim123', permission: 'read' });
    ok('Gäste einladen: Mitarbeiter nein (auch zugeteilt), Chef ja', gastAnna.status === 403 && gastTom.status === 403 && gastCarla.status === 201, [gastAnna.status, gastTom.status, gastCarla.status].join('/'));
    const gastTok = (await req('POST', '/api/gast/anmelden', null, { token: gastCarla.body.gast.token, passwort: 'Geheim123' })).body.token;
    const gastTicket = (await req('GET', '/api/gast/ticket', gastTok)).body.ticket;
    const gGast = await geraetOeffnen({ port: PORT, ticket: gastTicket, token: gastTok, basis: '/api/gast' }); offen.push(gGast);
    ok('der Gast ist in der Projektnotiz (liest)', gGast.status === 200 && gGast.zugriff === 'read' && /Material bestellt/.test(gGast.text()), `${gGast.status} ${gGast.zugriff}`);

    console.log('\nPapierkorb');
    await req('DELETE', P(), t.carla);
    const raus = await Promise.all([gAnna, gTom, gCarla, gGast].map(g => g.warte('raus')));
    const nachher = { notiz: (await req('GET', P('/notiz'), t.carla)).status, oeffnen: (await req('POST', P('/notiz'), t.carla)).status,
      export: (await req('GET', `/api/notes/${nid}/export/pdf`, t.carla)).status, gast: (await req('POST', '/api/gast/anmelden', null, { token: gastCarla.body.gast.token, passwort: 'Geheim123' })).status };
    ok('Projekt gelöscht → alle raus (Grund „projekt-geloescht", der Gast „geloescht"), kein Zugriff mehr',
      raus.slice(0, 3).every(r => r && r.grund === 'projekt-geloescht') && raus[3] && raus[3].grund === 'geloescht'
        && nachher.notiz === 404 && nachher.oeffnen === 404 && nachher.export === 404 && nachher.gast === 403, JSON.stringify({ raus, nachher }));
    await req('POST', P('/restore'), t.carla);
    const zurueck = await req('GET', P('/notiz'), t.tom);
    ok('wiederhergestellt → Notiz mit Inhalt wieder da', zurueck.status === 200 && zurueck.body.notiz && zurueck.body.notiz.id === nid && zurueck.body.notiz.hat_inhalt, JSON.stringify(zurueck.body).slice(0, 120));
    await req('DELETE', P(), t.carla);
    const weg = await req('DELETE', P('/purge'), t.carla);
    const nachPurge = await req('GET', `/api/notes/${nid}/export/pdf`, t.carla);
    const gastNachPurge = await req('POST', '/api/gast/anmelden', null, { token: gastCarla.body.gast.token, passwort: 'Geheim123' });
    ok('endgültig gelöscht → Notiz und Gast weg', weg.status === 200 && nachPurge.status === 404 && gastNachPurge.status === 404, `${weg.status} ${nachPurge.status} ${gastNachPurge.status}`);
    const kopieDa = ((await req('GET', '/api/notes', t.anna)).body.notes || []).find(n => n.id === kopie.body.note.id);
    ok('… Annas eigene Kopie bleibt (mit dem Projektnamen als Text)', !!kopieDa && kopieDa.project_text === 'Halle 2 Nord', JSON.stringify(kopieDa && [kopieDa.project_id, kopieDa.project_text]));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const g of offen) g.schliessen();
    srv.kill();
    await new Promise(r => { if (srv.exitCode !== null) r(); else srv.once('exit', r); });
  }
  // Teil 2: direkt in der Datenbank (Server beendet) — „endgültig" heißt: die Zeile ist weg, nicht nur unerreichbar
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB));
    const reste = db.exec("SELECT COUNT(*) FROM notes WHERE projekt_notiz_fuer IS NOT NULL")[0].values[0][0];
    const gaesteReste = db.exec('SELECT COUNT(*) FROM note_gaeste WHERE note_id NOT IN (SELECT id FROM notes)')[0].values[0][0];
    ok('in der Datenbank: keine Projektnotiz und kein Gast mehr übrig', reste === 0 && gaesteReste === 0, JSON.stringify({ reste, gaesteReste }));
  } catch (e) { fail++; fails.push('Teil 2: ' + e.message); console.log('  ✗ Teil 2: ' + e.message); }
  console.log(`\nProjektnotiz (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
