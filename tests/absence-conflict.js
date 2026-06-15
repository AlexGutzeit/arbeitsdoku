// Test: Doppelbuchung innerhalb derselben Stufe wird verhindert, stufenübergreifend bleibt erlaubt.
// Reiner Logik-Test (sameTierConflict) gegen eine frische Temp-DB — kein Server nötig:
//   node tests/absence-conflict.js
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), 'abs-conflict-test-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const { sameTierConflict } = require('../routes/absences');

let pass = 0, fail = 0; const fails = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

(async () => {
  await initDatabase();
  const db = getDb();
  const uid = db.prepare("SELECT id FROM users WHERE username = 'max'").get().id;
  const ins = db.prepare(`INSERT INTO absences (user_id, type, date_from, date_to, status, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`);
  const reset = () => db.prepare('DELETE FROM absences').run();
  // Konflikt vorhanden? (true wenn sameTierConflict einen Datensatz liefert)
  const conflicts = (type, from, to) => !!sameTierConflict(db, uid, type, from, to, null);

  console.log('\nLeave-Gruppe (Urlaub/FZA/Sonderurlaub):');
  reset(); ins.run(uid, 'urlaub', '2026-06-15', '2026-06-16', 'approved');
  assert('FZA überschneidet Urlaub → Konflikt', conflicts('freizeitausgleich', '2026-06-16', '2026-06-17'));
  assert('Sonderurlaub überschneidet Urlaub → Konflikt', conflicts('sonderurlaub', '2026-06-15', '2026-06-15'));
  assert('Urlaub überschneidet Urlaub → Konflikt', conflicts('urlaub', '2026-06-16', '2026-06-18'));
  assert('FZA daneben (kein Overlap) → ok', !conflicts('freizeitausgleich', '2026-06-17', '2026-06-18'));

  console.log('\nSchul-Gruppe (Berufsschule/Innung):');
  reset(); ins.run(uid, 'berufsschule', '2026-06-17', '2026-06-17', 'active');
  assert('Innung überschneidet Berufsschule → Konflikt', conflicts('innung', '2026-06-17', '2026-06-17'));
  assert('Innung daneben → ok', !conflicts('innung', '2026-06-18', '2026-06-18'));

  console.log('\nKrank gegen Krank:');
  reset(); ins.run(uid, 'krank', '2026-06-15', '2026-06-16', 'active');
  assert('Krank überschneidet Krank → Konflikt', conflicts('krank', '2026-06-16', '2026-06-16'));

  console.log('\nStufenübergreifend bleibt ERLAUBT:');
  reset(); ins.run(uid, 'urlaub', '2026-06-15', '2026-06-19', 'approved');
  assert('Krank über Urlaub → erlaubt', !conflicts('krank', '2026-06-16', '2026-06-16'));
  assert('Berufsschule über Urlaub → erlaubt', !conflicts('berufsschule', '2026-06-16', '2026-06-16'));
  reset(); ins.run(uid, 'krank', '2026-06-15', '2026-06-15', 'active');
  assert('Urlaub über Krank → erlaubt', !conflicts('urlaub', '2026-06-15', '2026-06-15'));

  console.log('\nGelöschte/abgelehnte Datensätze zählen NICHT:');
  reset();
  ins.run(uid, 'urlaub', '2026-06-15', '2026-06-15', 'rejected');
  db.prepare(`INSERT INTO absences (user_id,type,date_from,date_to,status,deleted_at,created_at)
    VALUES (?, 'urlaub','2026-06-16','2026-06-16','approved',datetime('now'),datetime('now'))`).run(uid);
  assert('rejected überschneidet → kein Konflikt', !conflicts('fza' === 'fza' ? 'freizeitausgleich' : 'urlaub', '2026-06-15', '2026-06-15'));
  assert('soft-deleted überschneidet → kein Konflikt', !conflicts('urlaub', '2026-06-16', '2026-06-16'));

  console.log(`\nErgebnis: ${pass} ok, ${fail} fehlgeschlagen`);
  if (fail > 0) console.log('Fehlgeschlagen: ' + fails.join(', '));
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
