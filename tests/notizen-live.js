// Live-Notizen auf dem Server: mehrere bearbeiten gleichzeitig, Rechte, Rauswurf, Speichern (Etappe A, Schritt 3).
//
// Mehrere „Geräte" (tests/hilfen/notiz-live-geraet.js: Ereignisstrom + Yjs, wie der Browser) öffnen
// dieselbe Notiz. Geprüft wird, was auf dem Server liegen MUSS, weil ein Browser es umgehen könnte:
//   * Gleichzeitiges Schreiben kommt überall gleich an und landet so in der Datenbank.
//   * Leserecht heißt: mitlesen ja, schreiben nein — geprüft bei JEDER Sendung, nicht beim Öffnen.
//   * Wer sein Recht verliert (Freigabe entzogen, Notiz gelöscht, ausgestellt), fliegt sofort raus;
//     Schreiben → Lesen gilt sofort.
//   * Name und Farbe am Cursor setzt der Server. Fremde Clientnummern lassen sich nicht übernehmen.
//   * Ein alter Programmstand (Speichern mit `body`, Sperre) wird mit Hinweis abgewiesen, statt die
//     Formatierung aller mit Klartext zu überschreiben.
//   * Nur hineinschauen ändert keinen Zeitstempel. Ein Neustart (Deploy) verliert nichts.
//
//   node tests/notizen-live.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const { geraetOeffnen, b64 } = require('./hilfen/notiz-live-geraet');
const awarenessProtocol = require('y-protocols/awareness');
const Y = require('yjs');

const PORT = 3336, DB = '/tmp/notizen-live.db', LOG = '/tmp/notizen-live.log';
const APP = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

let srv = null;
async function starten(neu) {
  if (neu) { try { fs.unlinkSync(DB); } catch (_) {} }
  const lg = fs.openSync(LOG, neu ? 'w' : 'a');
  srv = spawn('node', ['server.js'], { cwd: APP,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(150); }
}
async function beenden() {
  if (!srv) return;
  const weg = new Promise(r => srv.once('exit', r));
  srv.kill('SIGTERM'); await weg; srv = null;
}

(async () => {
  const offen = [];
  try {
    await starten(true);
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const nutzer = {};
    for (const [u, name] of [['olga', 'Olga Eigen'], ['wim', 'Wim Schreib'], ['rita', 'Rita Lies'], ['xaver', 'Xaver Fremd']]) {
      nutzer[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name, role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 })).body.user;
      nutzer[u].token = await tok(u, 'Test1234!');
    }
    const { olga, wim, rita, xaver } = nutzer;
    const ticket = async (n) => (await req('GET', '/api/events/ticket', n.token)).body.ticket;
    const oeffnen = async (n, id) => { const g = await geraetOeffnen({ port: PORT, ticket: await ticket(n), noteId: id, token: n.token }); offen.push(g); return g; };
    const notiz = async (id, t = olga.token) => ((await req('GET', '/api/notes', t)).body.notes || []).find(n => n.id === id);

    console.log('\nAnlegen');
    const neu = await req('POST', '/api/notes', olga.token, { title: 'Material Montag' });
    const id = neu.body.note.id;
    ok('neue Notiz: leerer Text, Formatierung = ein Zeilenende, kein Binärdokument in der Antwort',
      neu.status === 201 && neu.body.note.body === '' && neu.body.note.body_delta === '[{"insert":"\\n"}]' && !('ydoc' in neu.body.note),
      JSON.stringify(neu.body.note));
    await req('PUT', `/api/notes/${id}/shares`, olga.token, { shares: [{ user_id: wim.id, permission: 'write' }, { user_id: rita.id, permission: 'read' }] });
    const vorOeffnen = (await notiz(id)).updated_at;

    console.log('\nÖffnen und Rechte beim Öffnen');
    const O = await oeffnen(olga, id), W = await oeffnen(wim, id);
    let R = await oeffnen(rita, id);
    ok('Eigentümerin, Schreib- und Leserecht bekommen den Stand und ihren Zugriff',
      O.zugriff === 'owner' && W.zugriff === 'write' && R.zugriff === 'read' && O.text() === '\n' && R.text() === '\n',
      JSON.stringify([O.status, O.zugriff, W.zugriff, R.zugriff, O.doc && O.text()]));
    ok('jeder bekommt seinen Namen und eine eigene Farbe',
      O.du.name === 'Olga Eigen' && new Set([O.du.farbe, W.du.farbe, R.du.farbe]).size === 3, JSON.stringify([O.du, W.du, R.du]));
    const X = await oeffnen(xaver, id);
    ok('ohne Freigabe: abgewiesen (403)', X.status === 403, String(X.status));
    const ohneTicket = await geraetOeffnen({ port: PORT, ticket: '', noteId: id });
    const mitAnmeldung = await geraetOeffnen({ port: PORT, ticket: olga.token, noteId: id });
    ok('ohne Ticket und mit dem langen Anmelde-Token statt Ticket: abgewiesen (401)',
      ohneTicket.status === 401 && mitAnmeldung.status === 401, `${ohneTicket.status}/${mitAnmeldung.status}`);
    const fehlt = await oeffnen(olga, 999999);
    ok('nicht vorhandene Notiz: 404', fehlt.status === 404, String(fehlt.status));

    console.log('\nGemeinsam schreiben');
    const r1 = await O.schreibe(t => t.insert(0, 'Kabel\nDosen'));
    await W.warte('aenderung'); await R.warte('aenderung');
    ok('Olga schreibt → Wim und Rita haben denselben Text', r1.status === 200 && W.text() === O.text() && R.text() === 'Kabel\nDosen\n',
      JSON.stringify([r1.status, W.text(), R.text()]));
    // gleichzeitig an derselben Stelle, ohne aufeinander zu warten
    const [a, b] = await Promise.all([O.schreibe(t => t.insert(5, ' 3×1,5')), W.schreibe(t => t.insert(5, ' NYM'))]);
    await sleep(300);
    ok('gleichzeitig an derselben Stelle → alle drei sehen am Ende exakt dasselbe',
      a.status === 200 && b.status === 200 && O.text() === W.text() && W.text() === R.text() && /NYM/.test(O.text()) && /3×1,5/.test(O.text()),
      JSON.stringify([O.text(), W.text(), R.text()]));
    await W.schreibe(t => t.format(0, 5, { bold: true }));
    await W.schreibe(t => t.format(O.text().indexOf('Dosen') + 5, 1, { list: 'unchecked' }));
    await O.warte('aenderung'); await sleep(200);
    ok('Formatierung (fett, Checkliste) kommt an', JSON.stringify(O.delta()) === JSON.stringify(W.delta())
      && O.delta().some(d => d.attributes && d.attributes.bold) && O.delta().some(d => d.attributes && d.attributes.list === 'unchecked'),
      JSON.stringify(O.delta()));

    console.log('\nLeserecht');
    const rs = await R.schreibe(t => t.insert(0, 'Rita war hier '));
    await sleep(200);
    ok('Rita (nur lesen) kann nicht schreiben — 403, bei den anderen kommt nichts an',
      rs.status === 403 && !/Rita/.test(O.text()), JSON.stringify([rs.status, O.text()]));
    // Ihr Gerät hat die Änderung schon bei sich eingetragen — nach einer Abweisung muss es neu
    // öffnen und den Stand des Servers übernehmen (so macht es auch der Browser, Schritt 4).
    R.schliessen(); R = await oeffnen(rita, id);
    ok('nach dem Neu-Öffnen hat Rita wieder genau den Stand der anderen', R.text() === O.text(), JSON.stringify(R.text()));

    console.log('\nCursor und Anwesenheit');
    await O.cursor(3);
    const angekommen = await W.warte('anwesenheit');
    const olgaBeiWim = W.aw.getStates().get(O.doc.clientID);
    ok('Olgas Cursor kommt bei Wim an — mit ihrem echten Namen und ihrer Farbe, nicht mit dem mitgeschickten',
      !!angekommen && olgaBeiWim && olgaBeiWim.user.name === 'Olga Eigen' && olgaBeiWim.user.color === O.du.farbe && olgaBeiWim.cursor,
      JSON.stringify(olgaBeiWim));
    // Rita versucht, unter Olgas Clientnummer aufzutreten
    const fremd = new awarenessProtocol.Awareness(new Y.Doc());
    fremd.clientID = O.doc.clientID;
    fremd.setLocalState({ user: { name: 'Olga Eigen' }, cursor: null });
    fremd.meta.set(O.doc.clientID, { clock: 99, lastUpdated: Date.now() });
    const uebernahme = await R.anwesenheitRoh(b64(awarenessProtocol.encodeAwarenessUpdate(fremd, [O.doc.clientID])));
    fremd.destroy();
    ok('fremde Clientnummer übernehmen: abgewiesen (403)', uebernahme.status === 403, String(uebernahme.status));
    const kaputt = await O.rohSenden('bm9jaCBrZWluIFlqcw==');
    ok('beschädigte Änderung: abgewiesen (400), nichts verändert', kaputt.status === 400 && O.text() === W.text(), String(kaputt.status));
    // Was nur ein manipulierter Browser schicken kann: Bild, Link, fremdes Datenfeld, falscher Listenwert
    const schmuggel = async (was) => {
      const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(O.doc));
      const sv = Y.encodeStateVector(d); was(d);
      const r = await O.rohSenden(b64(Y.encodeStateAsUpdate(d, sv))); d.destroy(); return r.status;
    };
    const vorSchmuggel = O.text();
    const s1 = await schmuggel(d => d.getText('notiz').insertEmbed(0, { image: 'https://example.org/x.png' }));
    const s2 = await schmuggel(d => d.getText('notiz').insert(0, 'hier', { link: 'javascript:alert(1)' }));
    const s3 = await schmuggel(d => d.getMap('versteckt').set('x', 'y'));
    const s4 = await schmuggel(d => d.getText('notiz').format(0, 1, { list: 'irgendwas' }));
    // Der erlaubte Fall regulär über Wims Gerät — so bleibt er auch der letzte Bearbeiter (Prüfung unten).
    const s5 = (await W.schreibe(t => t.insert(0, 'fett ', { bold: true }))).status;
    await O.warte('aenderung', () => O.text() === 'fett ' + vorSchmuggel, 2000);
    await R.warte('aenderung', () => R.text() === 'fett ' + vorSchmuggel, 2000);
    ok('Bild, Link, fremdes Datenfeld, falscher Listenwert: abgewiesen (400) — erlaubte Formatierung geht',
      [s1, s2, s3, s4].every(x => x === 400) && s5 === 200 && O.text() === 'fett ' + vorSchmuggel && R.text() === O.text(),
      JSON.stringify([s1, s2, s3, s4, s5, O.text().slice(0, 30)]));
    const riesig = await O.anwesenheitRoh(b64(new Uint8Array(6000)));
    ok('übergroße Anwesenheits-Meldung: abgewiesen (413)', riesig.status === 413, String(riesig.status));
    const fremdeVerbindung = await O.rohSenden(b64(new Uint8Array([0, 0])), W.verbindung);
    ok('mit der Verbindung eines anderen senden: abgewiesen (409)', fremdeVerbindung.status === 409, String(fremdeVerbindung.status));

    console.log('\nSpeichern');
    await sleep(2200);
    const gespeichert = await notiz(id);
    ok('nach der Ruhepause steht der Text in der Datenbank (Klartext + Formatierung), ohne Binärdokument',
      gespeichert.body === O.text().replace(/\n$/, '') && JSON.parse(gespeichert.body_delta).some(d => d.attributes && d.attributes.bold) && !('ydoc' in gespeichert),
      JSON.stringify(gespeichert.body));
    ok('„Bearbeitet von" ist der, der zuletzt geändert hat (Wim)', gespeichert.updated_by === wim.id, String(gespeichert.updated_by));
    ok('in der Liste steht, wer gerade drin ist', ['Olga Eigen', 'Wim Schreib', 'Rita Lies'].every(n => gespeichert.live.includes(n)),
      JSON.stringify(gespeichert.live));

    console.log('\nZeilenende');
    await W.schreibe(t => t.delete(0, t.length));
    await sleep(300);
    ok('alles gelöscht → der Server hängt das Zeilenende wieder an, bei allen', O.text() === '\n' && W.text() === '\n' && R.text() === '\n',
      JSON.stringify([O.text(), W.text(), R.text()]));
    await O.schreibe(t => t.insert(0, 'Neu angefangen'));
    await W.warte('aenderung', () => W.text() === 'Neu angefangen\n', 2000);

    console.log('\nAlter Programmstand');
    const altPut = await req('PUT', `/api/notes/${id}`, wim.token, { title: 'Material Montag', body: 'nur Klartext' });
    const altLock = await req('POST', `/api/notes/${id}/lock`, wim.token);
    const altUnlock = await req('POST', `/api/notes/${id}/unlock`, wim.token);
    await sleep(200);
    ok('Speichern mit Text: abgewiesen mit Hinweis „neu laden" — der Inhalt bleibt unberührt',
      altPut.status === 409 && altPut.body.code === 'APP_VERALTET' && /neu laden/.test(altPut.body.error) && O.text() === 'Neu angefangen\n',
      JSON.stringify(altPut.body));
    ok('Sperre holen: ebenso abgewiesen; Sperre lösen: harmlos bestätigt', altLock.status === 409 && altLock.body.code === 'APP_VERALTET' && altUnlock.status === 200,
      `${altLock.status}/${altUnlock.status}`);

    console.log('\nTitel');
    const umb = await req('PUT', `/api/notes/${id}`, wim.token, { title: 'Material Dienstag', verbindung: W.verbindung });
    const kopfO = await O.warte('kopf');
    await sleep(150);
    ok('Umbenennen erreicht die anderen sofort, den Absender nicht doppelt',
      umb.status === 200 && kopfO && kopfO.title === 'Material Dienstag' && !W.ereignisse.some(e => e.typ === 'kopf'),
      JSON.stringify(kopfO));

    console.log('\nRechte ändern, während jemand drin ist');
    await req('PUT', `/api/notes/${id}/shares`, olga.token, { shares: [{ user_id: wim.id, permission: 'read' }] });
    const herab = await W.warte('zugriff');
    const raus = await R.warte('raus');
    await sleep(150);
    const wimDanach = await W.schreibe(t => t.insert(0, 'x'));
    ok('Wim: Schreiben → Lesen wird sofort mitgeteilt, danach wird seine Änderung abgewiesen',
      herab && herab.zugriff === 'read' && wimDanach.status === 403, JSON.stringify([herab, wimDanach.status]));
    ok('Rita: Freigabe entzogen → sofort raus, Strom beendet', raus && raus.grund === 'freigabe-entzogen' && !R.offen, JSON.stringify([raus, R.offen]));
    await req('PUT', `/api/notes/${id}/shares`, olga.token, { shares: [{ user_id: wim.id, permission: 'write' }] });
    const hoch = await W.warte('zugriff', d => d.zugriff === 'write');
    ok('… und zurück auf Schreiben gilt ebenso sofort', !!hoch && (await W.schreibe(t => t.insert(0, ''))).status !== 403);

    console.log('\nNur hineinschauen');
    const leer = (await req('POST', '/api/notes', olga.token, { title: 'Nur ansehen', body: 'Stand bleibt' })).body.note;
    const vorher = (await notiz(leer.id)).updated_at;
    await sleep(20);
    const blick = await oeffnen(olga, leer.id);
    await blick.cursor(2); await sleep(1800);
    blick.schliessen(); await sleep(400);
    const nachher = await notiz(leer.id);
    ok('öffnen, Cursor setzen, schließen → Zeitstempel unverändert', nachher.updated_at === vorher && nachher.body === 'Stand bleibt',
      `${vorher} → ${nachher.updated_at}`);
    ok('die Notiz von eben hat ihren Zeitstempel beim Öffnen auch nicht bewegt (erst beim Schreiben)', vorOeffnen <= gespeichert.updated_at);

    console.log('\nWeitergeben (Kopie)');
    await req('POST', `/api/notes/${id}/offer`, olga.token, { user_ids: [xaver.id] });
    const angebot = (await req('GET', '/api/notes/offers', xaver.token)).body.offers[0];
    await O.schreibe(t => { t.insert(0, 'Stand zur Übergabe '); t.format(0, 5, { italic: true }); });
    await req('POST', `/api/notes/offers/${angebot.id}/accept`, xaver.token);
    const kopie = ((await req('GET', '/api/notes', xaver.token)).body.notes || []).find(n => n.user_id === xaver.id);
    ok('die Kopie bekommt den Stand VON EBEN, samt Formatierung — auch wenn noch nicht gespeichert war',
      kopie && kopie.body === O.text().replace(/\n$/, '') && JSON.stringify(JSON.parse(kopie.body_delta)) === JSON.stringify(O.delta()),
      JSON.stringify(kopie && kopie.body));
    const K = await oeffnen(xaver, kopie.id);
    await O.schreibe(t => t.insert(0, 'Nur im Original '));
    await sleep(300);
    ok('Kopie und Original sind danach unabhängig', K.text() === kopie.body + '\n' && /Nur im Original/.test(O.text()), JSON.stringify(K.text()));
    K.schliessen();

    console.log('\nDatenauskunft');
    const auskunft = await req('GET', '/api/users/meine-daten', olga.token);
    const alsText = auskunft.text || '';
    ok('eigene Notizen mit Text und Formatierung, ohne Binärdokument und ohne Sperrspalten',
      auskunft.status === 200 && /Material Dienstag/.test(alsText) && !/"ydoc"/.test(alsText) && !/editing_by/.test(alsText) && /body_delta/.test(alsText),
      auskunft.status + ' ' + alsText.slice(0, 120));

    console.log('\nNeustart mitten im Tippen');
    await O.schreibe(t => t.insert(0, 'Kurz vor dem Neustart '));
    await beenden();              // SIGTERM, noch innerhalb der 1,5 s Ruhepause
    // Solange der Server steht (kein zweiter Prozess auf der Datenbank): Wims Eintritt in die
    // Vergangenheit legen — angelegt wird immer mit „heute", und ein Austritt vor dem Eintritt ist
    // zu Recht unmöglich. Gebraucht für „Ausstellen" unten.
    {
      const SQL = await require('sql.js')();
      const d = new SQL.Database(fs.readFileSync(DB));
      d.run("UPDATE employment_periods SET start_date = '2020-01-01' WHERE user_id = ?", [wim.id]);
      fs.writeFileSync(DB, Buffer.from(d.export())); d.close();
    }
    await starten(false);
    const nachNeustart = await notiz(id);
    ok('der letzte Tastendruck vor dem Neustart ist gespeichert', /^Kurz vor dem Neustart /.test(nachNeustart.body), JSON.stringify(nachNeustart.body));

    console.log('\nAusstellen');
    const W2 = await oeffnen(wim, id);
    const ausgestellt = await req('POST', `/api/users/${wim.id}/deactivate`, admin, { employed_until: '2026-01-31' });
    const wimRaus = await W2.warte('raus');
    ok('Wim wird ausgestellt → fliegt sofort aus der offenen Notiz', W2.status === 200 && ausgestellt.status === 200 && wimRaus && wimRaus.grund === 'abgemeldet' && !W2.offen,
      JSON.stringify([W2.status, ausgestellt.status, ausgestellt.body && ausgestellt.body.error, wimRaus]));
    const W3 = await oeffnen(wim, id);
    ok('… und kommt auch nicht wieder hinein', W3.status === 401, String(W3.status));

    console.log('\nLöschen, während jemand drin ist');
    const O2 = await oeffnen(olga, id);
    const Xn = await oeffnen(xaver, id);   // xaver hat hier keine Freigabe
    await req('PUT', `/api/notes/${id}/shares`, olga.token, { shares: [{ user_id: rita.id, permission: 'read' }] });
    const R2 = await oeffnen(rita, id);
    const weg = await req('DELETE', `/api/notes/${id}`, olga.token);
    const [g1, g2] = [await O2.warte('raus'), await R2.warte('raus')];
    ok('Notiz gelöscht → alle Drinnen sofort raus', weg.status === 200 && g1 && g2 && g1.grund === 'geloescht' && g2.grund === 'geloescht',
      JSON.stringify([weg.status, g1, g2, Xn.status]));
    const ritaDaten = (await req('GET', '/api/users/meine-daten', rita.token)).text || '';
    const geteilt = (JSON.parse(ritaDaten).mit_mir_geteilte_notizen || []).map(x => x.note_id);
    ok('… und ihre Freigaben sind mit weg (Ritas Datenauskunft nennt die Notiz nicht mehr)', !geteilt.includes(id), JSON.stringify(geteilt));
  } catch (e) {
    fail++; fails.push('Absturz: ' + e.message); console.log('  ✗ Absturz: ' + e.stack);
  } finally {
    for (const g of offen) g.schliessen();
    await beenden().catch(() => {});
  }
  console.log(`\nLive-Notizen (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
