// Regelmäßige Meldungen — Server und Zeitplaner (Etappe 3, 30.09.2026).
//
// Alex: „Regelmäßige Meldungen werden im gewählten Zeitintervall regelmäßig von selbst eingetragen, z. B. Auto 1 →
// jeden zweiten 1. März → TÜV"; „nur Chef/Admin erstellen sie"; mehrere Auslöser je Regel. Aus den Rückfragen:
// Vorlauf, Takt fest oder „ab Erledigung", keine Doppelten („erneut fällig"), Absender „automatisch", nach einem
// Ausfall nur die letzte verpasste Fälligkeit, Vergangenes vor dem Anlegen nie (außer überfällig „ab Erledigung"),
// Pause, Ende, Löschen lässt Erzeugtes stehen, Thema gelöscht → Regel endet.
// Der Zeitplaner (regelnPruefen) läuft hier mit GESTELLTER Uhr — die Daten liegen relativ zu heute, damit der
// Test an jedem Tag dasselbe prüft (Zeitfallen: reference_tests_zeitfallen).
//
// In-Process, web-push abgefangen.
//   node tests/meldung-regeln-api.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => { SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return Promise.resolve({ statusCode: 201 }); };

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/meldung-regeln-api.db';
// Schlüsselpaar nur für diesen Lauf — im Repo steht kein privater Schlüssel (GitGuardian, 01.10.2026)
{ const k = require('web-push').generateVAPIDKeys(); process.env.VAPID_PUBLIC = k.publicKey; process.env.VAPID_PRIVATE = k.privateKey; }
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const R = require('../meldung-regeln');
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
  for (const [u, n, rolle, recht] of [['carla', 'Carla Chef', 'chef', 0], ['adam', 'Adam Admin', 'admin', 0],
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
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const tok = {};
  for (const u of Object.keys(ids)) tok[u] = (await req(server, 'POST', '/api/auth/login', null, { username: u, password: 'pw123456' })).body.token;
  const pruefen = (datum, uhrzeit, regelId) => {
    const alle = R.regelnPruefen(db, berlin(datum, uhrzeit));
    return regelId ? alle.filter(x => x.regel === regelId) : alle;
  };
  const meldung = (id) => db.prepare('SELECT * FROM meldungen WHERE id = ?').get(id);
  const woche = (start, extra) => ({ text: extra && extra.text || 'Papiermüll rausstellen', uhrzeit: '07:00',
    ausloeser: [{ art: 'intervall', einheit: 'woche', n: 1, start_datum: start }], ...extra });

  try {
    const th = {};
    for (const n of ['Auto 1', 'Papiermüll', 'Weg']) th[n] = (await req(server, 'POST', '/api/meldungen/themen', tok.carla, { name: n })).body.thema.id;

    console.log('Rechte');
    ok('Mitarbeiterin legt keine Regel an (403)', (await req(server, 'POST', '/api/meldungen/regeln', tok.anna, { thema_id: th['Papiermüll'], ...woche(tag(3)) })).status === 403);
    ok('auch mit Einzelrecht nicht (nur Chef/Admin)', (await req(server, 'POST', '/api/meldungen/regeln', tok.vera, { thema_id: th['Papiermüll'], ...woche(tag(3)) })).status === 403);
    ok('ohne Thema → 400', (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, woche(tag(3)))).status === 400);
    ok('fehlerhaft → 400 mit Grund', /Uhrzeit/.test((await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Papiermüll'], ...woche(tag(3)), uhrzeit: '7 Uhr' })).body.error || ''));

    console.log('Vorschau und Anlegen');
    const vs = await req(server, 'POST', '/api/meldungen/regeln/vorschau', tok.carla, { text: 'TÜV', vorlauf_zahl: 4, vorlauf_einheit: 'woche',
      ausloeser: [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: tag(40) }] });
    ok('Vorschau: Beschreibung und die nächsten Fälligkeiten mit Auslösung', vs.status === 200 && /^alle 2 Jahre ab /.test(vs.body.beschreibung[0])
      && vs.body.naechste[0].faellig === tag(40) && vs.body.naechste[0].ausloesung === `${tag(12)} 07:00` && vs.body.naechste.length === 5, JSON.stringify(vs.body));
    const r1 = (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Papiermüll'], ...woche(tag(3)) })).body.regel;
    const r2 = (await req(server, 'POST', '/api/meldungen/regeln', tok.adam, { thema_id: th['Auto 1'], text: 'TÜV', dringend: true, vorlauf_zahl: 4, vorlauf_einheit: 'woche',
      ausloeser: [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: tag(40) }] })).body.regel;
    ok('zwei Regeln angelegt, mit nächster Fälligkeit', r1 && r1.naechste && r1.naechste.faellig === tag(3) && r2 && r2.naechste.faellig === tag(40), JSON.stringify({ r1: r1 && r1.naechste, r2: r2 && r2.naechste }));
    const alle = (await req(server, 'GET', '/api/meldungen', tok.anna)).body.regeln;
    ok('alle sehen die Regeln mit „demnächst" (auch die Mitarbeiterin)', alle.length === 2 && alle.every(x => x.naechste), JSON.stringify(alle.map(x => x.naechste)));

    console.log('Fällig zur Minute, keine Doppelten');
    ok('eine Minute vorher: nichts', pruefen(tag(3), '06:59', r1.id).length === 0);
    SENT = [];
    let e = pruefen(tag(3), '07:00', r1.id);
    ok('zur Minute: eine neue Meldung', e.length === 1 && e[0].art === 'neu' && e[0].faellig === tag(3), JSON.stringify(e));
    const m1 = meldung(e[0].meldung);
    ok('… „automatisch", mit Fälligkeitsdatum und Regel', m1.created_by === null && m1.faellig_am === tag(3) && m1.regel_id === r1.id && m1.thema_id === th['Papiermüll'] && m1.status === 'offen');
    const v1 = db.prepare('SELECT * FROM meldung_verlauf WHERE meldung_id = ?').all(m1.id);
    ok('… Verlauf: „automatisch (Regel von Carla Chef)"', v1.length === 1 && v1[0].art === 'gemeldet' && v1[0].user_name === 'automatisch (Regel von Carla Chef)', JSON.stringify(v1));
    await sleep(100);
    ok('… Push an Chef, Admin und Vera, genau zu dieser Meldung', ['carla', 'adam', 'vera'].every(u => SENT.some(s => s.endpoint === 'sub://' + u)) && !SENT.some(s => s.endpoint === 'sub://anna')
      && SENT.every(s => s.payload.ziel && s.payload.ziel.art === 'meldung' && s.payload.ziel.id === m1.id && s.payload.title === 'Neue Meldung: Papiermüll'), JSON.stringify(SENT.map(s => [s.endpoint, s.payload.title])));
    const c = (await req(server, 'GET', '/api/badges', tok.carla)).body.meldungen;
    ok('… und der Coin zählt sie (auch bei der, die die Regel angelegt hat)', c >= 1, String(c));
    ok('dieselbe Minute noch einmal: nichts (kein Doppel)', pruefen(tag(3), '07:00', r1.id).length === 0 && pruefen(tag(3), '09:30', r1.id).length === 0);

    console.log('Noch offen, wenn die nächste fällig wird');
    e = pruefen(tag(10), '07:00', r1.id);
    ok('„erneut fällig" statt einer zweiten Meldung', e.length === 1 && e[0].art === 'erneut' && e[0].meldung === m1.id, JSON.stringify(e));
    ok('… die Meldung trägt „erneut fällig am", der Verlauf auch', meldung(m1.id).erneut_faellig === tag(10)
      && db.prepare("SELECT COUNT(*) AS n FROM meldung_verlauf WHERE meldung_id = ? AND art = 'erneut_faellig'").get(m1.id).n === 1);
    ok('… und es gibt nur diese eine Meldung der Regel', db.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE regel_id = ?').get(r1.id).n === 1);

    console.log('Vorlauf');   // zeitlich hier: zwischen Tag 10 und Tag 17 (die gestellte Uhr läuft nur vorwärts)
    ok('TÜV (fällig in 40 Tagen, 4 Wochen Vorlauf): am Tag davor nichts', pruefen(tag(11), '07:00', r2.id).length === 0);
    e = pruefen(tag(12), '07:00', r2.id);
    ok('… 28 Tage vorher um 07:00: „TÜV", fällig am Tag 40, dringend', e.length === 1 && meldung(e[0].meldung).faellig_am === tag(40) && meldung(e[0].meldung).dringend === 1, JSON.stringify(e));

    console.log('Erledigt, dann die nächste');
    await req(server, 'POST', `/api/meldungen/${m1.id}/status`, tok.carla, { status: 'erledigt' });
    e = pruefen(tag(17), '07:00', r1.id);
    ok('nach „erledigt": die nächste Fälligkeit ist eine neue Meldung', e.length === 1 && e[0].art === 'neu' && e[0].meldung !== m1.id, JSON.stringify(e));
    const m2 = e[0].meldung;

    console.log('Nach einem Ausfall: nur die letzte');
    e = pruefen(tag(38), '07:00', r1.id);
    ok('drei Fälligkeiten verpasst: EIN Vorgang, zwei übersprungen', e.length === 1 && e[0].faellig === tag(38) && JSON.stringify(e[0].uebersprungen) === JSON.stringify([tag(24), tag(31)]), JSON.stringify(e));
    ok('… die offene Meldung ist „erneut fällig" zum letzten Termin', e[0].art === 'erneut' && e[0].meldung === m2 && meldung(m2).erneut_faellig === tag(38));
    ok('… und die übersprungenen kommen nie mehr', pruefen(tag(38), '07:05', r1.id).length === 0);

    console.log('Vergangenes wird nicht nachgeholt');
    const r4 = (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Papiermüll'], ...woche(tag(-14), { text: 'Gelbe Tonne', uhrzeit: '00:00' }) })).body.regel;
    e = R.regelnPruefen(db, new Date()).filter(x => x.regel === r4.id);
    ok('Start vor zwei Wochen: nur die von heute, die beiden vergangenen nicht (auch nicht als „übersprungen")', e.length === 1 && e[0].faellig === HEUTE && e[0].uebersprungen.length === 0, JSON.stringify(e));

    console.log('Ab Erledigung');
    const r3 = (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Auto 1'], text: 'Ölwechsel', takt: 'ab_erledigung',
      ausloeser: [{ art: 'intervall', einheit: 'monat', n: 12, start_datum: tag(-30) }] })).body.regel;
    e = R.regelnPruefen(db, new Date()).filter(x => x.regel === r3.id);
    ok('„letzter Ölwechsel ist überfällig": kommt sofort (ab Erledigung holt nach)', e.length === 1 && e[0].art === 'neu' && e[0].faellig === tag(-30), JSON.stringify(e));
    const oel = e[0].meldung;
    ok('solange sie offen ist: nichts Neues, auch Monate später', pruefen(R.plusMonate(HEUTE, 14), '07:00', r3.id).length === 0);
    await req(server, 'POST', `/api/meldungen/${oel}/status`, tok.carla, { status: 'erledigt' });
    const regelNachErledigung = (await req(server, 'GET', `/api/meldungen/regeln?thema_id=${th['Auto 1']}`, tok.carla)).body.regeln.find(x => x.id === r3.id);
    ok('erledigt heute: nächste Fälligkeit in 12 Monaten', regelNachErledigung.naechste && regelNachErledigung.naechste.faellig === R.plusMonate(HEUTE, 12), JSON.stringify(regelNachErledigung.naechste));
    ok('… am Tag davor nichts', pruefen(R.plusTage(R.plusMonate(HEUTE, 12), -1), '07:00', r3.id).length === 0);
    e = pruefen(R.plusMonate(HEUTE, 12), '07:00', r3.id);
    ok('… dann eine neue Meldung', e.length === 1 && e[0].art === 'neu' && e[0].meldung !== oel, JSON.stringify(e));

    console.log('Pause, Ende, Löschen, Thema weg');
    const r5 = (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Papiermüll'], ...woche(tag(50), { text: 'Blaue Tonne', ende_typ: 'anzahl', ende_anzahl: 2 }) })).body.regel;
    ok('pausieren', (await req(server, 'POST', `/api/meldungen/regeln/${r5.id}/pause`, tok.carla, { pausiert: true })).body.regel.pausiert === true);
    ok('pausiert: nichts', pruefen(tag(50), '07:00', r5.id).length === 0);
    await req(server, 'POST', `/api/meldungen/regeln/${r5.id}/pause`, tok.carla, { pausiert: false });
    e = pruefen(tag(50), '07:00', r5.id);
    ok('fortgesetzt: wieder da', e.length === 1 && e[0].art === 'neu');
    await req(server, 'POST', `/api/meldungen/${e[0].meldung}/status`, tok.carla, { status: 'erledigt' });
    e = pruefen(tag(57), '07:00', r5.id);
    ok('Ende nach 2 Mal: das zweite kommt …', e.length === 1 && e[0].art === 'neu');
    await req(server, 'POST', `/api/meldungen/${e[0].meldung}/status`, tok.carla, { status: 'erledigt' });
    ok('… ein drittes nicht', pruefen(tag(64), '07:00', r5.id).length === 0);
    const vorher = db.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE regel_id = ?').get(r1.id).n;
    ok('Regel löschen', (await req(server, 'DELETE', `/api/meldungen/regeln/${r1.id}`, tok.carla)).status === 200);
    ok('… erzeugte Meldungen bleiben, neue kommen keine', db.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE regel_id = ?').get(r1.id).n === vorher && pruefen(tag(45), '07:00', r1.id).length === 0);
    const r7 = (await req(server, 'POST', '/api/meldungen/regeln', tok.carla, { thema_id: th['Weg'], ...woche(tag(80), { text: 'Weg fegen' }) })).body.regel;
    await req(server, 'DELETE', `/api/meldungen/themen/${th['Weg']}`, tok.carla);
    ok('Thema (ohne Meldungen) gelöscht: seine Regel ist ganz weg, samt Auslöser', !db.prepare('SELECT 1 FROM meldung_regeln WHERE id = ?').get(r7.id)
      && !db.prepare('SELECT 1 FROM meldung_ausloeser WHERE regel_id = ?').get(r7.id) && pruefen(tag(80), '07:00', r7.id).length === 0);
    await req(server, 'DELETE', `/api/meldungen/themen/${th['Auto 1']}`, tok.carla);
    ok('Thema mit Meldungen gelöscht: seine Regeln enden (weich)', db.prepare('SELECT COUNT(*) AS n FROM meldung_regeln WHERE thema_id = ? AND deleted_at IS NULL').get(th['Auto 1']).n === 0
      && pruefen(R.plusMonate(HEUTE, 30), '07:00', r2.id).length === 0);

    console.log('Protokoll');
    const log = (await req(server, 'GET', '/api/audit?limit=500', tok.adam)).body.logs || [];
    const arten = new Set(log.map(x => x.action));
    const fehlt = ['meldung_regel_create', 'meldung_regel_pause', 'meldung_regel_delete', 'meldung_automatisch'].filter(x => !arten.has(x));
    ok('Regeln und automatische Meldungen stehen im Protokoll', fehlt.length === 0, 'fehlt: ' + fehlt.join(', '));
    const nachgeholt = log.find(x => x.action === 'meldung_automatisch' && /übersprungen/.test(x.details || ''));
    ok('… auch, dass beim Nachholen übersprungen wurde', !!nachgeholt, nachgeholt && nachgeholt.details);
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\nRegelmäßige Meldungen — Server und Zeitplaner: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
