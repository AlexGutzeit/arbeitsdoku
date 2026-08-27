// Push-Targeting-Test (in-process). Mockt web-push.sendNotification und prueft fuer jedes
// Ereignis exakt die Empfaenger (gegen die Badge-Logik), inkl. Ausschluss des Auslösers und
// Kategorie-Schalter. Bindet einen echten Express-Server auf einem Ephemeral-Port.
// Start:  node tests/push-targeting.js

const path = require('path');
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

// --- web-push mocken, BEVOR push.js geladen wird ---
const webpush = require('web-push');
let SENT = []; // { endpoint, payload }
webpush.sendNotification = (sub, payload) => {
  SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return Promise.resolve({ statusCode: 201 });
};

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/push-targeting-test.db';
process.env.VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
process.env.VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { computeBadgeCounts } = require('../routes/badges');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;

// Vergleicht die Menge der benachrichtigten Usernamen mit dem Erwarteten.
function expectTargets(name, expectedUsernames) {
  const got = [...new Set(SENT.map(s => s.endpoint.replace('sub://', '')))].sort();
  const exp = [...expectedUsernames].sort();
  const okk = got.length === exp.length && got.every((g, i) => g === exp[i]);
  if (okk) { pass++; console.log(`  ✓ ${name}  → [${got.join(', ')}]`); }
  else { fail++; console.log(`  ✗ ${name}  erwartet [${exp.join(', ')}] aber [${got.join(', ')}]`); }
}

function req(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const { port } = server.address();
    const r = http.request({ host: 'localhost', port, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await initDatabase();
  const db = getDb();

  // Bekanntes Passwort für alle Seed-User setzen + zwei Mitarbeiter sicherstellen.
  const hash = bcrypt.hashSync('pw123456', 10);
  db.prepare('UPDATE users SET password_hash = ?').run(hash);

  function ensureUser(username, name, role) {
    let u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (!u) {
      const r = db.prepare(
        "INSERT INTO users (username, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, 1, strftime('%Y-%m-%d %H:%M:%f','now'))"
      ).run(username, hash, name, role);
      db.prepare("INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, '2020-01-01', NULL)").run(r.lastInsertRowid);
      u = { id: r.lastInsertRowid };
    }
    return u.id;
  }
  // Seed hat: admin, chef, buchhalter, max (mitarbeiter)
  const ids = {
    admin: db.prepare("SELECT id FROM users WHERE username='admin'").get().id,
    chef: db.prepare("SELECT id FROM users WHERE username='chef'").get().id,
    buchhalter: db.prepare("SELECT id FROM users WHERE username='buchhalter'").get().id,
    max: db.prepare("SELECT id FROM users WHERE username='max'").get().id,
    lisa: ensureUser('lisa', 'Lisa Test', 'mitarbeiter'),
  };

  // Jeder User bekommt ein Geräte-Abo, dessen endpoint den Usernamen kodiert.
  for (const [uname, uid] of Object.entries(ids)) {
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')")
      .run(uid, 'sub://' + uname);
  }

  // Express-App wie in server.js (nur die relevanten Routen)
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/orders', require('../routes/orders'));
  app.use('/api/bulletin', require('../routes/bulletin'));
  app.use('/api/notes', require('../routes/notes'));
  app.use('/api/absences', require('../routes/absences'));
  app.use('/api/push', require('../routes/push'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const tokens = {};
  for (const uname of Object.keys(ids)) {
    const r = await req(server, 'POST', '/api/auth/login', null, { username: uname, password: 'pw123456' });
    tokens[uname] = r.body && r.body.token;
  }

  async function act(method, p, uname, body) {
    SENT = [];
    const r = await req(server, method, p, tokens[uname], body);
    await sleep(60); // fire-and-forget Push abwarten
    return r;
  }

  try {
    // 1. Bestellung von max → an alle, die bestellen duerfen
    //
    // Bis zum 27.08.2026 stand hier ['admin', 'chef']. Der Buchhalter DURFTE bestellen, bekam davon
    // aber weder Zaehler noch Meldung — er hatte den Knopf und erfuhr nie, dass etwas offen ist.
    // Alex hat das umgedreht: „wer bestellen kann, muss auch coin und push bekommen!"
    // Die Empfaengerliste kommt seitdem aus bestellrecht.js (SQL_BESTELLBERECHTIGT), damit sie
    // nicht wieder von darfBestellen() abweichen kann.
    await act('POST', '/api/orders', 'max', { product: 'Kabeltrommel', quantity: 3 });
    expectTargets('Bestellung → alle mit Bestellrecht', ['admin', 'buchhalter', 'chef']);
    {
      const okIcon = SENT.length && SENT.every(s => s.payload.icon === '/icons/cat-orders.png');
      if (okIcon) { pass++; console.log('  ✓ Bestellung nutzt Kategorie-Icon cat-orders'); }
      else { fail++; console.log('  ✗ Bestellung-Icon: ' + (SENT[0] && SENT[0].payload.icon)); }
    }

    // 2. Aushang von chef → alle außer chef
    await act('POST', '/api/bulletin', 'chef', { title: 'Betriebsausflug' });
    expectTargets('Aushang → alle außer Autor', ['admin', 'buchhalter', 'max', 'lisa']);

    // 3. Urlaubsantrag (self) von max → alle Manager
    await act('POST', '/api/absences', 'max', { type: 'urlaub', date_from: '2026-08-03', date_to: '2026-08-05' });
    expectTargets('Urlaubsantrag → Manager', ['admin', 'chef', 'buchhalter']);
    {
      const okIcon = SENT.length && SENT.every(s => s.payload.icon === '/icons/cat-absences.png');
      if (okIcon) { pass++; console.log('  ✓ Abwesenheit nutzt Kategorie-Icon cat-absences'); }
      else { fail++; console.log('  ✗ Abwesenheit-Icon: ' + (SENT[0] && SENT[0].payload.icon)); }
    }

    // 4. Krankmeldung (self) von max → alle Manager
    await act('POST', '/api/absences', 'max', { type: 'krank', date_from: '2026-09-01', date_to: '2026-09-02' });
    expectTargets('Krank gemeldet → Manager', ['admin', 'chef', 'buchhalter']);

    // 5. Chef trägt Urlaub für max ein (pending) → max muss bestätigen
    const r5 = await act('POST', '/api/absences', 'chef', { type: 'urlaub', date_from: '2026-08-10', date_to: '2026-08-12', target_user_id: ids.max });
    expectTargets('Manager-Eintrag für MA → der MA', ['max']);
    const maxUrlaubId = r5.body.absence.id;

    // 6. Chef genehmigt einen Selbstantrag von max → max
    const r6 = await act('POST', '/api/absences', 'max', { type: 'urlaub', date_from: '2026-10-01', date_to: '2026-10-02' });
    const selfReqId = r6.body.absence.id;
    await act('POST', `/api/absences/${selfReqId}/approve`, 'chef');
    expectTargets('Genehmigt → der MA', ['max']);

    // 7. Chef lehnt ab → max
    const r7 = await act('POST', '/api/absences', 'max', { type: 'urlaub', date_from: '2026-11-01', date_to: '2026-11-02' });
    await act('POST', `/api/absences/${r7.body.absence.id}/reject`, 'chef');
    expectTargets('Abgelehnt → der MA', ['max']);

    // 8. Notiz anbieten max → lisa
    const note = await act('POST', '/api/notes', 'max', { title: 'Übergabe' });
    const noteId = note.body.note.id;
    await act('POST', `/api/notes/${noteId}/offer`, 'max', { user_ids: [ids.lisa] });
    expectTargets('Notiz angeboten → Empfänger', ['lisa']);

    // 9. Notiz teilen mit lisa (neu) → lisa
    await act('PUT', `/api/notes/${noteId}/shares`, 'max', { shares: [{ user_id: ids.lisa, permission: 'read' }] });
    expectTargets('Notiz geteilt → neuer Empfänger', ['lisa']);

    // 9b. Erneutes Speichern derselben Freigabe → kein neuer Empfänger → kein Push
    await act('PUT', `/api/notes/${noteId}/shares`, 'max', { shares: [{ user_id: ids.lisa, permission: 'write' }] });
    expectTargets('Notiz-Freigabe unverändert → kein Push', []);

    // 9c. Notiz BEARBEITEN (Alex, 18.08.2026): Der Eigentuemer bekam bisher gar nichts, obwohl der
    // Kategorie-Schalter an war — die Speichern-Route verschickte schlicht keinen Push. Jetzt geht
    // die Meldung an Eigentuemer UND Mitleser, nur nicht an den Bearbeiter selbst.
    // lisa hat aus Schritt 9b Schreibrecht; sie bearbeitet, max ist Eigentuemer.
    await act('PUT', `/api/notes/${noteId}`, 'lisa', { title: 'Übergabe', body: 'Zaehler abgelesen' });
    expectTargets('Notiz bearbeitet → Eigentümer', ['max']);

    // Und die Gegenprobe, die den eigentlichen Zweck absichert: Bearbeitet der EIGENTUEMER selbst,
    // darf er sich nicht selbst benachrichtigen — die Mitleser aber schon.
    await act('PUT', `/api/notes/${noteId}`, 'max', { title: 'Übergabe', body: 'Nachtrag' });
    expectTargets('Eigentümer bearbeitet → Mitleser, nicht er selbst', ['lisa']);

    // Text der Meldung: Name des Bearbeiters und Titel der Notiz muessen drinstehen, sonst weiss
    // der Empfaenger nicht, worum es geht.
    const meldung = SENT[0] && SENT[0].payload;
    const textOk = meldung && /Max/i.test(meldung.body) && /Übergabe/.test(meldung.body) && meldung.title === 'Notiz bearbeitet';
    if (textOk) { pass++; console.log(`  ✓ Meldungstext nennt Bearbeiter und Notiz  → „${meldung.body}"`); }
    else { fail++; console.log('  ✗ Meldungstext: ' + JSON.stringify(meldung)); }

    // 9d. LEER-Speichern (Alex, 18.08.2026): aufmachen, nichts aendern, speichern.
    // Weder Meldung noch Zaehler duerfen anspringen. Der Zaehler haengt an `updated_at`, deshalb
    // wird hier BEIDES geprueft — ein unterdrueckter Push allein wuerde den Coin nicht verhindern.
    const dbNow = getDb();
    const vorher = dbNow.prepare('SELECT updated_at, updated_by FROM notes WHERE id = ?').get(noteId);
    const zaehlerVorher = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).notes;
    await act('PUT', `/api/notes/${noteId}`, 'lisa', { title: 'Übergabe', body: 'Nachtrag' });  // exakt der Stand von eben
    expectTargets('Leer-Speichern → kein Push', []);
    const nachher = dbNow.prepare('SELECT updated_at, updated_by FROM notes WHERE id = ?').get(noteId);
    const zaehlerNachher = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).notes;
    if (nachher.updated_at === vorher.updated_at && nachher.updated_by === vorher.updated_by) {
      pass++; console.log('  ✓ Leer-Speichern lässt den Zeitstempel unangetastet');
    } else { fail++; console.log(`  ✗ Zeitstempel bewegt: ${vorher.updated_at}/${vorher.updated_by} → ${nachher.updated_at}/${nachher.updated_by}`); }
    if (zaehlerNachher === zaehlerVorher) {
      pass++; console.log(`  ✓ Leer-Speichern erhöht den Zähler nicht  → ${zaehlerVorher}`);
    } else { fail++; console.log(`  ✗ Zähler gesprungen: ${zaehlerVorher} → ${zaehlerNachher}`); }

    // Und die Sperre muss trotzdem geloest sein, sonst haengt die Notiz fuer alle anderen fest.
    const sperre = dbNow.prepare('SELECT editing_by FROM notes WHERE id = ?').get(noteId).editing_by;
    if (!sperre) { pass++; console.log('  ✓ … die Bearbeitungs-Sperre ist trotzdem gelöst'); }
    else { fail++; console.log('  ✗ Notiz bleibt gesperrt (editing_by=' + sperre + ')'); }

    // Gegenprobe: EINE echte Aenderung — jetzt muss beides anspringen.
    await act('PUT', `/api/notes/${noteId}`, 'lisa', { title: 'Übergabe', body: 'Wirklich geändert' });
    expectTargets('Echte Änderung → Push an Eigentümer', ['max']);
    const zaehlerEcht = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).notes;
    if (zaehlerEcht > zaehlerVorher) { pass++; console.log(`  ✓ … und der Zähler zählt sie  → ${zaehlerVorher} → ${zaehlerEcht}`); }
    else { fail++; console.log(`  ✗ Zähler blieb bei ${zaehlerEcht}`); }

    // Nur Leerzeichen drumherum ist KEINE Aenderung (gespeichert wird ohnehin getrimmt).
    await act('PUT', `/api/notes/${noteId}`, 'lisa', { title: '  Übergabe  ', body: 'Wirklich geändert\n' });
    expectTargets('Nur Leerzeichen geändert → kein Push', []);

    // Kategorie-Schalter greift auch hier: max schaltet Notizen ab → keine Meldung mehr an ihn.
    await req(server, 'PUT', '/api/push/prefs', tokens.max, { notes: false });
    await act('PUT', `/api/notes/${noteId}`, 'lisa', { title: 'Übergabe', body: 'Noch ein Nachtrag' });
    expectTargets('Notiz bearbeitet, Schalter aus → kein Push', []);
    await req(server, 'PUT', '/api/push/prefs', tokens.max, { notes: true });

    // 9e. Schwarzes Brett, gleiche Regel (Alex, 18.08.2026): Anlegen meldet, Bearbeiten nur bei
    // echter Aenderung. Der Zaehler haengt auch hier an `updated_at`, also wird beides geprueft.
    const aushang = await act('POST', '/api/bulletin', 'chef', { title: 'Betriebsversammlung', text: 'Freitag 15 Uhr' });
    expectTargets('Neuer Aushang → alle außer Autor', ['admin', 'buchhalter', 'lisa', 'max']);
    const aushangId = (aushang.body.entry || aushang.body).id;

    // max hat alles gelesen — erst dadurch sagt der Zaehler ueberhaupt etwas aus. (Der Zaehler zaehlt
    // EINTRAEGE seit dem letzten Hinsehen, nicht Aenderungen: Ohne dieses Zuruecksetzen war der
    // frisch angelegte Aushang schon mitgezaehlt und konnte durch eine Bearbeitung gar nicht mehr
    // steigen — meine erste Erwartung war deshalb falsch, nicht der Code.)
    const gelesen = (uid, topic) => dbNow.prepare(
      "INSERT INTO user_seen (user_id, topic, seen_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f','now')) " +
      "ON CONFLICT(user_id, topic) DO UPDATE SET seen_at = strftime('%Y-%m-%d %H:%M:%f','now')").run(uid, topic);
    gelesen(ids.max, 'bulletin');
    const bZaehlerVor = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).bulletin;
    if (bZaehlerVor === 0) { pass++; console.log('  ✓ … nach dem Lesen steht der Zähler auf 0'); }
    else { fail++; console.log(`  ✗ Zähler nach dem Lesen: ${bZaehlerVor}`); }

    const bVor = dbNow.prepare('SELECT updated_at, updated_by FROM bulletin_entries WHERE id = ?').get(aushangId);
    await act('PUT', `/api/bulletin/${aushangId}`, 'chef', { title: 'Betriebsversammlung', text: 'Freitag 15 Uhr' });
    expectTargets('Aushang leer gespeichert → kein Push', []);
    const bNach = dbNow.prepare('SELECT updated_at, updated_by FROM bulletin_entries WHERE id = ?').get(aushangId);
    const bZaehlerNach = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).bulletin;
    if (bNach.updated_at === bVor.updated_at) { pass++; console.log('  ✓ … Zeitstempel des Aushangs unangetastet'); }
    else { fail++; console.log(`  ✗ Zeitstempel bewegt: ${bVor.updated_at} → ${bNach.updated_at}`); }
    if (bZaehlerNach === 0) { pass++; console.log('  ✓ … und der Coin springt nicht an  → 0'); }
    else { fail++; console.log(`  ✗ Coin gesprungen: 0 → ${bZaehlerNach}`); }

    await act('PUT', `/api/bulletin/${aushangId}`, 'chef', { title: 'Betriebsversammlung', text: 'Freitag 16 Uhr' });
    expectTargets('Aushang wirklich geändert → alle außer Autor', ['admin', 'buchhalter', 'lisa', 'max']);
    const bZaehlerEcht = computeBadgeCounts(dbNow, { id: ids.max, role: 'mitarbeiter' }).bulletin;
    if (bZaehlerEcht === 1) { pass++; console.log('  ✓ … und DANN springt der Coin an  → 0 → 1'); }
    else { fail++; console.log(`  ✗ Coin blieb bei ${bZaehlerEcht}`); }

    // Ein NICHT mitgeschicktes Feld heisst „unveraendert lassen" — und darf deshalb auch nichts ausloesen.
    await act('PUT', `/api/bulletin/${aushangId}`, 'chef', { title: 'Betriebsversammlung' });
    expectTargets('Aushang ohne Textfeld gespeichert → kein Push', []);

    // 10. Kategorie-Schalter: chef schaltet Bestellungen ab → er faellt raus, die anderen bleiben.
    // Das Recht entscheidet, WER in Frage kommt; der Schalter, wer davon wirklich etwas hoert.
    await req(server, 'PUT', '/api/push/prefs', tokens.chef, { orders: false });
    await act('POST', '/api/orders', 'max', { product: 'Schrauben', quantity: 10 });
    expectTargets('Bestellung mit chef-Pref aus → ohne chef', ['admin', 'buchhalter']);
    await req(server, 'PUT', '/api/push/prefs', tokens.chef, { orders: true });

    // 11. Auslöser-Ausschluss: chef legt Aushang an, hat selbst ein Abo → bekommt selbst nichts
    await act('POST', '/api/bulletin', 'chef', { title: 'Zweiter Aushang' });
    const chefGot = SENT.some(s => s.endpoint === 'sub://chef');
    if (!chefGot) { pass++; console.log('  ✓ Auslöser (chef) bekommt eigenen Aushang NICHT'); }
    else { fail++; console.log('  ✗ Auslöser (chef) hat fälschlich Push bekommen'); }

    // 11b. Ausgestellter (deaktivierter) Nutzer bekommt NIE Push — zentrale Sperre in notifyUsers,
    //      selbst wenn ein Ausloeser ihn direkt adressiert (hier Notiz-Angebot an lisa).
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ids.lisa);
    await act('POST', `/api/notes/${noteId}/offer`, 'max', { user_ids: [ids.lisa] });
    expectTargets('Ausgestellter Nutzer → kein Push', []);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ids.lisa); // fuer Folgetests reaktivieren

    // 12. Abgelaufenes Abo (410) wird beim Senden entfernt.
    webpush.sendNotification = (sub) => {
      if (sub.endpoint === 'sub://lisa') return Promise.reject({ statusCode: 410 });
      return Promise.resolve({ statusCode: 201 });
    };
    const before = db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='sub://lisa'").get().n;
    await act('POST', '/api/bulletin', 'chef', { title: 'Dritter Aushang' });
    const after = db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint='sub://lisa'").get().n;
    if (before === 1 && after === 0) { pass++; console.log('  ✓ Abgelaufenes Abo (410) wird entfernt'); }
    else { fail++; console.log(`  ✗ 410-Bereinigung: vorher ${before}, nachher ${after}`); }

  } finally {
    server.close();
  }

  console.log(`\nPush-Targeting: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
