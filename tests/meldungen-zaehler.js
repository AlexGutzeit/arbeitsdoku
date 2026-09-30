// Meldungen — Zähler, Zusammenfassung und Push-Schalter (Etappe 2, 30.09.2026).
//
// Alex: „Bei jeder Meldung oder Änderung zählt, wie gewohnt, der Coin vom Chef/Admin hoch." — „Setzt der Chef
// etwas auf ‚in Arbeit', leuchtet es beim Admin auf? Ja, und natürlich auch beim zweiten Chef." Dazu (Rückfragen):
// Der Melder bekommt Zähler und Push, wenn ein ANDERER seine Meldung ändert oder ihren Stand setzt; die eigene
// Handlung zählt nie. Die Zusammenfassung sagt „5 offene Meldungen (davon 2 neu)".
// Geprüft wird auch der Weg über den ZEITPLANER mit dem Nutzer, wie er ihn aus der Datenbank liest — dort fehlte
// beim Bestellrecht schon einmal die Rechte-Spalte, und die Zusammenfassung zählte still „0".
//
// In-Process mit eigenem Port (listen(0)), web-push abgefangen.
//   node tests/meldungen-zaehler.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

const webpush = require('web-push');
let SENT = [];
webpush.sendNotification = (sub, payload) => { SENT.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return Promise.resolve({ statusCode: 201 }); };

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/meldungen-zaehler.db';
process.env.VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
process.env.VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';
process.env.VAPID_SUBJECT = 'mailto:a@b.de';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');

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

(async () => {
  await initDatabase();
  const db = getDb();
  const hash = bcrypt.hashSync('pw123456', 10);
  const ids = {};
  // Zwei Chefs, ein Admin, eine mit Einzelrecht, zwei Mitarbeiter, ein Buchhalter
  for (const [u, n, rolle, recht] of [['carla', 'Carla Chef', 'chef', 0], ['chris', 'Chris Chef', 'chef', 0], ['adam', 'Adam Admin', 'admin', 0],
    ['vera', 'Vera Vorarbeit', 'mitarbeiter', 1], ['anna', 'Anna Berger', 'mitarbeiter', 0], ['moritz', 'Moritz Muster', 'mitarbeiter', 0],
    ['bea', 'Bea Buchhalt', 'buchhalter', 0]]) {
    ids[u] = db.prepare('INSERT INTO users (username, password_hash, name, role, can_meldungen) VALUES (?, ?, ?, ?, ?)').run(u, hash, n, rolle, recht).lastInsertRowid;
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'k')").run(ids[u], 'sub://' + u);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/meldungen', require('../routes/meldungen'));
  app.use('/api/badges', require('../routes/badges'));
  app.use('/api/push', require('../routes/push'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const tok = {};
  for (const u of Object.keys(ids)) tok[u] = (await req(server, 'POST', '/api/auth/login', null, { username: u, password: 'pw123456' })).body.token;
  const coins = async () => {
    const o = {};
    for (const u of Object.keys(ids)) o[u] = (await req(server, 'GET', '/api/badges', tok[u])).body.meldungen;
    return o;
  };
  const gesehen = async (u) => { await sleep(15); await req(server, 'POST', '/api/badges/meldungen', tok[u]); await sleep(15); };
  const zeig = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');

  try {
    const th = {};
    for (const n of ['Auto 2', 'Papiermüll']) th[n] = (await req(server, 'POST', '/api/meldungen/themen', tok.carla, { name: n })).body.thema.id;
    for (const u of Object.keys(ids)) await gesehen(u);

    console.log('Neue Meldung');
    const oel = (await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: th['Auto 2'], text: 'Ölwechsel fällig' })).body.meldung;
    let c = await coins();
    ok('Anna meldet: +1 bei beiden Chefs, dem Admin und Vera (Einzelrecht)', c.carla === 1 && c.chris === 1 && c.adam === 1 && c.vera === 1, zeig(c));
    ok('… nicht bei Anna selbst, nicht bei Moritz, nicht beim Buchhalter', c.anna === 0 && c.moritz === 0 && c.bea === 0, zeig(c));

    console.log('Gesehen');
    await gesehen('carla');
    c = await coins();
    ok('Carla schaut hin: ihr Zähler 0, die anderen bleiben', c.carla === 0 && c.chris === 1 && c.adam === 1, zeig(c));

    console.log('Stand gesetzt');
    await gesehen('chris'); await gesehen('adam'); await gesehen('vera');
    await req(server, 'POST', `/api/meldungen/${oel.id}/status`, tok.carla, { status: 'in_arbeit' });
    c = await coins();
    ok('Carla setzt „in Arbeit": leuchtet beim zweiten Chef, beim Admin und bei Vera', c.chris === 1 && c.adam === 1 && c.vera === 1, zeig(c));
    ok('… und bei Anna (ihre Meldung) — nicht bei Carla selbst', c.anna === 1 && c.carla === 0, zeig(c));
    ok('… Moritz geht es nichts an', c.moritz === 0, zeig(c));

    console.log('Rückmeldung, Änderungen');
    await gesehen('anna');
    await req(server, 'PUT', `/api/meldungen/${oel.id}`, tok.adam, { rueckmeldung: 'Werkstatt am 05.10.' });
    c = await coins();
    ok('Admin schreibt eine Rückmeldung: Anna 1, Carla 1, Admin 0', c.anna === 1 && c.carla === 1 && c.adam === 0, zeig(c));
    const tonne = (await req(server, 'POST', '/api/meldungen', tok.moritz, { thema_id: th['Papiermüll'], text: 'voll' })).body.meldung;
    await gesehen('moritz'); await gesehen('anna');
    await req(server, 'PUT', `/api/meldungen/${tonne.id}`, tok.vera, { text: 'Papiermüll voll, bitte Abholung bestellen' });
    c = await coins();
    ok('Vera ändert die Meldung von Moritz: Moritz 1, Anna 0', c.moritz === 1 && c.anna === 0, zeig(c));
    await gesehen('moritz');
    await req(server, 'PUT', `/api/meldungen/${tonne.id}`, tok.moritz, { text: 'voll!' });
    c = await coins();
    ok('Moritz ändert seine eigene: bei ihm 0 (eigene Handlung zählt nie)', c.moritz === 0, zeig(c));

    console.log('Thema gelöscht');
    for (const u of Object.keys(ids)) await gesehen(u);
    await req(server, 'DELETE', `/api/meldungen/themen/${th['Papiermüll']}`, tok.carla);
    c = await coins();
    ok('die offene Meldung wandert in die History: zählt beim Admin und bei Moritz', c.adam === 1 && c.moritz === 1 && c.carla === 0, zeig(c));
    await gesehen('moritz');

    console.log('Zusammenfassung (Zeitplaner, Nutzer aus der Datenbank)');
    const { tick, berlinParts } = require('../scheduler');
    await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: th['Auto 2'], text: 'Reifendruck' });
    await gesehen('vera');   // Vera hat alles gesehen …
    await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: th['Auto 2'], text: 'Scheibenwischer' });   // … bis auf diese
    await gesehen('anna');
    await req(server, 'POST', `/api/meldungen/${oel.id}/status`, tok.carla, { status: 'erledigt' });
    const jetzt = new Date();
    const { hhmm, weekday } = berlinParts(jetzt);
    for (const u of ['vera', 'anna', 'moritz']) {
      db.prepare("INSERT INTO summary_schedules (user_id, name, weekdays, time, cats) VALUES (?, 'Test', ?, ?, 'meldungen')").run(ids[u], String(weekday), hhmm);
    }
    SENT = [];
    const fired = await tick(db, jetzt);
    const body = (u) => (fired.find(f => f.user_id === ids[u]) || {}).body;
    // Neu für Vera: „Scheibenwischer" (offen) und „Ölwechsel erledigt" — gezählt als „davon neu" wird nur die offene
    ok('Vera (Einzelrecht): „2 offene Meldungen (davon 1 neu)" — der Zeitplaner kennt ihr Recht', body('vera') === 'Du hast noch 2 offene Meldungen (davon 1 neu) zu bearbeiten.', body('vera'));
    ok('Anna (Melderin): „1 Neuigkeit zu deinen Meldungen"', body('anna') === 'Du hast noch 1 Neuigkeit zu deinen Meldungen zu bearbeiten.', body('anna'));
    ok('Moritz: nichts Neues', body('moritz') === 'Es gibt nichts zu tun.', body('moritz'));

    console.log('Push-Schalter „Meldungen"');
    const p0 = (await req(server, 'GET', '/api/push/prefs', tok.adam)).body;
    ok('Schalter vorhanden, Standard an', p0.meldungen === true, JSON.stringify(p0));
    const p1 = (await req(server, 'PUT', '/api/push/prefs', tok.adam, { meldungen: false })).body;
    ok('abschaltbar', p1.meldungen === false && p1.orders === true, JSON.stringify(p1));
    SENT = [];
    await req(server, 'POST', '/api/meldungen', tok.anna, { thema_id: th['Auto 2'], text: 'Licht vorne links' });
    await sleep(150);
    ok('abgeschaltet: der Admin bekommt keine Push, die Chefs schon', !SENT.some(s => s.endpoint === 'sub://adam') && SENT.some(s => s.endpoint === 'sub://carla') && SENT.some(s => s.endpoint === 'sub://chris'),
      JSON.stringify(SENT.map(s => s.endpoint)));
    ok('Kategorie-Symbol (Megafon)', SENT.every(s => /cat-meldungen\.png$/.test(s.payload.icon || '')), JSON.stringify(SENT.map(s => s.payload.icon)));
    const plan = await req(server, 'POST', '/api/push/summaries', tok.anna, { name: 'Meldungen', weekdays: [1], time: '07:00', cats: ['meldungen'] });
    ok('Zusammenfassung „nur Meldungen" lässt sich anlegen (auch als Mitarbeiterin)', plan.status < 300, plan.status + ' ' + plan.text.slice(0, 120));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\nMeldungen — Zähler, Zusammenfassung, Push: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
