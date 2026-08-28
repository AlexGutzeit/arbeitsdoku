// Bestellen, wenn Chef und Chefin im Urlaub sind (Alex, 25.08.2026)
//
// Bisher durften nur Admin, Chef und Buchhalter eine offene Bestellung abschliessen. Sind die
// Ersten beiden weg, steht der Einkauf. Das neue Einzelrecht `can_order` loest das — und bringt
// eine Pflicht mit: Wer es verliert, darf auch keine Bestell-Meldungen mehr bekommen.
//
// Drei Dinge, an denen wirklich etwas haengt:
//   * Das Recht muss serverseitig greifen, nicht nur den Knopf einblenden.
//   * Coin UND Push muessen mitziehen. Sonst haette ein Vorarbeiter den Knopf, erfuehre aber nie,
//     dass etwas zu bestellen ist — ausgerechnet waehrend des Urlaubs.
//   * Der Entzug muss aufraeumen: Push-Schalter, Kategorie in geplanten Zusammenfassungen, und
//     eine Zusammenfassung, die dadurch leer wird, ganz.
//
// In-Process wie tests/push-targeting.js, damit die Empfaenger EXAKT geprueft werden koennen.
//
//   node tests/bestellrecht.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

// web-push mocken, BEVOR push.js geladen wird.
const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => {
  SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return Promise.resolve({ statusCode: 201 });
};

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/bestellrecht-test.db';
process.env.VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
process.env.VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');
const { computeBadgeCounts } = require('../routes/badges');
const { darfBestellen, SQL_BESTELLBERECHTIGT, SQL_BESTELLROLLEN } = require('../bestellrecht');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

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
  const hash = bcrypt.hashSync('pw123456', 10);
  db.prepare('UPDATE users SET password_hash = ?').run(hash);

  const ids = {};
  for (const u of ['admin', 'chef', 'buchhalter', 'max']) {
    ids[u] = db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  }
  // Jeder bekommt ein Geraete-Abo, dessen endpoint den Namen kodiert.
  for (const [uname, uid] of Object.entries(ids)) {
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')").run(uid, 'sub://' + uname);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/orders', require('../routes/orders'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/badges', require('../routes/badges'));
  app.use('/api/push', require('../routes/push'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const tokens = {};
  async function anmelden(uname) {
    const r = await req(server, 'POST', '/api/auth/login', null, { username: uname, password: 'pw123456' });
    tokens[uname] = r.body && r.body.token;
    return r.body && r.body.user;
  }
  for (const u of Object.keys(ids)) await anmelden(u);

  // Empfaenger einer Aktion exakt bestimmen.
  async function act(method, p, uname, body) {
    SENT = [];
    const r = await req(server, method, p, tokens[uname], body);
    await sleep(80);
    return r;
  }
  const empfaenger = () => [...new Set(SENT.map(s => s.endpoint.replace('sub://', '')))].sort().join(',');
  const coinsVon = (uname) => computeBadgeCounts(db, db.prepare('SELECT id, role, can_order FROM users WHERE id = ?').get(ids[uname]));

  try {
    console.log('── Ohne Recht geht nichts ──');
    let r = await act('POST', '/api/orders', 'max', { product: 'Kabeltrommel', quantity: 3 });
    const bestellung = r.body.order;
    ok('Mitarbeiter darf anfordern', r.status === 201, r.status + '');
    // Bis zum 27.08.2026 stand hier 'admin,chef': Der Buchhalter DURFTE bestellen, bekam davon aber
    // weder Zaehler noch Meldung. Alex hat das umgedreht — „wer bestellen kann, muss auch coin und
    // push bekommen!" —, also gilt jetzt ueberall dieselbe Frage: darfBestellen().
    ok('… und die Meldung geht an alle, die bestellen dürfen', empfaenger() === 'admin,buchhalter,chef', empfaenger());
    ok('… sein eigener Bestell-Coin bleibt 0', coinsVon('max').orders === 0, JSON.stringify(coinsVon('max')));
    ok('… beim Chef steht er auf 1', coinsVon('chef').orders === 1, JSON.stringify(coinsVon('chef')));
    ok('… und beim Buchhalter ebenfalls', coinsVon('buchhalter').orders === 1, JSON.stringify(coinsVon('buchhalter')));

    r = await req(server, 'POST', `/api/orders/${bestellung.id}/order`, tokens.max);
    ok('„Bestellt" ist gesperrt (403)', r.status === 403, r.status + '');
    // Ein fremder Eintrag, an dem sich Aendern und Loeschen pruefen laesst.
    const fremd = (await act('POST', '/api/orders', 'chef', { product: 'Klemmen', quantity: 50 })).body.order;
    r = await req(server, 'PUT', `/api/orders/${fremd.id}`, tokens.max, { product: 'Klemmen', quantity: 20 });
    ok('fremden Eintrag ändern ist gesperrt (403)', r.status === 403, r.status + '');
    r = await req(server, 'DELETE', `/api/orders/${fremd.id}`, tokens.max);
    ok('fremden Eintrag löschen ist gesperrt (403)', r.status === 403, r.status + '');

    console.log('\n── Der Chef gibt das Recht ──');
    r = await req(server, 'PUT', `/api/users/${ids.max}`, tokens.admin, { can_order: true });
    ok('Recht gesetzt', r.status === 200 && r.body.user.can_order === 1, JSON.stringify(r.body && r.body.user && r.body.user.can_order));
    await anmelden('max');   // neues Token, damit das Recht in der Sitzung steckt
    ok('… und steht in der Anmelde-Antwort', (await anmelden('max')).can_order === true);

    ok('der Coin zeigt jetzt die offenen Bestellungen', coinsVon('max').orders === 2, JSON.stringify(coinsVon('max')));
    r = await act('POST', '/api/orders', 'chef', { product: 'Dosen', quantity: 10 });
    ok('… und die Meldung erreicht ihn', empfaenger() === 'admin,buchhalter,max', empfaenger());
    ok('… der Buchhalter ist jetzt dabei', empfaenger().includes('buchhalter'), empfaenger());

    r = await req(server, 'PUT', `/api/orders/${fremd.id}`, tokens.max, { product: 'Klemmen', quantity: 20 });
    ok('darf fremden offenen Eintrag korrigieren', r.status === 200, r.status + '');
    r = await req(server, 'POST', `/api/orders/${bestellung.id}/order`, tokens.max);
    ok('darf auf „Bestellt" setzen', r.status === 200, r.status + '');
    const nachher = db.prepare('SELECT ordered_at, ordered_by FROM orders WHERE id = ?').get(bestellung.id);
    ok('… und das steht mit seinem Namen in der Datenbank', !!nachher.ordered_at && nachher.ordered_by === ids.max,
      JSON.stringify(nachher));

    console.log('\n── Was das Recht NICHT umfasst ──');
    r = await req(server, 'DELETE', `/api/orders/${bestellung.id}`, tokens.max);
    ok('einen BESTELLTEN Eintrag löschen bleibt gesperrt (403)', r.status === 403, r.status + '');
    r = await req(server, 'DELETE', `/api/orders/${bestellung.id}`, tokens.admin);
    ok('… der Admin darf es', r.status === 200, r.status + '');

    console.log('\n── Eine Zusammenfassung mit „Bestellungen" lässt sich wirklich anlegen ──');
    // Der Weg über die API, nicht per INSERT in die Tabelle. Genau diese Lücke hat den Fehler vom
    // 28.08.2026 durchgelassen: Die Aufräum-Prüfungen weiter unten legen ihre Zeilen direkt in der
    // Datenbank an — damit ist `normalizeSchedule` nie beteiligt, und dass es „orders" still
    // verwarf, konnte niemandem auffallen.
    //
    // Alex mit Bildschirmfoto: Allein gewählt kam „Mindestens eine Kategorie erforderlich"; zusammen
    // mit einer zweiten wurde gespeichert und nur die zweite stand danach da.
    r = await req(server, 'POST', '/api/push/summaries', tokens.max,
      { name: 'Einkauf', weekdays: [1, 2, 3, 4, 5], time: '10:37', cats: ['orders'] });
    ok('„Bestellungen" allein wird angenommen', r.status === 201, r.status + ' ' + JSON.stringify(r.body));
    ok('… und steht auch wirklich drin', r.body && r.body.schedule && r.body.schedule.cats.join(',') === 'orders',
      JSON.stringify(r.body && r.body.schedule && r.body.schedule.cats));
    r = await req(server, 'POST', '/api/push/summaries', tokens.max,
      { name: 'Beides', weekdays: [1], time: '10:37', cats: ['orders', 'bulletin'] });
    ok('… zusammen mit „Schwarzes Brett" bleiben BEIDE erhalten',
      r.status === 201 && r.body.schedule.cats.slice().sort().join(',') === 'bulletin,orders',
      JSON.stringify(r.body && r.body.schedule && r.body.schedule.cats));
    // Und der Buchhalter, der es per Rolle darf — er war ebenso betroffen.
    r = await req(server, 'POST', '/api/push/summaries', tokens.buchhalter,
      { name: 'Einkauf', weekdays: [1], time: '08:00', cats: ['orders'] });
    ok('… der Buchhalter darf es auch', r.status === 201 && r.body.schedule.cats.join(',') === 'orders',
      r.status + ' ' + JSON.stringify(r.body));
    // Die Kehrseite — „ohne Recht bleibt es gesperrt" — steht nach dem Entzug weiter unten.
    // Aufraeumen, damit die Pruefungen dort mit ihrem eigenen Bestand arbeiten.
    for (const row of db.prepare('SELECT id FROM summary_schedules WHERE user_id = ?').all(ids.max)) {
      db.prepare('DELETE FROM summary_schedules WHERE id = ?').run(row.id);
    }

    console.log('\n── Der Entzug räumt auf ──');
    // Ausgangslage: Push an, zwei Zusammenfassungen — eine gemischte und eine reine.
    db.prepare('INSERT OR REPLACE INTO push_prefs (user_id, orders, bulletin, notes, absences) VALUES (?, 1, 1, 1, 1)').run(ids.max);
    db.prepare("INSERT INTO summary_schedules (user_id, name, weekdays, time, cats) VALUES (?, 'Abendrunde', '1,2,3,4,5', '19:00', 'notes,orders')").run(ids.max);
    db.prepare("INSERT INTO summary_schedules (user_id, name, weekdays, time, cats) VALUES (?, 'Nur Bestellungen', '1', '08:00', 'orders')").run(ids.max);

    r = await req(server, 'PUT', `/api/users/${ids.max}`, tokens.admin, { can_order: false });
    ok('Recht entzogen', r.status === 200 && r.body.user.can_order === 0, JSON.stringify(r.body && r.body.user && r.body.user.can_order));
    ok('… Push-Schalter „Bestellungen" steht auf aus',
      db.prepare('SELECT orders FROM push_prefs WHERE user_id = ?').get(ids.max).orders === 0);
    const abend = db.prepare("SELECT cats FROM summary_schedules WHERE user_id = ? AND name = 'Abendrunde'").get(ids.max);
    ok('… aus der Abendrunde bleibt nur „notes"', abend && abend.cats === 'notes', JSON.stringify(abend));
    const nur = db.prepare("SELECT id FROM summary_schedules WHERE user_id = ? AND name = 'Nur Bestellungen'").get(ids.max);
    ok('… die reine Bestell-Zusammenfassung ist weg', !nur, JSON.stringify(nur));
    const eintrag = db.prepare("SELECT details FROM audit_logs WHERE action = 'bestellrecht_aufgeraeumt' ORDER BY id DESC LIMIT 1").get();
    ok('… und alles steht im Audit-Log', !!eintrag && /Abendrunde/.test(eintrag.details) && /Nur Bestellungen/.test(eintrag.details),
      JSON.stringify(eintrag));

    await anmelden('max');
    ok('danach ist „Bestellt" wieder gesperrt',
      (await req(server, 'POST', `/api/orders/${fremd.id}/order`, tokens.max)).status === 403);
    r = await act('POST', '/api/orders', 'chef', { product: 'Schellen' });
    ok('… und er bekommt keine Meldung mehr', !empfaenger().includes('max'), empfaenger());
    ok('… sein Coin steht wieder auf 0', coinsVon('max').orders === 0, JSON.stringify(coinsVon('max')));
    r = await req(server, 'POST', '/api/push/summaries', tokens.max,
      { name: 'Einkauf', weekdays: [1], time: '10:37', cats: ['orders'] });
    ok('… und er kann keine Bestell-Zusammenfassung mehr anlegen',
      r.status === 400 && /Kategorie/.test(String(r.body && r.body.error)),
      r.status + ' ' + JSON.stringify(r.body));

    console.log('\n── Auch der Weg über die Rolle ──');
    // Ein Chef verliert das Recht implizit, wenn er zum Mitarbeiter zurueckgestuft wird. Ohne
    // diese Runde waere genau dieser Pfad offen geblieben.
    db.prepare('INSERT OR REPLACE INTO push_prefs (user_id, orders, bulletin, notes, absences) VALUES (?, 1, 1, 1, 1)').run(ids.chef);
    db.prepare("INSERT INTO summary_schedules (user_id, name, weekdays, time, cats) VALUES (?, 'Chefrunde', '1', '07:00', 'orders,absences')").run(ids.chef);
    r = await req(server, 'PUT', `/api/users/${ids.chef}`, tokens.admin, { role: 'mitarbeiter' });
    ok('Chef → Mitarbeiter', r.status === 200 && r.body.user.role === 'mitarbeiter', r.status + '');
    ok('… Push-Schalter aus', db.prepare('SELECT orders FROM push_prefs WHERE user_id = ?').get(ids.chef).orders === 0);
    ok('… Zusammenfassung auf „absences" gekürzt',
      db.prepare("SELECT cats FROM summary_schedules WHERE user_id = ? AND name = 'Chefrunde'").get(ids.chef).cats === 'absences');

    console.log('\n── Kein sinnloses Häkchen ──');
    r = await req(server, 'PUT', `/api/users/${ids.max}`, tokens.admin, { can_order: true, can_plan: true, can_bulletin: true });
    ok('Mitarbeiter bekommt Bestell- und Planungsrecht', r.body.user.can_order === 1 && r.body.user.can_plan === 1);
    r = await req(server, 'PUT', `/api/users/${ids.max}`, tokens.admin, { role: 'chef' });
    ok('→ Chef: ALLE Einzelrechte auf 0', r.body.user.can_order === 0 && r.body.user.can_plan === 0 && r.body.user.can_bulletin === 0,
      JSON.stringify(r.body.user));

    // Der Buchhalter ist der Sonderfall: Bestellen darf er per Rolle, planen NICHT.
    r = await req(server, 'PUT', `/api/users/${ids.buchhalter}`, tokens.admin, { can_order: true, can_plan: true, can_bulletin: true });
    ok('Buchhalter: Bestellrecht wird nicht gespeichert (hat er per Rolle)', r.body.user.can_order === 0, JSON.stringify(r.body.user));
    ok('… seine Planungs- und Brett-Rechte bleiben aber erhalten',
      r.body.user.can_plan === 1 && r.body.user.can_bulletin === 1, JSON.stringify(r.body.user));

    console.log('\n── Die Regel selbst ──');
    for (const [was, user, erwartet] of [
      ['Admin', { role: 'admin', can_order: 0 }, true],
      ['Chef', { role: 'chef', can_order: 0 }, true],
      ['Buchhalter', { role: 'buchhalter', can_order: 0 }, true],
      ['Mitarbeiter ohne Recht', { role: 'mitarbeiter', can_order: 0 }, false],
      ['Mitarbeiter MIT Recht', { role: 'mitarbeiter', can_order: 1 }, true],
      ['nichts übergeben', null, false],
    ]) {
      ok(`${was} → ${erwartet ? 'darf' : 'darf nicht'}`, darfBestellen(user) === erwartet);
    }

    // Es gibt die Regel ZWEIMAL: als Funktion (ein Nutzer) und als SQL (die Liste der Empfaenger).
    // Genau an dieser Doppelung ist sie schon zweimal auseinandergelaufen — einmal beim Buchhalter
    // im Zaehler, einmal in der Menuezeile. Deshalb werden beide Fassungen gegeneinander geprueft
    // statt jede fuer sich.
    const perSql = db.prepare(`SELECT username, role, can_order FROM users WHERE ${SQL_BESTELLBERECHTIGT}`)
      .all(...SQL_BESTELLROLLEN).map(u => u.username).sort();
    const perFunktion = db.prepare('SELECT username, role, can_order FROM users').all()
      .filter(u => darfBestellen(u)).map(u => u.username).sort();
    ok('die SQL-Fassung der Regel sagt dasselbe wie die Funktion',
      JSON.stringify(perSql) === JSON.stringify(perFunktion),
      `SQL ${JSON.stringify(perSql)} vs. Funktion ${JSON.stringify(perFunktion)}`);
    ok('… und der Buchhalter steht in beiden', perSql.includes('buchhalter') && perFunktion.includes('buchhalter'),
      JSON.stringify(perSql));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    server.close();
  }
  console.log(`\nBestellrecht: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
