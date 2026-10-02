// Persönliche Erinnerungen an Notizen — Server und Zeitplaner (Alex, 02.10.2026).
//
// Alex: „Was bringt mir eine Notiz ‚Arbeit muss bis zum $Datum erledigt sein', wenn ich die Notiz verlasse und
// gleich vergesse?" Erinnerung am Datum um Uhrzeit, jeder für sich, Push über den Schalter „Notizen".
// Entschieden: stellen darf jeder, der die Notiz sehen kann (auch nur lesend, bei Projektnotizen alle Leser);
// nur die ganze Notiz. Klick auf die Push → Notizen, Notiz hervorgehoben (Projektnotiz → Auftrag).
// Kann man die Notiz zur Zeit nicht sehen, verfällt die Erinnerung; gelöschte Notiz → Erinnerungen weg.
// Der Zeitplaner (faelligePruefen) läuft mit GESTELLTER Uhr, die nur vorwärts geht.
//
// In-Process, web-push abgefangen.
//   node tests/notiz-erinnerungen.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => { SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return Promise.resolve({ statusCode: 201 }); };

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/notiz-erinnerungen.db';
// Schlüsselpaar nur für diesen Lauf — im Repo steht kein privater Schlüssel (GitGuardian, 01.10.2026)
{ const k = require('web-push').generateVAPIDKeys(); process.env.VAPID_PUBLIC = k.publicKey; process.env.VAPID_PRIVATE = k.privateKey; }
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const N = require('../notiz-erinnerungen');
const { umText } = require('../erinnerungen');
const R = require('../meldung-regeln');
const reste = require('../reste');
const { buildSummaryText } = require('../scheduler');
const { berlinJetzt, berlinHeute } = require('../zeit');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(server, method, p, token, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const HEUTE = berlinHeute();
const tag = (n) => R.plusTage(HEUTE, n);
function berlin(datum, uhrzeit) {
  const roh = new Date(`${datum}T${uhrzeit}:00Z`);
  const dort = new Date(roh.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace(' ', 'T') + 'Z');
  const d = new Date(roh.getTime() - (dort - roh));
  if (berlinJetzt(d).slice(0, 16) !== `${datum} ${uhrzeit}`) throw new Error('berlin() rechnet falsch: ' + berlinJetzt(d));
  return d;
}

(async () => {
  await initDatabase();
  const db = getDb();
  const hash = bcrypt.hashSync('pw123456', 10);
  const ids = {};
  for (const [u, n, rolle] of [['olga', 'Olga Owner', 'mitarbeiter'], ['lena', 'Lena Leserin', 'mitarbeiter'], ['willi', 'Willi Schreiber', 'mitarbeiter'],
    ['xaver', 'Xaver Fremd', 'mitarbeiter'], ['carla', 'Carla Chef', 'chef'], ['adam', 'Adam Admin', 'admin']]) {
    ids[u] = db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)').run(u, hash, n, rolle).lastInsertRowid;
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')").run(ids[u], 'sub://' + u);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/notes', require('../routes/notes'));
  app.use('/api/projects', require('../routes/projects'));
  app.use('/api/badges', require('../routes/badges'));
  app.use('/api/audit', require('../routes/audit'));
  app.use('/api/users', require('../routes/users'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const tok = {};
  for (const u of Object.keys(ids)) tok[u] = (await req(server, 'POST', '/api/auth/login', null, { username: u, password: 'pw123456' })).body.token;

  const pruefen = async (datum, uhrzeit) => { SENT = []; const p = N.faelligePruefen(db, berlin(datum, uhrzeit)); await sleep(80); return p; };
  const stellen = (u, noteId, datum, uhrzeit, hinweis) => req(server, 'POST', `/api/notes/${noteId}/erinnerungen`, tok[u], { datum, uhrzeit, hinweis });
  const zeile = (id) => db.prepare('SELECT * FROM notiz_erinnerungen WHERE id = ?').get(id);
  const inListe = async (u, noteId) => { const r = await req(server, 'GET', '/api/notes', tok[u]); const n = (r.body.notes || []).find(x => x.id === noteId); return n ? n.erinnerungen : null; };
  const coin = async (u) => (await req(server, 'GET', '/api/badges', tok[u])).body;

  try {
    const n1 = (await req(server, 'POST', '/api/notes', tok.olga, { title: 'Angebot Gartenhütte', body: 'Geheimer Inhalt: Preis 4.200 €' })).body.note.id;
    await req(server, 'PUT', `/api/notes/${n1}/shares`, tok.olga, { shares: [{ user_id: ids.lena, permission: 'read' }, { user_id: ids.willi, permission: 'write' }] });
    for (const u of Object.keys(ids)) await req(server, 'POST', '/api/badges/notes', tok[u]);
    const stempel = db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(n1).updated_at;

    console.log('Wer darf');
    ok('ohne Zugriff (Xaver) → 404', (await stellen('xaver', n1, tag(2), '07:00')).status === 404);
    ok('vorbei → 400', /vorbei/.test((await stellen('olga', n1, tag(-1), '07:00')).body.error || ''));
    const eL = await stellen('lena', n1, tag(2), '07:00', 'Angebot muss raus');
    const eW = await stellen('willi', n1, tag(4), '07:00');
    const eO = await stellen('olga', n1, tag(3), '08:00');
    ok('lesend (Lena), schreibend (Willi) und Eigentümerin (Olga) dürfen — je 201', eL.status === 201 && eW.status === 201 && eO.status === 201,
      [eL.status, eW.status, eO.status].join(','));

    console.log('Nur für mich');
    ok('in der Liste sieht jede nur ihre eigene', JSON.stringify((await inListe('lena', n1)).map(e => e.id)) === JSON.stringify([eL.body.id])
      && JSON.stringify((await inListe('olga', n1)).map(e => e.id)) === JSON.stringify([eO.body.id]));
    const einzeln = await req(server, 'GET', `/api/notes/${n1}/erinnerungen`, tok.willi);
    ok('GET /:id/erinnerungen: nur die eigenen; ohne Zugriff 404', einzeln.body.erinnerungen.length === 1 && einzeln.body.erinnerungen[0].id === eW.body.id
      && (await req(server, 'GET', `/api/notes/${n1}/erinnerungen`, tok.xaver)).status === 404);
    ok('fremde ändern / löschen → 404', (await req(server, 'PUT', '/api/notes/erinnerungen/' + eL.body.id, tok.olga, { datum: tag(5), uhrzeit: '07:00' })).status === 404
      && (await req(server, 'DELETE', '/api/notes/erinnerungen/' + eL.body.id, tok.olga)).status === 404 && !!zeile(eL.body.id));
    ok('die Notiz selbst bleibt unberührt (kein „bearbeitet", kein Zähler)', db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(n1).updated_at === stempel
      && (await coin('olga')).notes === 0 && (await coin('willi')).notes === 0);
    ok('die Liste nennt „gesehen bis" (für die Marke über das stille Auffrischen hinweg)', !!(await req(server, 'GET', '/api/notes', tok.lena)).body.gesehen_bis);

    console.log('Zur Zeit: Push, Zähler, nur einmal');
    ok('eine Minute vorher: nichts', (await pruefen(tag(2), '06:59')).length === 0);
    let p = await pruefen(tag(2), '07:00');
    ok('zur Minute: Lenas Erinnerung kommt', p.length === 1 && p[0].id === eL.body.id && p[0].stand === 'ausgeloest', JSON.stringify(p));
    ok('… Push NUR an Lena: Titel der Notiz, Hinweis, Ziel = diese Notiz in den Notizen', SENT.length === 1 && SENT[0].endpoint === 'sub://lena'
      && SENT[0].payload.title === '🔔 Erinnerung: Angebot Gartenhütte' && SENT[0].payload.body === 'Angebot muss raus'
      && SENT[0].payload.url === '/#/notes' && SENT[0].payload.ziel && SENT[0].payload.ziel.art === 'notiz' && SENT[0].payload.ziel.id === n1, JSON.stringify(SENT));
    const cl = await coin('lena');
    ok('… Lenas Notizen-Zähler steigt', cl.notes === 1 && cl.notizErinnerungen === 1, JSON.stringify({ notes: cl.notes, e: cl.notizErinnerungen }));
    ok('… bei Olga nicht', (await coin('olga')).notizErinnerungen === 0);
    ok('… in der Zusammenfassung zählt sie nicht (die Push kam schon)', buildSummaryText(['notes'], cl) === 'Es gibt nichts zu tun.', buildSummaryText(['notes'], cl));
    const gek = (await inListe('lena', n1))[0];
    ok('… in der Liste: „ausgeloest" mit Zeitpunkt (für die Marke)', gek.stand === 'ausgeloest' && !!gek.stand_am);
    ok('keine zweite Push', (await pruefen(tag(2), '09:00')).length === 0 && SENT.length === 0);
    await req(server, 'POST', '/api/badges/notes', tok.lena);
    ok('Notizen angesehen → Zähler wieder 0', (await coin('lena')).notes === 0);
    db.prepare('INSERT INTO push_prefs (user_id, notes) VALUES (?, 0) ON CONFLICT(user_id) DO UPDATE SET notes = 0').run(ids.olga);
    p = await pruefen(tag(3), '08:00');
    ok('Schalter „Notizen" aus: keine Push, aber gekommen und gezählt', p.length === 1 && p[0].id === eO.body.id && SENT.length === 0 && (await coin('olga')).notizErinnerungen === 1);
    db.prepare('UPDATE push_prefs SET notes = 1 WHERE user_id = ?').run(ids.olga);

    console.log('Zugriff weg: verfällt — wieder da: kommt');
    await req(server, 'PUT', `/api/notes/${n1}/shares`, tok.olga, { shares: [{ user_id: ids.lena, permission: 'read' }] });
    p = await pruefen(tag(4), '07:00');
    ok('Willis Freigabe entzogen → seine Erinnerung verfällt („kein Zugriff"), keine Push', p.length === 1 && p[0].id === eW.body.id
      && zeile(eW.body.id).stand === 'verpasst' && zeile(eW.body.id).grund === 'kein Zugriff' && SENT.length === 0, JSON.stringify(p));
    ok('… ändern darf er nicht mehr (403), löschen schon', (await req(server, 'PUT', '/api/notes/erinnerungen/' + eW.body.id, tok.willi, { datum: tag(9), uhrzeit: '07:00' })).status === 403
      && (await req(server, 'DELETE', '/api/notes/erinnerungen/' + eW.body.id, tok.willi)).status === 200 && !zeile(eW.body.id));
    const eL2 = (await stellen('lena', n1, tag(6), '07:00')).body.id;
    await req(server, 'PUT', `/api/notes/${n1}/shares`, tok.olga, { shares: [] });
    await req(server, 'PUT', `/api/notes/${n1}/shares`, tok.olga, { shares: [{ user_id: ids.lena, permission: 'read' }] });
    p = await pruefen(tag(6), '07:00');
    ok('Freigabe kurz weg und wieder da, bevor die Zeit kommt → sie kommt', p.length === 1 && p[0].id === eL2 && p[0].stand === 'ausgeloest' && SENT.length === 1);

    console.log('Projektnotiz');
    const proj = (await req(server, 'POST', '/api/projects', tok.carla, { name: 'Halle Süd' })).body.project;
    const pn = (await req(server, 'POST', `/api/projects/${proj.id}/notiz`, tok.carla)).body.notiz.id;
    const eX = await stellen('xaver', pn, tag(7), '07:00', 'Material bestellen');
    ok('lesen darf jeder → Xaver (nicht zugeteilt) stellt eine (201)', eX.status === 201);
    p = await pruefen(tag(7), '07:00');
    ok('… Push führt zum Auftrag (Ziel Projekt), nicht in die Notizen', p.length === 1 && SENT.length === 1 && SENT[0].endpoint === 'sub://xaver'
      && SENT[0].payload.url === '/#/projects' && SENT[0].payload.ziel.art === 'projekt' && SENT[0].payload.ziel.id === proj.id, JSON.stringify(SENT));
    ok('… und zählt nicht am Notizen-Menü (die Projektnotiz steht dort nicht)', (await coin('xaver')).notizErinnerungen === 0);
    const eC = (await stellen('carla', pn, tag(8), '07:00')).body.id;
    await req(server, 'DELETE', `/api/projects/${proj.id}`, tok.carla);
    p = await pruefen(tag(8), '07:00');
    ok('Projekt im Papierkorb → Erinnerung verfällt („kein Zugriff")', p.length === 1 && p[0].id === eC && zeile(eC).grund === 'kein Zugriff' && SENT.length === 0);
    await req(server, 'DELETE', `/api/projects/${proj.id}/purge`, tok.carla);
    ok('Projekt endgültig gelöscht → Erinnerungen an seine Notiz sind weg', !db.prepare('SELECT 1 FROM notes WHERE id = ?').get(pn)
      && db.prepare('SELECT COUNT(*) AS n FROM notiz_erinnerungen WHERE note_id = ?').get(pn).n === 0);

    console.log('Grenzen, Löschen, Aufräumen');
    const n2 = (await req(server, 'POST', '/api/notes', tok.olga, { title: 'Viele' })).body.note.id;
    let letzte;
    for (let i = 0; i < 21; i++) letzte = await stellen('olga', n2, tag(20), String(7 + Math.floor(i / 6)).padStart(2, '0') + ':' + String((i % 6) * 10).padStart(2, '0'));
    ok('höchstens 20 je Person und Notiz (die 21. → 409)', letzte.status === 409 && N.anzahl(db, ids.olga, n2) === 20);
    await stellen('lena', n1, tag(30), '07:00');
    await req(server, 'DELETE', '/api/notes/' + n1, tok.olga);
    ok('Notiz gelöscht → alle Erinnerungen daran sind weg', db.prepare('SELECT COUNT(*) AS n FROM notiz_erinnerungen WHERE note_id = ?').get(n1).n === 0);
    // Xavers Erinnerung an der Projektnotiz ist mit dem Projekt gegangen — eine eigene Notiz mit Erinnerung
    const nx = (await req(server, 'POST', '/api/notes', tok.xaver, { title: 'Xavers Zettel' })).body.note.id;
    await stellen('xaver', nx, tag(40), '07:00');
    const vorher = db.prepare('SELECT COUNT(*) AS n FROM notiz_erinnerungen WHERE user_id = ?').get(ids.xaver).n;
    db.prepare('DELETE FROM users WHERE id = ?').run(ids.xaver);
    reste.nachLoeschen(db, 'users');
    ok('Konto gelöscht → seine Erinnerungen sind weg (reste.js)', vorher === 1 && db.prepare('SELECT COUNT(*) AS n FROM notiz_erinnerungen WHERE user_id = ?').get(ids.xaver).n === 0);

    console.log('Datenauskunft, Protokoll');
    const auskunft = (await req(server, 'GET', '/api/users/meine-daten', tok.olga)).body || {};
    ok('Datenauskunft enthält die eigenen Notiz-Erinnerungen', Array.isArray(auskunft.meine_erinnerungen_an_notizen) && auskunft.meine_erinnerungen_an_notizen.length === 20
      && auskunft.meine_erinnerungen_an_notizen.every(e => e.user_id === ids.olga));
    const log = (await req(server, 'GET', '/api/audit?limit=500', tok.adam)).body.logs || [];
    const arten = new Set(log.map(x => x.action));
    const fehlt = ['notiz_erinnerung_create', 'notiz_erinnerung_delete', 'notiz_erinnerung_ausgeloest', 'notiz_erinnerung_verpasst'].filter(x => !arten.has(x));
    ok('Stellen, Löschen, Auslösen, Verfallen stehen im Protokoll', fehlt.length === 0, 'fehlt: ' + fehlt.join(', '));
    const gestellt = log.find(x => x.action === 'notiz_erinnerung_create' && /Angebot muss raus/.test(x.details || ''));
    ok('… mit Titel und Zeitpunkt — aber nie mit dem Inhalt der Notiz', !!gestellt && gestellt.details.includes('„Angebot Gartenhütte"') && gestellt.details.includes(umText(`${tag(2)} 07:00`))
      && !log.some(x => /^notiz_erinnerung/.test(x.action) && /Geheimer Inhalt|4\.200/.test(x.details || '')), gestellt && gestellt.details);
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\nNotiz-Erinnerungen — Server und Zeitplaner: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
