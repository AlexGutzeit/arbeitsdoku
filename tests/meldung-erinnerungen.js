// Persönliche Erinnerungen an Meldungen — Server und Zeitplaner (Alex, 01.10.2026).
//
// Alex: „Was, wenn der Termin zur Reparatur oder zum TÜV erst in vier Wochen ist? Bis dahin habe ich ihn vergessen."
// Eine oder mehrere Erinnerungen mit Datum und Uhrzeit; dann wieder Zähler, Erinnerungs-Push und Hervorheben.
// Erledigt → die Erinnerungen ruhen (nicht gelöscht); wieder geöffnet → wieder aktiv.
// Entschieden: immer nur für den, der sie stellt; nur Bearbeiter stellen sie; in der Pause verpasst = verfällt;
// Push über den Schalter „Meldungen".
// Der Zeitplaner (faelligePruefen) läuft mit GESTELLTER Uhr, die nur vorwärts geht; die Zeiten liegen relativ zu
// heute (Zeitfallen: reference_tests_zeitfallen).
//
// In-Process, web-push abgefangen.
//   node tests/meldung-erinnerungen.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => { SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return Promise.resolve({ statusCode: 201 }); };

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/meldung-erinnerungen.db';
process.env.VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
process.env.VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const E = require('../meldung-erinnerungen');
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
// Ein Zeitpunkt, der in Berlin genau „datum uhrzeit" ist (sommerzeitfest)
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
  for (const [u, n, rolle, recht] of [['carla', 'Carla Chef', 'chef', 0], ['bernd', 'Bernd Zweitchef', 'chef', 0], ['adam', 'Adam Admin', 'admin', 0],
    ['vera', 'Vera Vorarbeit', 'mitarbeiter', 1], ['anna', 'Anna Berger', 'mitarbeiter', 0]]) {
    ids[u] = db.prepare('INSERT INTO users (username, password_hash, name, role, can_meldungen) VALUES (?, ?, ?, ?, ?)').run(u, hash, n, rolle, recht).lastInsertRowid;
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')").run(ids[u], 'sub://' + u);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/meldungen', require('../routes/meldungen'));
  app.use('/api/badges', require('../routes/badges'));
  app.use('/api/audit', require('../routes/audit'));
  app.use('/api/users', require('../routes/users'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const tok = {};
  for (const u of Object.keys(ids)) tok[u] = (await req(server, 'POST', '/api/auth/login', null, { username: u, password: 'pw123456' })).body.token;

  const pruefen = async (datum, uhrzeit) => { SENT = []; const p = E.faelligePruefen(db, berlin(datum, uhrzeit)); await sleep(80); return p; };
  const stellen = (u, meldungId, datum, uhrzeit, hinweis) => req(server, 'POST', `/api/meldungen/${meldungId}/erinnerungen`, tok[u], { datum, uhrzeit, hinweis });
  const zeile = (id) => db.prepare('SELECT * FROM meldung_erinnerungen WHERE id = ?').get(id);
  const eigeneIn = async (u, meldungId, pfad) => {
    const r = await req(server, 'GET', pfad || '/api/meldungen', tok[u]);
    const m = (r.body.meldungen || []).find(x => x.id === meldungId);
    return m ? m.erinnerungen : null;
  };
  const coin = async (u) => (await req(server, 'GET', '/api/badges', tok[u])).body;

  try {
    const thema = (await req(server, 'POST', '/api/meldungen/themen', tok.carla, { name: 'Auto 2' })).body.thema.id;
    const thema2 = (await req(server, 'POST', '/api/meldungen/themen', tok.carla, { name: 'Halle' })).body.thema.id;
    const m1 = (await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: thema, text: 'TÜV abgelaufen, Termin steht in 4 Wochen' })).body.meldung.id;
    for (const u of Object.keys(ids)) await req(server, 'POST', '/api/badges/meldungen', tok[u]);   // alles gesehen

    console.log('Wer darf');
    ok('Mitarbeiterin ohne Recht stellt keine Erinnerung (403)', (await stellen('anna', m1, tag(2), '07:00')).status === 403);
    ok('ohne Datum → 400', /Datum/.test((await stellen('carla', m1, '', '07:00')).body.error || ''));
    ok('vorbei → 400', /vorbei/.test((await stellen('carla', m1, tag(-1), '07:00')).body.error || ''));
    ok('Hinweis zu lang → 400', /zu lang/.test((await stellen('carla', m1, tag(2), '07:00', 'x'.repeat(201))).body.error || ''));
    const a1 = await stellen('carla', m1, tag(2), '07:00', '  Werkstatt   Müller, 9 Uhr ');
    ok('Chefin stellt eine (201) — Hinweis aufgeräumt', a1.status === 201 && a1.body.erinnerungen.length === 1
      && a1.body.erinnerungen[0].um === `${tag(2)} 07:00` && a1.body.erinnerungen[0].hinweis === 'Werkstatt Müller, 9 Uhr' && a1.body.erinnerungen[0].stand === 'wartet', JSON.stringify(a1.body));
    const a2 = await stellen('vera', m1, tag(3), '08:00');
    ok('mit Einzelrecht auch (201)', a2.status === 201);
    const eCarla = a1.body.id, eVera = a2.body.id;

    console.log('Nur für mich');
    ok('Carla sieht nur ihre eigene', JSON.stringify((await eigeneIn('carla', m1)).map(e => e.id)) === JSON.stringify([eCarla]));
    ok('Vera sieht nur ihre eigene', JSON.stringify((await eigeneIn('vera', m1)).map(e => e.id)) === JSON.stringify([eVera]));
    ok('der zweite Chef und die Melderin sehen keine', (await eigeneIn('bernd', m1)).length === 0 && (await eigeneIn('anna', m1)).length === 0);
    const det = (await req(server, 'GET', '/api/meldungen/' + m1, tok.carla)).body;
    ok('Detail: ebenfalls nur die eigene', det.meldung.erinnerungen.length === 1 && det.meldung.erinnerungen[0].id === eCarla);
    ok('fremde ändern / löschen → 404 (gibt es für sie nicht)', (await req(server, 'PUT', '/api/meldungen/erinnerungen/' + eVera, tok.carla, { datum: tag(4), uhrzeit: '07:00' })).status === 404
      && (await req(server, 'DELETE', '/api/meldungen/erinnerungen/' + eVera, tok.carla)).status === 404 && zeile(eVera));
    ok('nicht im Verlauf der Meldung (den alle lesen)', det.verlauf.length === 1 && det.verlauf[0].art === 'gemeldet', JSON.stringify(det.verlauf));
    ok('stellen ändert die Meldung nicht (kein Zähler, keine Push für andere)', (await coin('bernd')).meldungen === 0 && (await coin('anna')).meldungen === 0);

    console.log('Zur Zeit: Push, Zähler, nur einmal');
    ok('eine Minute vorher: nichts', (await pruefen(tag(2), '06:59')).length === 0);
    let p = await pruefen(tag(2), '07:00');
    ok('zur Minute: ausgelöst', p.length === 1 && p[0].id === eCarla && p[0].stand === 'ausgeloest', JSON.stringify(p));
    ok('… Push NUR an Carla, mit Hinweis und Text, Antippen führt zur Meldung', SENT.length === 1 && SENT[0].endpoint === 'sub://carla'
      && SENT[0].payload.title === '🔔 Erinnerung: Auto 2' && SENT[0].payload.body === 'Werkstatt Müller, 9 Uhr — TÜV abgelaufen, Termin steht in 4 Wochen'
      && SENT[0].payload.ziel && SENT[0].payload.ziel.art === 'meldung' && SENT[0].payload.ziel.id === m1, JSON.stringify(SENT));
    const cc = await coin('carla');
    ok('… Carlas Zähler steigt (Erinnerung)', cc.meldungen === 1 && cc.meldungenErinnerungen === 1, JSON.stringify(cc));
    ok('… beim zweiten Chef nicht', (await coin('bernd')).meldungen === 0);
    ok('… in der Liste: „ausgeloest" mit Zeitpunkt (für die Marke „🔔 Erinnerung")', (await eigeneIn('carla', m1))[0].stand === 'ausgeloest' && !!(await eigeneIn('carla', m1))[0].stand_am);
    ok('dieselbe Minute und später: keine zweite', (await pruefen(tag(2), '07:00')).length === 0 && (await pruefen(tag(2), '09:00')).length === 0 && SENT.length === 0);
    await req(server, 'POST', '/api/badges/meldungen', tok.carla);
    ok('Meldungen angesehen → Zähler wieder 0', (await coin('carla')).meldungen === 0);
    p = await pruefen(tag(3), '08:00');
    ok('Veras Erinnerung kommt nur bei Vera', p.length === 1 && p[0].id === eVera && SENT.length === 1 && SENT[0].endpoint === 'sub://vera', JSON.stringify(SENT.map(s => s.endpoint)));

    console.log('Push-Schalter „Meldungen" aus');
    db.prepare('INSERT INTO push_prefs (user_id, meldungen) VALUES (?, 0) ON CONFLICT(user_id) DO UPDATE SET meldungen = 0').run(ids.carla);
    const a3 = (await stellen('carla', m1, tag(4), '07:00')).body.id;
    p = await pruefen(tag(4), '07:00');
    ok('… keine Push, aber ausgelöst und gezählt', p.length === 1 && p[0].id === a3 && SENT.length === 0 && (await coin('carla')).meldungenErinnerungen === 1, JSON.stringify(SENT));
    db.prepare('UPDATE push_prefs SET meldungen = 1 WHERE user_id = ?').run(ids.carla);
    await req(server, 'POST', '/api/badges/meldungen', tok.carla);

    console.log('Erledigt: ruhen, verpasst = verfällt, wieder offen = wieder aktiv');
    const rA = (await stellen('carla', m1, tag(5), '07:00', 'A')).body.id;
    const rB = (await stellen('carla', m1, tag(9), '07:00', 'B')).body.id;
    await req(server, 'POST', `/api/meldungen/${m1}/status`, tok.bernd, { status: 'erledigt' });
    const hist = await eigeneIn('carla', m1, '/api/meldungen/history');
    ok('in der History: beide wartend (ruhen), nichts gelöscht', hist && hist.filter(e => e.stand === 'wartet').map(e => e.id).join() === [rA, rB].join(), JSON.stringify(hist));
    ok('neue stellen geht nicht, solange sie ruht (409)', (await stellen('carla', m1, tag(6), '07:00')).status === 409);
    p = await pruefen(tag(5), '07:00');
    ok('A fällt in die Pause → verpasst („Meldung ruhte"), keine Push', p.length === 1 && p[0].id === rA && zeile(rA).stand === 'verpasst' && zeile(rA).grund === 'Meldung ruhte' && SENT.length === 0, JSON.stringify(p));
    ok('… und zählt nicht', (await coin('carla')).meldungenErinnerungen === 0);
    await req(server, 'POST', `/api/meldungen/${m1}/status`, tok.bernd, { status: 'offen' });
    ok('wieder offen: A kommt NICHT nach', (await pruefen(tag(5), '08:00')).length === 0 && zeile(rA).stand === 'verpasst');
    p = await pruefen(tag(9), '07:00');
    ok('… B ist wieder aktiv und kommt', p.length === 1 && p[0].id === rB && p[0].stand === 'ausgeloest' && SENT.length === 1 && SENT[0].payload.body.startsWith('B — '), JSON.stringify(p));
    const neu = await req(server, 'PUT', '/api/meldungen/erinnerungen/' + rA, tok.carla, { datum: tag(12), uhrzeit: '06:30', hinweis: 'A neu' });
    ok('verpasste mit neuem Datum: wieder scharf', neu.status === 200 && zeile(rA).stand === 'wartet' && zeile(rA).grund === null && zeile(rA).stand_am === null && zeile(rA).um === `${tag(12)} 06:30`);
    p = await pruefen(tag(12), '06:30');
    ok('… und kommt zur neuen Zeit', p.length === 1 && p[0].id === rA && SENT.length === 1);

    console.log('Recht weg, ausgestellt, Thema gelöscht');
    const v2 = (await stellen('vera', m1, tag(14), '07:00')).body.id;
    db.prepare('UPDATE users SET can_meldungen = 0 WHERE id = ?').run(ids.vera);
    p = await pruefen(tag(14), '07:00');
    ok('Recht entzogen → verfällt („ohne Recht"), keine Push', p.length === 1 && p[0].id === v2 && zeile(v2).grund === 'ohne Recht' && SENT.length === 0);
    const veraTok = (await req(server, 'POST', '/api/auth/login', null, { username: 'vera', password: 'pw123456' })).body.token;
    ok('… ändern darf sie nicht mehr (403), löschen schon', (await req(server, 'PUT', '/api/meldungen/erinnerungen/' + v2, veraTok, { datum: tag(20), uhrzeit: '07:00' })).status === 403
      && (await req(server, 'DELETE', '/api/meldungen/erinnerungen/' + v2, veraTok)).status === 200 && !zeile(v2));
    const b1 = (await stellen('bernd', m1, tag(15), '07:00')).body.id;
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ids.bernd);
    p = await pruefen(tag(15), '07:00');
    ok('ausgestellt → verfällt, keine Push', p.length === 1 && p[0].id === b1 && zeile(b1).stand === 'verpasst' && SENT.length === 0);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ids.bernd);
    const m2 = (await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: thema2, text: 'Tor klemmt' })).body.meldung.id;
    const t1 = (await stellen('carla', m2, tag(16), '07:00')).body.id;
    await req(server, 'DELETE', `/api/meldungen/themen/${thema2}`, tok.carla);
    p = await pruefen(tag(16), '07:00');
    ok('Thema gelöscht → Meldung in der History → verfällt', p.length === 1 && p[0].id === t1 && zeile(t1).grund === 'Meldung ruhte' && SENT.length === 0);

    console.log('Grenzen, Löschen, Aufräumen');
    const m3 = (await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: thema, text: 'Reifen wechseln' })).body.meldung.id;
    let letzte;
    for (let i = 0; i < 21; i++) letzte = await stellen('carla', m3, tag(30), String(7 + Math.floor(i / 6)).padStart(2, '0') + ':' + String((i % 6) * 10).padStart(2, '0'));
    ok(`höchstens ${E.MAX_JE_MELDUNG} je Person und Meldung (die 21. → 409)`, letzte.status === 409 && E.anzahl(db, ids.carla, m3) === 20);
    const loe = await req(server, 'DELETE', '/api/meldungen/erinnerungen/' + eCarla, tok.carla);
    ok('eigene löschen (auch eine schon gekommene)', loe.status === 200 && !zeile(eCarla) && !loe.body.erinnerungen.some(e => e.id === eCarla));
    await req(server, 'DELETE', '/api/meldungen/' + m3, tok.adam);
    ok('Meldung endgültig gelöscht (Admin) → ihre Erinnerungen sind weg', db.prepare('SELECT COUNT(*) AS n FROM meldung_erinnerungen WHERE meldung_id = ?').get(m3).n === 0);
    const vorher = db.prepare('SELECT COUNT(*) AS n FROM meldung_erinnerungen WHERE user_id = ?').get(ids.bernd).n;
    db.prepare('DELETE FROM users WHERE id = ?').run(ids.bernd);
    reste.nachLoeschen(db, 'users');
    ok('Konto gelöscht → seine Erinnerungen sind weg (reste.js)', vorher === 1 && db.prepare('SELECT COUNT(*) AS n FROM meldung_erinnerungen WHERE user_id = ?').get(ids.bernd).n === 0);

    console.log('Zusammenfassung, Datenauskunft, Protokoll');
    ok('Zusammenfassung (ohne Recht): Erinnerungen zählen dort nicht mit',
      buildSummaryText(['meldungen'], { meldungenBearbeiter: false, meldungen: 2, meldungenErinnerungen: 2 }) === 'Es gibt nichts zu tun.'
      && buildSummaryText(['meldungen'], { meldungenBearbeiter: false, meldungen: 3, meldungenErinnerungen: 2 }) === 'Du hast noch 1 Neuigkeit zu deinen Meldungen zu bearbeiten.',
      buildSummaryText(['meldungen'], { meldungenBearbeiter: false, meldungen: 3, meldungenErinnerungen: 2 }));
    const auskunft = (await req(server, 'GET', '/api/users/meine-daten', tok.carla)).body || {};
    const meine = auskunft.meine_erinnerungen_an_meldungen || (auskunft.daten || {}).meine_erinnerungen_an_meldungen;
    ok('Datenauskunft enthält die eigenen Erinnerungen', Array.isArray(meine) && meine.length > 0 && meine.every(e => e.user_id === ids.carla), Object.keys(auskunft).join(','));
    const log = (await req(server, 'GET', '/api/audit?limit=500', tok.adam)).body.logs || [];
    const arten = new Set(log.map(x => x.action));
    const fehlt = ['meldung_erinnerung_create', 'meldung_erinnerung_update', 'meldung_erinnerung_delete', 'meldung_erinnerung_ausgeloest', 'meldung_erinnerung_verpasst'].filter(x => !arten.has(x));
    ok('Stellen, Ändern, Löschen, Auslösen, Verfallen stehen im Protokoll', fehlt.length === 0, 'fehlt: ' + fehlt.join(', '));
    const gestellt = log.find(x => x.action === 'meldung_erinnerung_create' && /Werkstatt Müller/.test(x.details || ''));
    ok('… mit Zeitpunkt und Hinweis', !!gestellt && gestellt.details.includes(E.umText(`${tag(2)} 07:00`)), gestellt && gestellt.details);
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\nMeldungs-Erinnerungen — Server und Zeitplaner: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
