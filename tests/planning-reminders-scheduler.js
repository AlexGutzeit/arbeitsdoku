// In-Process-Test der Erinnerungs-Feuerlogik (scheduler.firePlanningReminders + Digest-Bündelung in tick).
// now wird kontrolliert gesetzt (Sommerzeit → Berlin = UTC+2). Ohne VAPID ist notifyUsers ein No-op;
// getestet werden die DB-Seiteneffekte (planning_reminder_sent) + der Digest-Body.
// Start: node tests/planning-reminders-scheduler.js
process.env.DB_PATH = '/tmp/planning-reminders-sched.db';
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const crypto = require('crypto');
const { initDatabase, getDb } = require('../database/init');
const { firePlanningReminders, tick } = require('../scheduler');

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
// Berlin-Wanduhr "YYYY-MM-DD HH:MM" (Sommer → +02:00) als Date.
const nowAt = (wall) => new Date(wall.replace(' ', 'T') + ':00+02:00');

function addEntry(db, { date, tf = '07:00', tt = '15:30', group_id = null, series_id = null, occurrence_date = null, client = 'Kunde', userId }) {
  const r = db.prepare(`INSERT INTO planning_entries
    (created_by,date,time_from,time_to,break_minutes,address,client,project_id,project_text,description,group_id,color,series_id,occurrence_date)
    VALUES (?,?,?,?,0,'',?,NULL,'','',?,'#f59e0b',?,?)`).run(userId, date, tf, tt, client, group_id, series_id, occurrence_date);
  db.prepare('INSERT INTO planning_assignments (planning_id,user_id) VALUES (?,?)').run(r.lastInsertRowid, userId);
  return r.lastInsertRowid;
}
function addReminder(db, { userId, target_type = 'occurrence', group_id = null, entry_id = null, series_id = null, lead_num, lead_unit, remind_time = null, from_occurrence = null }) {
  return db.prepare(`INSERT INTO planning_reminders (user_id,target_type,group_id,entry_id,series_id,lead_num,lead_unit,remind_time,from_occurrence)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, target_type, group_id, entry_id, series_id, lead_num, lead_unit, remind_time, from_occurrence).lastInsertRowid;
}
const sentCount = (db, rid) => db.prepare('SELECT COUNT(*) n FROM planning_reminder_sent WHERE reminder_id=?').get(rid).n;
const setPlanningPref = (db, userId, on) => db.prepare(`INSERT INTO push_prefs (user_id, planning) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET planning = excluded.planning`).run(userId, on ? 1 : 0);

(async () => {
  await initDatabase();
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;

  // ── T1: Einzelversand zur fireAt (kein Digest) ──
  const e1 = addEntry(db, { date: '2026-07-17', userId: uid, client: 'C1' });
  const r1 = addReminder(db, { userId: uid, entry_id: e1, lead_num: 1, lead_unit: 'week' }); // fireAt 2026-07-10 07:00
  ok('vor fireAt: nichts', (await firePlanningReminders(db, nowAt('2026-07-10 06:59'))) === 0 && sentCount(db, r1) === 0);
  const s1 = await firePlanningReminders(db, nowAt('2026-07-10 07:00'));
  ok('zur fireAt: genau 1 gesendet + protokolliert', s1 === 1 && sentCount(db, r1) === 1);
  ok('erneuter Tick: kein Doppelversand', (await firePlanningReminders(db, nowAt('2026-07-10 07:01'))) === 0 && sentCount(db, r1) === 1);

  // ── T2: Termin vorbei → nichts ──
  const e2 = addEntry(db, { date: '2026-07-05', userId: uid, client: 'C2' });
  const r2 = addReminder(db, { userId: uid, entry_id: e2, lead_num: 1, lead_unit: 'day' });
  ok('Termin liegt in der Vergangenheit → nichts', (await firePlanningReminders(db, nowAt('2026-07-10 08:00'))) === 0 && sentCount(db, r2) === 0);

  // ── T3: Pause (Erlaubnis aus) → nichts senden/protokollieren; nach Wieder-an Nachhol-Erinnerung ──
  const e3 = addEntry(db, { date: '2026-07-24', userId: uid, client: 'C3' });
  const r3 = addReminder(db, { userId: uid, entry_id: e3, lead_num: 1, lead_unit: 'week' }); // fireAt 2026-07-17 07:00
  setPlanningPref(db, uid, false);
  ok('pausiert: fällig, aber nichts gesendet/protokolliert', (await firePlanningReminders(db, nowAt('2026-07-17 07:00'))) === 0 && sentCount(db, r3) === 0);
  setPlanningPref(db, uid, true);
  ok('nach Wieder-an: Nachhol-Erinnerung kommt (Termin noch zukünftig)', (await firePlanningReminders(db, nowAt('2026-07-17 09:00'))) === 1 && sentCount(db, r3) === 1);

  // ── T4: Serien-Erinnerung feuert je Vorkommen genau einmal ──
  const S = crypto.randomUUID();
  addEntry(db, { date: '2026-08-07', userId: uid, series_id: S, occurrence_date: '2026-08-07', group_id: crypto.randomUUID(), client: 'CS' });
  addEntry(db, { date: '2026-08-14', userId: uid, series_id: S, occurrence_date: '2026-08-14', group_id: crypto.randomUUID(), client: 'CS' });
  const rs = addReminder(db, { userId: uid, target_type: 'series', series_id: S, lead_num: 1, lead_unit: 'day' });
  await firePlanningReminders(db, nowAt('2026-08-06 07:00'));
  ok('Serie: 1. Vorkommen gefeuert', sentCount(db, rs) === 1);
  await firePlanningReminders(db, nowAt('2026-08-06 07:05'));
  ok('Serie: 1. Vorkommen nicht doppelt', sentCount(db, rs) === 1);
  await firePlanningReminders(db, nowAt('2026-08-13 07:00'));
  ok('Serie: 2. Vorkommen gefeuert', sentCount(db, rs) === 2);

  // ── T4b: Serien-Scope „ab hier" (from_occurrence) → nur Vorkommen ab dem Datum feuern ──
  const SF = crypto.randomUUID();
  addEntry(db, { date: '2026-09-11', userId: uid, series_id: SF, occurrence_date: '2026-09-11', group_id: crypto.randomUUID(), client: 'CF' });
  addEntry(db, { date: '2026-09-18', userId: uid, series_id: SF, occurrence_date: '2026-09-18', group_id: crypto.randomUUID(), client: 'CF' });
  const rf = addReminder(db, { userId: uid, target_type: 'series', series_id: SF, lead_num: 1, lead_unit: 'day', from_occurrence: '2026-09-18' });
  await firePlanningReminders(db, nowAt('2026-09-10 07:00')); // Tag vor dem 1. Vorkommen
  ok('from_occurrence: 1. Vorkommen NICHT gefeuert (vor Grenze)', sentCount(db, rf) === 0);
  await firePlanningReminders(db, nowAt('2026-09-17 07:00')); // Tag vor dem 2. Vorkommen
  ok('from_occurrence: 2. Vorkommen gefeuert', sentCount(db, rf) === 1);

  // ── T5: Abend-Erinnerung über eigene Uhrzeit (remind_time 18:00, 1 Tag vorher) ──
  const e5 = addEntry(db, { date: '2026-07-31', userId: uid, client: 'C5' }); // Termin 07:00
  const r5 = addReminder(db, { userId: uid, entry_id: e5, lead_num: 1, lead_unit: 'day', remind_time: '18:00' }); // fireWall 2026-07-30 18:00
  ok('Abend-Erinnerung: morgens noch nicht fällig', (await firePlanningReminders(db, nowAt('2026-07-30 07:00'))) === 0 && sentCount(db, r5) === 0);
  ok('Abend-Erinnerung: um 18:00 gesendet', (await firePlanningReminders(db, nowAt('2026-07-30 18:00'))) === 1 && sentCount(db, r5) === 1);

  // ── T6: Default-Uhrzeit = Beginn-Uhrzeit des Termins (remind_time NULL) ──
  const e6 = addEntry(db, { date: '2026-08-21', tf: '09:30', userId: uid, client: 'C6' });
  const r6 = addReminder(db, { userId: uid, entry_id: e6, lead_num: 1, lead_unit: 'week' }); // fireWall 2026-08-14 09:30
  ok('Default-Uhrzeit: um 07:00 noch nicht fällig', (await firePlanningReminders(db, nowAt('2026-08-14 07:00'))) === 0 && sentCount(db, r6) === 0);
  ok('Default-Uhrzeit: zur Beginn-Uhrzeit (09:30) gesendet', (await firePlanningReminders(db, nowAt('2026-08-14 09:30'))) === 1 && sentCount(db, r6) === 1);

  console.log(`\nPlanning-Reminders-Scheduler: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
