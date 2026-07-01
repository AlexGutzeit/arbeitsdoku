// In-Process-Test des Zusammenfassungs-Schedulers: reine Funktionen isDue()/buildSummaryText() +
// tick() gegen eine echte (temporäre) DB, inkl. Dedup, Einzel-Pause und Global-Pause.
// Start: node tests/scheduler-tick.js
const fs = require('fs');
const path = require('path');
const DB = '/tmp/scheduler-tick.db';
try { fs.unlinkSync(DB); } catch (_) {}
process.env.DB_PATH = DB;
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';

const { initDatabase, getDb } = require(path.join(__dirname, '..', 'database', 'init'));
const scheduler = require(path.join(__dirname, '..', 'scheduler'));

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

(async () => {
  // ---- reine Funktionen ----
  const s = { paused: 0, time: '08:00', weekdays: '1,3,5', last_fired: '' };
  const stamp = '2026-07-01 08:00';
  ok('isDue: passender Tag+Zeit → true', scheduler.isDue(s, 1, '08:00', stamp) === true);
  ok('isDue: falscher Tag → false', scheduler.isDue(s, 2, '08:00', stamp) === false);
  ok('isDue: falsche Zeit → false', scheduler.isDue(s, 1, '08:01', stamp) === false);
  ok('isDue: bereits gefeuert (last_fired==stamp) → false', scheduler.isDue({ ...s, last_fired: stamp }, 1, '08:00', stamp) === false);
  ok('isDue: pausiert → false', scheduler.isDue({ ...s, paused: 1 }, 1, '08:00', stamp) === false);

  ok('Text: eine Kategorie', scheduler.buildSummaryText(['bulletin'], { bulletin: 1 }) === 'Du hast noch 1 Aushänge zu bearbeiten.', scheduler.buildSummaryText(['bulletin'], { bulletin: 1 }));
  ok('Text: zwei Kategorien (und)', scheduler.buildSummaryText(['orders', 'notes'], { orders: 3, notes: 4 }) === 'Du hast noch 3 Bestellungen und 4 Notizen zu bearbeiten.');
  ok('Text: drei Kategorien (Komma + und)', scheduler.buildSummaryText(['orders', 'absences', 'notes'], { orders: 3, absences: 2, notes: 4 }) === 'Du hast noch 3 Bestellungen, 2 Abwesenheiten und 4 Notizen zu bearbeiten.');
  ok('Text: alles 0 → nichts zu tun', scheduler.buildSummaryText(['notes', 'orders'], { notes: 0, orders: 0 }) === 'Es gibt nichts zu tun.');
  ok('Text: 0-Kategorien werden weggelassen', scheduler.buildSummaryText(['orders', 'notes'], { orders: 0, notes: 2 }) === 'Du hast noch 2 Notizen zu bearbeiten.');

  // ---- tick gegen echte DB ----
  await initDatabase();
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const now = new Date();
  const { date, hhmm, weekday } = scheduler.berlinParts(now);
  const dateStamp = date + ' ' + hhmm;
  db.prepare("INSERT INTO summary_schedules (user_id, name, weekdays, time, cats, paused, last_fired) VALUES (?, 'Test', ?, ?, 'notes', 0, '')")
    .run(uid, String(weekday), hhmm);
  const sid = db.prepare('SELECT id FROM summary_schedules WHERE user_id = ?').get(uid).id;

  let fired = await scheduler.tick(db, now);
  ok('tick: fälliger Plan feuert (Nachricht „nichts zu tun")', fired.length === 1 && fired[0].body === 'Es gibt nichts zu tun.' && fired[0].title === 'Test', JSON.stringify(fired));
  ok('tick: last_fired gesetzt', db.prepare('SELECT last_fired FROM summary_schedules WHERE id = ?').get(sid).last_fired === dateStamp);

  fired = await scheduler.tick(db, now);
  ok('tick: gleiche Minute → kein Doppelversand', fired.length === 0);

  // Einzel-Pause
  db.prepare('UPDATE summary_schedules SET paused = 1, last_fired = ? WHERE id = ?').run('', sid);
  fired = await scheduler.tick(db, now);
  ok('tick: pausierter Plan feuert nicht', fired.length === 0);

  // Global-Pause (Urlaub)
  db.prepare('UPDATE summary_schedules SET paused = 0, last_fired = ? WHERE id = ?').run('', sid);
  db.prepare('INSERT INTO push_prefs (user_id, summaries_paused) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET summaries_paused = 1').run(uid);
  fired = await scheduler.tick(db, now);
  ok('tick: global pausierter Nutzer feuert nicht', fired.length === 0);

  console.log(`\nScheduler-Tick: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
