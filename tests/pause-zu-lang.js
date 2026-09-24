// Pause schluckt die Arbeitszeit (R6, Alex 24.09.2026).
//
// Gemessen im Betrieb: zwei 30-Minuten-Einsaetze mit 30 min Pause — gespeichert als 0 Stunden,
// zusammen eine Stunde Arbeit, die im Ueberstundenkonto fehlte. Der Server nahm das still an.
//
// Hier die Serverseite: Anlegen UND Aendern weisen „Pause >= Arbeitszeit" ab — beim Aendern mit den
// zusammengefuehrten Werten, damit auch ein blosses Umbenennen den kaputten Eintrag auffallen laesst.
// Die Gegenproben: eine Minute Luft ist erlaubt, Eintraege ohne Dauer und ohne Pause auch.
//
// IN-PROCESS ([[reference_zweiter_prozess_db]]).
//   node tests/pause-zu-lang.js
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/pause-zu-lang.db';
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}

const express = require('express');
const { initDatabase, getDb } = require('../database/init');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let PORT = 0;
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  await initDatabase();
  const db = getDb();
  const PW = 'Seed!12345';
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(PW, 10));

  const app = express(); app.use(express.json());
  for (const [pfad, mod] of [['/api/auth', 'auth'], ['/api/entries', 'entries']])
    app.use(pfad, require('../routes/' + mod));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;

  try {
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: PW })).body.token;
    // Ein Werktag in der Vergangenheit, weit weg von jedem Abschluss.
    const tag = '2026-09-09';
    const neu = (von, bis, pause) => req('POST', '/api/entries', max,
      { date: tag, time_from: von, time_to: bis, break_minutes: pause, description: 'R6 ' + von });

    console.log('── Anlegen ──');
    let r = await neu('08:00', '08:30', 30);
    ok('08:00–08:30 mit 30 min Pause (Jans Fall) → abgewiesen', r.status === 400, r.status + ' ' + r.text.slice(0, 90));
    ok('… mit verständlicher Meldung', /so lang wie die Arbeitszeit \(30 min\)/.test(r.body.error || ''), r.body.error);
    r = await neu('13:15', '13:40', 30);
    ok('Pause LÄNGER als die Arbeitszeit → abgewiesen', r.status === 400 && /länger als die Arbeitszeit \(25 min\)/.test(r.body.error), r.body.error);
    r = await neu('07:00', '07:00', 30);
    ok('Von = Bis mit Pause → abgewiesen, mit eigener Meldung', r.status === 400 && /Von und Bis sind gleich/.test(r.body.error), r.body.error);
    ok('… und nichts davon liegt in der Datenbank',
      db.prepare("SELECT COUNT(*) AS c FROM entries WHERE description LIKE 'R6 %'").get().c === 0);

    console.log('\n── Gegenproben: was erlaubt bleibt ──');
    r = await neu('08:00', '08:31', 30);
    ok('eine Minute Arbeit neben der Pause ist erlaubt', r.status === 201, r.status + ' ' + r.text.slice(0, 80));
    r = await neu('09:00', '09:00', 0);
    ok('Von = Bis OHNE Pause bleibt erlaubt (daran ändert sich nichts)', r.status === 201, r.status + ' ' + r.text.slice(0, 80));
    r = await neu('10:00', '18:00', 30);
    ok('ein normaler Tag mit 30 min Pause', r.status === 201 && r.body.entry && r.body.entry.net_hours === 7.5,
      r.status + ' ' + r.text.slice(0, 80));
    const normal = r.body.entry;

    console.log('\n── Ändern ──');
    r = await req('PUT', `/api/entries/${normal.id}`, max, { time_from: '10:00', time_to: '10:20', break_minutes: 30 });
    ok('einen Eintrag auf 20 min Arbeit mit 30 min Pause ändern → abgewiesen', r.status === 400 && /länger als/.test(r.body.error), r.body.error);
    ok('… und er bleibt unverändert',
      db.prepare('SELECT time_to, net_hours FROM entries WHERE id = ?').get(normal.id).time_to === '18:00');

    // Ein Altfall wie Jans Eintraege — direkt in die Datenbank, so wie er heute im Bestand liegt.
    const alt = db.prepare("INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours, description) VALUES ((SELECT id FROM users WHERE username='max'), ?, '13:15', '13:45', 30, 0, 'Altfall')").run(tag).lastInsertRowid;
    r = await req('PUT', `/api/entries/${alt}`, max, { description: 'Altfall, nur umbenannt' });
    ok('ein Altfall fällt auch beim bloßen Umbenennen auf (zusammengeführte Werte)', r.status === 400 && /so lang wie/.test(r.body.error), r.body.error);
    r = await req('PUT', `/api/entries/${alt}`, max, { break_minutes: 0 });
    ok('… und lässt sich mit Pause 0 korrigieren — dann zählt er 0,5 Stunden',
      r.status === 200 && r.body.entry && r.body.entry.net_hours === 0.5, r.status + ' ' + r.text.slice(0, 80));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { server.close(); }

  console.log(`\nPause zu lang (Server): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
