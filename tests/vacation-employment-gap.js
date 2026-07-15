// Unit-Test: Anstellungslücke (ausgestellt→wieder eingestellt). Ein volles Jahr in der Lücke bekommt 0 Anspruch,
// und Urlaub, der in der Lücke läge, wird NICHT gezählt. „Vor der ersten Einstellung" zählt bewusst NICHT als
// Lücke (sonst verlöre jeder frisch angelegte MA rückwirkend seinen Bestand).
//   node tests/vacation-employment-gap.js
const os = require('os'), path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), 'vac-empgap-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { initDatabase, getDb } = require('../database/init');
const { vacationAccount, entitlementFor, countUrlaubDaysInYear } = require('../routes/absence-days');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✅ ' + n)) : (fail++, fails.push(n), console.log('  ❌ ' + n + (e ? '  → ' + e : '')));
const eq = (n, got, want) => ok(n + ` (=${want})`, got === want, 'ist ' + JSON.stringify(got));
const NOW = '2026-07-15';

(async () => {
  await initDatabase();
  const db = getDb();
  const mk = (nm) => db.prepare("INSERT INTO users (username,password_hash,name,role,target_hours_per_week) VALUES (?,?,?,'mitarbeiter',40)").run(nm, 'x', nm).lastInsertRowid;
  const th = (uid) => db.prepare("INSERT INTO user_target_hours (user_id,hours_per_week,hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from) VALUES (?,40,8,8,8,8,8,'2020-01-01')").run(uid);
  const emp = (uid, s, e) => db.prepare("INSERT INTO employment_periods (user_id,start_date,end_date) VALUES (?,?,?)").run(uid, s, e);
  const ent = (uid, vf, d, m) => db.prepare("INSERT INTO vacation_entitlements (user_id,valid_from,days,carryover_mode) VALUES (?,?,?,?)").run(uid, vf, d, m || 'never');
  const url = (uid, f, t) => db.prepare("INSERT INTO absences (user_id,type,date_from,date_to,status,created_at) VALUES (?,?,?,?,'approved',datetime('now'))").run(uid, 'urlaub', f, t);

  // ── MA mit ECHTER Lücke: 2020–2023 angestellt, ausgestellt, 2025 wieder eingestellt (Lücke = 2024) ──
  const G = mk('luecke'); th(G);
  emp(G, '2020-01-01', '2023-12-31'); emp(G, '2025-01-01', null);
  ent(G, '2020-01-01', 30, 'never');
  // Urlaub 2023 (angestellt, zählt), 2024 (in der Lücke, zählt NICHT), 2025 (angestellt, zählt)
  url(G, '2023-06-05', '2023-06-16'); // 10 AT (Mo–Fr × 2)
  url(G, '2024-06-03', '2024-06-14'); // 10 AT — liegt in der Lücke
  url(G, '2025-06-02', '2025-06-13'); // 10 AT

  console.log('Anstellungslücke 2024 (ausgestellt→wieder eingestellt):');
  eq('Anspruch 2023 = 30 (angestellt)', entitlementFor(db, G, 2023).days, 30);
  eq('Anspruch 2024 = 0 (volles Jahr in der Lücke)', entitlementFor(db, G, 2024).days, 0);
  eq('Anspruch 2025 = 30 (wieder angestellt)', entitlementFor(db, G, 2025).days, 30);
  eq('Urlaub 2023 zählt (10)', countUrlaubDaysInYear(db, G, 2023), 10);
  eq('Urlaub 2024 in der Lücke zählt NICHT (0)', countUrlaubDaysInYear(db, G, 2024), 0);
  eq('Urlaub 2025 zählt (10)', countUrlaubDaysInYear(db, G, 2025), 10);
  eq('2024 Konto: genommen 0 (Lücke)', vacationAccount(db, G, 2024, NOW).genommen, 0);
  eq('2024 Konto: verfuegbar 0 + Übertrag aus 2023 (never)', vacationAccount(db, G, 2024, NOW).anspruch, 0);

  // ── Gegenprobe: frisch angelegter MA, Anstellung ab „heute", historische Daten = VOR Einstellung ──
  // (wie ein API-erstellter Nutzer) → wird NICHT rückwirkend genullt.
  const F = mk('frisch'); th(F);
  emp(F, '2026-07-15', null); // eine offene Periode ab heute
  ent(F, '2025-01-01', 28, 'yearend'); ent(F, '2026-01-01', 30, 'yearend');
  url(F, '2026-06-01', '2026-06-05'); // 5 AT, liegt VOR der Einstellung (heute) — kein „Loch"
  console.log('\nFrisch angelegter MA (Anstellung ab heute, Historie = vor Einstellung):');
  eq('Anspruch 2025 NICHT genullt (28)', entitlementFor(db, F, 2025).days, 28);
  eq('Anspruch 2026 = 30', entitlementFor(db, F, 2026).days, 30);
  eq('Urlaub 2026-06 (vor Einstellung) zählt weiter (5) — keine interne Lücke', countUrlaubDaysInYear(db, F, 2026), 5);

  // ── Regression: MA ohne employment_periods → alles wie bisher ──
  const N = mk('normal'); th(N);
  ent(N, '2025-01-01', 30, 'yearend');
  url(N, '2025-06-02', '2025-06-13');
  console.log('\nMA ohne employment_periods (Abwärtskompat):');
  eq('Anspruch 2025 = 30', entitlementFor(db, N, 2025).days, 30);
  eq('Urlaub 2025 zählt (10)', countUrlaubDaysInYear(db, N, 2025), 10);

  console.log(`\nVacation-Employment-Gap: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
