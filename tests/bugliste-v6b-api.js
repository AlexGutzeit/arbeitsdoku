// Unit/API-Test Bugliste v6, Runde 2:
//  A3  Urlaubs-Übertrag Modus „date": nur der bis zum Stichtag NICHT genutzte Rest verfällt.
//  A7a Mehrtages-Dedup greift nur bei WIRKLICH gleichen Tagen.
//   node tests/bugliste-v6b-api.js
const os = require('os'), path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), 'v6b-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const { initDatabase, getDb } = require('../database/init');
const { vacationAccount } = require('../routes/absence-days');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

(async () => {
  await initDatabase();
  const db = getDb();
  const mk = (nm) => db.prepare("INSERT INTO users (username,password_hash,name,role,target_hours_per_week) VALUES (?,?,?,'mitarbeiter',40)").run(nm, 'x', nm).lastInsertRowid;
  const th = (uid) => db.prepare("INSERT INTO user_target_hours (user_id,hours_per_week,hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from) VALUES (?,40,8,8,8,8,8,'2024-01-01')").run(uid);
  const ent = (uid, vf, d, mode, until) => db.prepare("INSERT INTO vacation_entitlements (user_id,valid_from,days,carryover_mode,carryover_until) VALUES (?,?,?,?,?)").run(uid, vf, d, mode, until || null);
  const url = (uid, f, t) => db.prepare("INSERT INTO absences (user_id,type,date_from,date_to,status,created_at) VALUES (?,'urlaub',?,?,'approved',datetime('now'))").run(uid, f, t);

  // ── A3: Anspruch 2025 = 30 Tage, Rest verfällt am 31.03. des Folgejahres ──
  // 2025: 20 Tage genommen → Rest 10. 2026: die 10 Resttage im Februar (VOR dem Stichtag) + 30 eigene.
  console.log('A3 — Übertrag mit Verfall-Stichtag:');
  const u = mk('verfall'); th(u);
  ent(u, '2025-01-01', 30, 'date', '03-31');
  ent(u, '2026-01-01', 30, 'date', '03-31');
  // 2025: 20 Arbeitstage Urlaub (4 volle Wochen Mo–Fr)
  for (const [f, t] of [['2025-06-02', '2025-06-06'], ['2025-06-09', '2025-06-13'], ['2025-06-16', '2025-06-20'], ['2025-06-23', '2025-06-27']]) url(u, f, t);
  // 2026: 10 Arbeitstage im Februar (vor dem 31.03.) — das ist genau der Übertrag
  for (const [f, t] of [['2026-02-02', '2026-02-06'], ['2026-02-09', '2026-02-13']]) url(u, f, t);

  const vorStichtag = vacationAccount(db, u, 2026, '2026-02-20');
  ok('vor dem Stichtag: Übertrag 10', vorStichtag.uebertrag === 10, 'ist ' + vorStichtag.uebertrag);
  ok('vor dem Stichtag: nichts überzogen (nochZuPlanen 30)', vorStichtag.nochZuPlanen === 30, 'ist ' + vorStichtag.nochZuPlanen);

  const nachStichtag = vacationAccount(db, u, 2026, '2026-04-01');
  ok('nach dem Stichtag: genutzter Übertrag bleibt erhalten (10)', nachStichtag.uebertrag === 10, 'ist ' + nachStichtag.uebertrag);
  ok('nach dem Stichtag: KEIN Minus (nochZuPlanen 30)', nachStichtag.nochZuPlanen === 30, 'ist ' + nachStichtag.nochZuPlanen);

  // ── Gegenprobe: Übertrag NICHT genutzt → verfällt korrekt ──
  const v = mk('verfall2'); th(v);
  ent(v, '2025-01-01', 30, 'date', '03-31');
  ent(v, '2026-01-01', 30, 'date', '03-31');
  for (const [f, t] of [['2025-06-02', '2025-06-06'], ['2025-06-09', '2025-06-13'], ['2025-06-16', '2025-06-20'], ['2025-06-23', '2025-06-27']]) url(v, f, t);
  const ungenutzt = vacationAccount(db, v, 2026, '2026-04-01');
  ok('ungenutzter Übertrag verfällt (0)', ungenutzt.uebertrag === 0, 'ist ' + ungenutzt.uebertrag);
  ok('vor Stichtag wäre er noch da (10)', vacationAccount(db, v, 2026, '2026-03-01').uebertrag === 10);

  // ── Teilnutzung: 5 von 10 Tagen vor dem Stichtag genommen → 5 bleiben, 5 verfallen ──
  const w = mk('verfall3'); th(w);
  ent(w, '2025-01-01', 30, 'date', '03-31');
  ent(w, '2026-01-01', 30, 'date', '03-31');
  for (const [f, t] of [['2025-06-02', '2025-06-06'], ['2025-06-09', '2025-06-13'], ['2025-06-16', '2025-06-20'], ['2025-06-23', '2025-06-27']]) url(w, f, t);
  url(w, '2026-02-02', '2026-02-06'); // 5 Tage
  const teil = vacationAccount(db, w, 2026, '2026-04-01');
  ok('Teilnutzung: 5 genutzt → Übertrag 5 (Rest verfallen)', teil.uebertrag === 5, 'ist ' + teil.uebertrag);

  // ── Minus-Saldo bleibt Schuld (bestehende Regel darf nicht kippen) ──
  const m = mk('minus'); th(m);
  ent(m, '2025-01-01', 10, 'date', '03-31');
  ent(m, '2026-01-01', 30, 'date', '03-31');
  for (const [f, t] of [['2025-06-02', '2025-06-06'], ['2025-06-09', '2025-06-13'], ['2025-06-16', '2025-06-20']]) url(m, f, t); // 15 von 10
  const minus = vacationAccount(db, m, 2026, '2026-04-01');
  ok('Überziehung wird als Schuld vorgetragen (-5)', minus.uebertrag === -5, 'ist ' + minus.uebertrag);

  // ── „never"/„yearend" unverändert ──
  const n1 = mk('never1'); th(n1);
  ent(n1, '2025-01-01', 30, 'never'); ent(n1, '2026-01-01', 30, 'never');
  for (const [f, t] of [['2025-06-02', '2025-06-06']]) url(n1, f, t); // 5 genommen → 25 Rest
  ok('Modus never: voller Rest wird vorgetragen (25)', vacationAccount(db, n1, 2026, '2026-04-01').uebertrag === 25, 'ist ' + vacationAccount(db, n1, 2026, '2026-04-01').uebertrag);
  const y1 = mk('yearend1'); th(y1);
  ent(y1, '2025-01-01', 30, 'yearend'); ent(y1, '2026-01-01', 30, 'yearend');
  for (const [f, t] of [['2025-06-02', '2025-06-06']]) url(y1, f, t);
  ok('Modus yearend: Rest verfällt (0)', vacationAccount(db, y1, 2026, '2026-04-01').uebertrag === 0);

  console.log(`\nBugliste-v6b: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
