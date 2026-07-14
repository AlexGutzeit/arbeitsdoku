// Unit-Test: Urlaubskonto-Berechnung (entitlementFor + vacationAccount) gegen eine frische Temp-DB.
// Deckt: Anspruch-Versionsauswahl, genommen/geplant-Split am Stichtag, die drei Verfall-Modi
// (yearend/never/date) inkl. Modus-Wechsel zwischen Zeilen (wirkt nur vorwärts), negativer Rest.
//   node tests/vacation-account.js
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), 'vacation-account-test-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const { vacationAccount, entitlementFor, countUrlaubDaysInYear } = require('../routes/absence-days');

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

  // 8h Mo–Fr ab 2020 → nur Wochentage zählen als Arbeitstage
  db.prepare('DELETE FROM user_target_hours WHERE user_id = ?').run(uid);
  db.prepare(`INSERT INTO user_target_hours
    (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from)
    VALUES (?, 40, 8,8,8,8,8, '2020-01-01')`).run(uid);

  const insUrlaub = db.prepare(`INSERT INTO absences (user_id, type, date_from, date_to, status, created_at)
    VALUES (?, 'urlaub', ?, ?, ?, datetime('now'))`);
  const insEnt = db.prepare(`INSERT INTO vacation_entitlements (user_id, valid_from, days, carryover_mode, carryover_until)
    VALUES (?, ?, ?, ?, ?)`);
  const resetAbs = () => db.prepare('DELETE FROM absences WHERE user_id = ?').run(uid);
  const resetEnt = () => db.prepare('DELETE FROM vacation_entitlements WHERE user_id = ?').run(uid);

  const NOW = '2026-07-15';       // Stichtag für den Split
  const NOW_EARLY = '2026-02-15'; // vor einem 31.3.-Verfall

  // --- Ohne jeden Eintrag: alles 0 ---
  console.log('\nOhne Anspruch-Zeile:');
  resetAbs(); resetEnt();
  eq('  entitlementFor days', entitlementFor(db, uid, 2026).days, 0);
  let a = vacationAccount(db, uid, 2026, NOW);
  eq('  anspruch', a.anspruch, 0);
  eq('  uebertrag', a.uebertrag, 0);
  eq('  rest', a.rest, 0);

  // Urlaubsblöcke (nur Wochentage): 2025 = 10 AT (02.–13.06.), 2026 Vergangenheit = 5 AT (01.–05.06.),
  // 2026 Zukunft = 5 AT (03.–07.08., nach NOW).
  const seedUrlaub = () => {
    resetAbs();
    insUrlaub.run(uid, '2025-06-02', '2025-06-13', 'approved'); // 10 Wochentage
    insUrlaub.run(uid, '2026-06-01', '2026-06-05', 'approved'); // 5 Wochentage (≤ NOW)
    insUrlaub.run(uid, '2026-08-03', '2026-08-07', 'approved'); // 5 Wochentage (> NOW)
  };
  const taken2025 = () => countUrlaubDaysInYear(db, uid, 2025);
  const taken2026 = () => countUrlaubDaysInYear(db, uid, 2026);

  // --- yearend: kein Übertrag ---
  console.log('\nVerfall = yearend (kein Übertrag):');
  resetEnt(); seedUrlaub();
  insEnt.run(uid, '2025-01-01', 30, 'yearend', null);
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  anspruch', a.anspruch, 30);
  eq('  uebertrag (verfällt)', a.uebertrag, 0);
  eq('  genommen (≤ heute)', a.genommen, 5);
  eq('  geplant (> heute)', a.geplant, 5);
  eq('  genommen+geplant = Jahresurlaub', a.genommen + a.geplant, taken2026());
  eq('  verfuegbar', a.verfuegbar, 30);
  eq('  nochZuPlanen', a.nochZuPlanen, 20);
  eq('  rest', a.rest, 25);

  // --- never: Rest läuft mit ---
  console.log('\nVerfall = never (Übertrag kumuliert):');
  resetEnt(); seedUrlaub();
  insEnt.run(uid, '2025-01-01', 30, 'never', null);
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  uebertrag = 30 − genommen2025', a.uebertrag, Math.round((30 - taken2025()) * 100) / 100);
  eq('  verfuegbar = 30 + uebertrag', a.verfuegbar, 30 + a.uebertrag);
  eq('  nochZuPlanen = verfuegbar − genommen − geplant', a.nochZuPlanen, a.verfuegbar - a.genommen - a.geplant);

  // --- date: Übertrag verfällt am 31.3. des Folgejahres ---
  console.log('\nVerfall = date (31.3. Folgejahr):');
  resetEnt(); seedUrlaub();
  insEnt.run(uid, '2025-01-01', 30, 'date', '03-31');
  a = vacationAccount(db, uid, 2026, NOW_EARLY);
  eq('  vor Stichtag: Übertrag da', a.uebertrag, Math.round((30 - taken2025()) * 100) / 100);
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  nach Stichtag: Übertrag verfallen', a.uebertrag, 0);

  // --- Modus-Wechsel zwischen Zeilen: wirkt nur vorwärts ---
  console.log('\nModus-Wechsel (2024/25 yearend → ab 2026 never):');
  resetEnt(); resetAbs();
  insEnt.run(uid, '2024-01-01', 25, 'yearend', null);
  insEnt.run(uid, '2026-01-01', 30, 'never', null);
  insUrlaub.run(uid, '2024-06-03', '2024-06-07', 'approved'); // 5 AT 2024
  insUrlaub.run(uid, '2025-06-02', '2025-06-06', 'approved'); // 5 AT 2025
  // 2026: Anspruch 30 (Zeile 2), aber Vorjahre yearend → kein Übertrag ins 2026
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  anspruch 2026 (neue Zeile)', a.anspruch, 30);
  eq('  Übertrag 2026 = 0 (Vergangenheit yearend, unberührt)', a.uebertrag, 0);
  // 2027: 2026 lief unter never → Rest von 2026 (30 − 0 genommen) wandert weiter
  const a27 = vacationAccount(db, uid, 2027, '2027-07-15');
  eq('  Übertrag 2027 = 30 − genommen2026', a27.uebertrag, Math.round((30 - taken2026()) * 100) / 100);

  // --- negativer Rest möglich (mehr genommen als verfügbar) ---
  console.log('\nNegativer Rest (Überziehung):');
  resetEnt(); resetAbs();
  insEnt.run(uid, '2026-01-01', 3, 'yearend', null);
  insUrlaub.run(uid, '2026-06-01', '2026-06-05', 'approved'); // 5 AT genommen > 3 Anspruch
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  rest negativ', a.rest, -2);

  // --- Start-Resturlaub (Übertrag ins erste erfasste Jahr) ---
  console.log('\nStart-Resturlaub:');
  resetEnt(); resetAbs();
  insEnt.run(uid, '2026-01-01', 30, 'yearend', null);
  db.prepare('UPDATE users SET vacation_start_carry = 7 WHERE id = ?').run(uid);
  a = vacationAccount(db, uid, 2026, NOW);
  eq('  Übertrag = Startsaldo 7 (erstes Jahr)', a.uebertrag, 7);
  eq('  verfuegbar = 30 + 7', a.verfuegbar, 37);
  // Folgejahr: yearend → Startsaldo verfällt mit dem Jahr, kein Dauer-Effekt
  a = vacationAccount(db, uid, 2027, '2027-07-15');
  eq('  2027 (yearend): Übertrag 0', a.uebertrag, 0);
  db.prepare('UPDATE users SET vacation_start_carry = 0 WHERE id = ?').run(uid);

  console.log(`\nVacation-Account: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
