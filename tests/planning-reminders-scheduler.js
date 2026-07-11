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
const { firePlanningReminders, tick, extendSeries } = require('../scheduler');

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
function addReminder(db, { userId, group_id = null, entry_id = null, series_id = null, occurrence_date = null, reminder_group = null, lead_num, lead_unit, remind_time = null }) {
  return db.prepare(`INSERT INTO planning_reminders (user_id,reminder_group,group_id,entry_id,series_id,occurrence_date,lead_num,lead_unit,remind_time)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, reminder_group, group_id, entry_id, series_id, occurrence_date, lead_num, lead_unit, remind_time).lastInsertRowid;
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

  // ── T4: Gruppen-Erinnerung (Mehrtag/Serien-Vorkommen per group_id) feuert zur frühesten Tag-Zeit ──
  const G = crypto.randomUUID();
  addEntry(db, { date: '2026-08-07', tf: '07:00', userId: uid, group_id: G, client: 'CG' });
  addEntry(db, { date: '2026-08-08', tf: '09:00', userId: uid, group_id: G, client: 'CG' });
  const rg = addReminder(db, { userId: uid, group_id: G, lead_num: 1, lead_unit: 'day' }); // fireWall 2026-08-06 07:00 (frühester Tag/Zeit)
  ok('Gruppe: Tag davor 06:59 noch nicht fällig', (await firePlanningReminders(db, nowAt('2026-08-06 06:59'))) === 0 && sentCount(db, rg) === 0);
  await firePlanningReminders(db, nowAt('2026-08-06 07:00'));
  ok('Gruppe: zur frühesten Tag-Zeit gefeuert', sentCount(db, rg) === 1);
  await firePlanningReminders(db, nowAt('2026-08-06 07:05'));
  ok('Gruppe: nicht doppelt', sentCount(db, rg) === 1);

  // ── T4b: zwei Vorkommen einer Serie = zwei unabhängige Zeilen (pro-Vorkommen) ──
  const g1 = crypto.randomUUID(), g2 = crypto.randomUUID();
  addEntry(db, { date: '2026-09-11', userId: uid, series_id: 'SF', occurrence_date: '2026-09-11', group_id: g1, client: 'CF' });
  addEntry(db, { date: '2026-09-18', userId: uid, series_id: 'SF', occurrence_date: '2026-09-18', group_id: g2, client: 'CF' });
  const rg1 = crypto.randomUUID();
  const rf1 = addReminder(db, { userId: uid, group_id: g1, series_id: 'SF', occurrence_date: '2026-09-11', reminder_group: rg1, lead_num: 1, lead_unit: 'day' });
  const rf2 = addReminder(db, { userId: uid, group_id: g2, series_id: 'SF', occurrence_date: '2026-09-18', reminder_group: rg1, lead_num: 1, lead_unit: 'day' });
  await firePlanningReminders(db, nowAt('2026-09-10 07:00'));
  ok('Serie pro-Vorkommen: 1. Zeile gefeuert, 2. noch nicht', sentCount(db, rf1) === 1 && sentCount(db, rf2) === 0);
  await firePlanningReminders(db, nowAt('2026-09-17 07:00'));
  ok('Serie pro-Vorkommen: 2. Zeile gefeuert', sentCount(db, rf2) === 1);

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

  // ── T7: rollierendes Nachschieben zieht „bis Ende" laufende Erinnerungen auf neue Vorkommen mit ──
  const NOW = nowAt('2026-10-05 08:00'); // today = 2026-10-05
  const SID = crypto.randomUUID();
  const gA = crypto.randomUUID(), gB = crypto.randomUUID();
  addEntry(db, { date: '2026-10-05', tf: '07:00', userId: uid, series_id: SID, occurrence_date: '2026-10-05', group_id: gA, client: 'CR' });
  addEntry(db, { date: '2026-10-12', tf: '07:00', userId: uid, series_id: SID, occurrence_date: '2026-10-12', group_id: gB, client: 'CR' });
  db.prepare(`INSERT INTO planning_series (series_id, created_by, freq, anchor_date, interval_weeks, end_type, end_count, end_until, template, materialized_until, active)
    VALUES (?, ?, 'weekly', '2026-10-05', 1, 'never', NULL, NULL, ?, '2026-10-12', 1)`).run(SID, uid,
    JSON.stringify({ tplDays: [{ offset: 0, time_from: '07:00', time_to: '15:30', break_minutes: 0 }], assigned_user_ids: [uid], color: '#f59e0b' }));
  // „ganze Serie"-Erinnerung (reicht bis zum letzten Vorkommen 2026-10-12): auf beide vorhandenen
  const RG = crypto.randomUUID();
  addReminder(db, { userId: uid, group_id: gA, series_id: SID, occurrence_date: '2026-10-05', reminder_group: RG, lead_num: 1, lead_unit: 'week' });
  addReminder(db, { userId: uid, group_id: gB, series_id: SID, occurrence_date: '2026-10-12', reminder_group: RG, lead_num: 1, lead_unit: 'week' });
  // „nur dieser" auf dem 1. (reicht NICHT bis zum Ende) → darf NICHT mitwachsen
  const RG2 = crypto.randomUUID();
  addReminder(db, { userId: uid, group_id: gA, series_id: SID, occurrence_date: '2026-10-05', reminder_group: RG2, lead_num: 3, lead_unit: 'day' });

  const remAt = (od) => db.prepare('SELECT * FROM planning_reminders WHERE series_id = ? AND occurrence_date = ?').all(SID, od);
  const before = db.prepare('SELECT COUNT(*) n FROM planning_entries WHERE series_id = ?').get(SID).n;
  extendSeries(db, NOW);
  const after = db.prepare('SELECT COUNT(*) n FROM planning_entries WHERE series_id = ?').get(SID).n;
  ok('Verlängerung legt neue Vorkommen an', after > before + 50);
  const at19 = remAt('2026-10-19');
  ok('neues Vorkommen 19.10. hat die „ganze Serie"-Erinnerung (RG, 1 week)', at19.length === 1 && at19[0].reminder_group === RG && at19[0].lead_num === 1 && at19[0].lead_unit === 'week');
  ok('„nur dieser" (RG2) wächst NICHT mit', !at19.some(r => r.reminder_group === RG2));
  const at2yr = remAt('2027-10-04'); // ~letztes Vorkommen im Horizont
  ok('auch weit vorn (~2 Jahre) ist die Erinnerung da', at2yr.length === 1 && at2yr[0].reminder_group === RG);

  console.log(`\nPlanning-Reminders-Scheduler: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
