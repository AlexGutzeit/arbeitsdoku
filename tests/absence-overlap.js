// Regressionstest: prioritätsbewusste Abwesenheits-Zählung (gemeinsame Quelle für
// /api/absences/summary UND PDF). Deckt den Bug ab, bei dem die PDF Urlaub/FZA
// überzählte, wenn sich Krank damit überschnitt.
//
// Reiner Logik-Test gegen eine frische Temp-DB — kein Server nötig:
//   node tests/absence-overlap.js
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), 'abs-overlap-test-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const { computeAbsenceSummary, countUrlaubDaysInYear } = require('../routes/absence-days');

let pass = 0, fail = 0; const fails = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, got, want) { assert(name + ` (=${want})`, got === want, 'ist ' + JSON.stringify(got)); }

(async () => {
  await initDatabase();
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;

  db.prepare('DELETE FROM user_target_hours WHERE user_id = ?').run(uid);
  db.prepare(`INSERT INTO user_target_hours
    (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from)
    VALUES (?, 40, 8,8,8,8,8, '2020-01-01')`).run(uid);

  const insAbs = db.prepare(`INSERT INTO absences (user_id, type, date_from, date_to, status, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`);
  const insHol = db.prepare(`INSERT INTO absences (user_id, type, date_from, date_to, status, created_at)
    VALUES (NULL, 'feiertag', ?, ?, 'active', datetime('now'))`);
  const reset = () => db.prepare('DELETE FROM absences').run();

  // Woche: Mo 15.06 .. Fr 19.06.2026
  const FROM = '2026-06-15', TO = '2026-06-19';

  // --- Fall A: Urlaub Mo-Di + FZA Do-Fr, KEIN Krank ---
  console.log('\nFall A — Urlaub Mo-Di, FZA Do-Fr (keine Überschneidung):');
  reset();
  insAbs.run(uid, 'urlaub', '2026-06-15', '2026-06-16', 'approved');
  insAbs.run(uid, 'freizeitausgleich', '2026-06-18', '2026-06-19', 'approved');
  let s = computeAbsenceSummary(db, uid, FROM, TO);
  eq('  Urlaub', s.summary.urlaub, 2);
  eq('  FZA', s.summary.freizeitausgleich, 2);
  eq('  Abwesenheitstage gesamt', s.totalUniqueDays, 4);
  eq('  Urlaubstage/Jahr', countUrlaubDaysInYear(db, uid, 2026), 2);

  // --- Fall B: + Krank Di-Do (Kern-Szenario des Users) ---
  console.log('\nFall B — zusätzlich Krank Di-Do (Überschneidung):');
  insAbs.run(uid, 'krank', '2026-06-16', '2026-06-18', 'active');
  s = computeAbsenceSummary(db, uid, FROM, TO);
  eq('  Urlaub (Di zurückgegeben)', s.summary.urlaub, 1);
  eq('  FZA (Do zurückgegeben)', s.summary.freizeitausgleich, 1);
  eq('  Krank', s.summary.krank, 3);
  eq('  Abwesenheitstage gesamt', s.totalUniqueDays, 5);
  eq('  Urlaubstage/Jahr', countUrlaubDaysInYear(db, uid, 2026), 1);

  // --- Fall C: Feiertag verdrängt Urlaub ---
  console.log('\nFall C — Feiertag am Mo überschneidet Urlaub Mo-Di:');
  reset();
  insAbs.run(uid, 'urlaub', '2026-06-15', '2026-06-16', 'approved');
  insHol.run('2026-06-15', '2026-06-15');
  s = computeAbsenceSummary(db, uid, FROM, TO);
  eq('  Urlaub (Mo ist Feiertag)', s.summary.urlaub, 1);
  eq('  Feiertag', s.summary.feiertag, 1);
  eq('  Urlaubstage/Jahr', countUrlaubDaysInYear(db, uid, 2026), 1);

  // --- Fall D: Wochenende zählt nie ---
  console.log('\nFall D — Urlaub inkl. Wochenende (Fr-Mo):');
  reset();
  insAbs.run(uid, 'urlaub', '2026-06-19', '2026-06-22', 'approved'); // Fr,Sa,So,Mo
  s = computeAbsenceSummary(db, uid, '2026-06-19', '2026-06-22');
  eq('  Urlaub (nur Fr+Mo)', s.summary.urlaub, 2);

  console.log(`\nErgebnis: ${pass} ok, ${fail} fehlgeschlagen`);
  if (fail > 0) { console.log('Fehlgeschlagen: ' + fails.join(', ')); }
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
