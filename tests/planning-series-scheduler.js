// In-Process-Test der rollierenden Serien-Verlängerung (scheduler.extendSeries).
// Start: node tests/planning-series-scheduler.js
process.env.DB_PATH = '/tmp/planning-series-sched.db';
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
const crypto = require('crypto');
const { initDatabase, getDb } = require('../database/init');
const { extendSeries } = require('../scheduler');

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const addDaysISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonthsISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const today = new Date().toLocaleDateString('sv-SE');

function makeSeries(db, { end_type, materialized_until, end_until }) {
  const sid = crypto.randomUUID();
  db.prepare(`INSERT INTO planning_series (series_id, created_by, freq, anchor_date, interval_weeks, end_type, end_count, end_until, template, materialized_until, active)
    VALUES (?, 1, 'weekly', ?, 1, ?, NULL, ?, ?, ?, 1)`).run(
    sid, today, end_type, end_until || null,
    JSON.stringify({ tplDays: [{ offset: 0, time_from: '07:00', time_to: '15:30', break_minutes: 30 }], assigned_user_ids: [1], color: '#f59e0b' }),
    materialized_until);
  return sid;
}
const countOf = (db, sid) => db.prepare('SELECT COUNT(*) AS n FROM planning_entries WHERE series_id = ?').get(sid).n;

(async () => {
  await initDatabase();
  const db = getDb();

  // never-Serie, künstlich nur bis heute+10 Tage materialisiert → Verlängerung soll auffüllen bis heute+24 Monate
  const sid = makeSeries(db, { end_type: 'never', materialized_until: addDaysISO(today, 10) });
  ok('vor Verlängerung: 0 Einträge', countOf(db, sid) === 0);
  const added = extendSeries(db);
  ok('Verlängerung legt viele Vorkommen an (~2 Jahre wöchentlich)', added > 90, 'added=' + added);
  const rows = db.prepare('SELECT occurrence_date FROM planning_entries WHERE series_id = ? ORDER BY occurrence_date', ).all(sid);
  ok('nur Vorkommen NACH dem alten Horizont (heute+10)', rows.every(r => r.occurrence_date > addDaysISO(today, 10)));
  ok('materialized_until auf heute+24 Monate gesetzt', db.prepare('SELECT materialized_until AS m FROM planning_series WHERE series_id=?').get(sid).m === addMonthsISO(today, 24));

  // erneuter Lauf ist idempotent (Horizont schon erreicht)
  const again = extendSeries(db);
  ok('zweiter Lauf fügt nichts hinzu (idempotent)', again === 0, 'again=' + again);

  // until-Serie wird NICHT verlängert
  const sidUntil = makeSeries(db, { end_type: 'until', end_until: addDaysISO(today, 30), materialized_until: addDaysISO(today, 30) });
  const beforeU = countOf(db, sidUntil);
  extendSeries(db);
  ok('until-Serie wird nicht verlängert', countOf(db, sidUntil) === beforeU);

  console.log(`\nPlanning-Series-Scheduler: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
