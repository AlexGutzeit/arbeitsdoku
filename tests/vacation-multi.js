// Unit-Test: mehrere Mitarbeiter PARALLEL, jeder mit eigenem Anspruchsverlauf über mehrere Jahre und
// eigenem Verfall-Umgang. Prüft, dass jede Berechnung individuell UND unabhängig voneinander ist.
//   node tests/vacation-multi.js
const os = require('os'), path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), 'vacation-multi-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const { vacationAccount, entitlementFor } = require('../routes/absence-days');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✅ ' + n)) : (fail++, fails.push(n), console.log('  ❌ ' + n + (e ? '  → ' + e : '')));
const r2 = v => Math.round(v * 100) / 100;
const NOW = '2026-07-14';

(async () => {
  await initDatabase();
  const db = getDb();

  // Frische MA anlegen (unabhängig von Seed-Usern)
  let uidSeq = 0;
  const mkUser = (name) => {
    const un = 'vm_' + (++uidSeq);
    const info = db.prepare("INSERT INTO users (username,password_hash,name,role,target_hours_per_week) VALUES (?,?,?,'mitarbeiter',40)").run(un, 'x', name);
    return info.lastInsertRowid;
  };
  const ent = (uid, vf, days, mode, until) => db.prepare("INSERT INTO vacation_entitlements (user_id,valid_from,days,carryover_mode,carryover_until) VALUES (?,?,?,?,?)").run(uid, vf, days, mode, until || null);
  const startCarry = (uid, d) => db.prepare("UPDATE users SET vacation_start_carry=? WHERE id=?").run(d, uid);
  const urlaub = (uid, from, to) => db.prepare("INSERT INTO absences (user_id,type,date_from,date_to,status,created_at) VALUES (?,?,?,?,'approved',datetime('now'))").run(uid, 'urlaub', from, to);

  const va = (uid, y, now) => vacationAccount(db, uid, y, now || NOW);
  // Erwartete Übertrag-Regel je Modus, aus den Vorjahres-Ausgaben der FUNKTION selbst abgeleitet (robust,
  // unabhängig von Wochentag-Zählung): never → Vorjahres-Rest; yearend → 0; date → Vorjahres-Rest bzw. 0.
  const restOf = (uid, y, now) => { const v = va(uid, y, now); return r2(v.verfuegbar - v.genommen - v.geplant); };

  // ── MA A „Anna": IMMER yearend, wechselnde Tage über 3 Jahre ──
  const A = mkUser('Anna');
  ent(A, '2024-01-01', 25, 'yearend'); ent(A, '2025-01-01', 28, 'yearend'); ent(A, '2026-01-01', 30, 'yearend');
  urlaub(A, '2024-06-03', '2024-06-14'); urlaub(A, '2025-06-02', '2025-06-13');
  urlaub(A, '2026-06-01', '2026-06-05'); urlaub(A, '2026-08-03', '2026-08-07');

  // ── MA B „Bernd": never (kumuliert), eine Zeile über alle Jahre ──
  const B = mkUser('Bernd');
  ent(B, '2024-01-01', 30, 'never');
  urlaub(B, '2024-06-03', '2024-06-07'); urlaub(B, '2025-06-02', '2025-06-06'); urlaub(B, '2026-06-01', '2026-06-05');

  // ── MA C „Clara": date-Verfall 31.3. des Folgejahres ──
  const C = mkUser('Clara');
  ent(C, '2025-01-01', 24, 'date', '03-31');
  urlaub(C, '2025-06-02', '2025-06-06'); urlaub(C, '2026-06-01', '2026-06-05');

  // ── MA D „Dieter": Start-Resturlaub + Moduswechsel (2024 yearend → 2026 never) ──
  const D = mkUser('Dieter');
  startCarry(D, 8); ent(D, '2024-01-01', 25, 'yearend'); ent(D, '2026-01-01', 30, 'never');

  // ── MA E „Erik": NICHTS konfiguriert ──
  const E = mkUser('Erik');
  urlaub(E, '2026-06-01', '2026-06-05'); // hat Urlaub, aber keinen Anspruch

  // ===== Anna: yearend → nie Übertrag; Anspruch je Jahr exakt die Zeile =====
  console.log('\nAnna (yearend, 25/28/30):');
  ok('Anspruch 2024=25, 2025=28, 2026=30', va(A, 2024).anspruch === 25 && va(A, 2025).anspruch === 28 && va(A, 2026).anspruch === 30);
  ok('Übertrag immer 0 (yearend)', va(A, 2025).uebertrag === 0 && va(A, 2026).uebertrag === 0 && va(A, 2027).uebertrag === 0);
  ok('2026: verfuegbar=30, nochZuPlanen=verfuegbar−genommen−geplant', va(A, 2026).verfuegbar === 30 && r2(va(A, 2026).nochZuPlanen) === r2(30 - va(A, 2026).genommen - va(A, 2026).geplant));
  ok('genommen(2026) aus Vergangenheit, geplant aus Zukunft', va(A, 2026).genommen === 5 && va(A, 2026).geplant === 5);

  // ===== Bernd: never → Übertrag = Vorjahres-Rest, kumuliert =====
  console.log('\nBernd (never, kumuliert):');
  ok('Anspruch jedes Jahr 30 (eine Zeile)', va(B, 2024).anspruch === 30 && va(B, 2026).anspruch === 30);
  ok('Übertrag 2025 = Rest 2024', va(B, 2025).uebertrag === restOf(B, 2024));
  ok('Übertrag 2026 = Rest 2025 (kumuliert)', va(B, 2026).uebertrag === restOf(B, 2025));
  ok('Übertrag 2026 > 0 (läuft mit)', va(B, 2026).uebertrag > 0, 'uebertrag=' + va(B, 2026).uebertrag);

  // ===== Clara: date-Verfall — vor Stichtag Übertrag da, nach Stichtag weg =====
  console.log('\nClara (date 31.3.):');
  ok('vor 31.3.2026: Übertrag = Rest 2025', va(C, 2026, '2026-02-15').uebertrag === restOf(C, 2025, '2026-02-15') && va(C, 2026, '2026-02-15').uebertrag > 0, 'uebertrag=' + va(C, 2026, '2026-02-15').uebertrag);
  ok('nach 31.3.2026 (heute): Übertrag verfallen = 0', va(C, 2026, NOW).uebertrag === 0);
  ok('Anspruch 2026 = 24 (Zeile von 2025 gilt weiter)', va(C, 2026).anspruch === 24);

  // ===== Dieter: Start-Resturlaub + Moduswechsel =====
  console.log('\nDieter (start_carry 8, yearend→never):');
  ok('2024: Übertrag = Start-Resturlaub 8 (erstes Jahr)', va(D, 2024).uebertrag === 8);
  ok('2025: yearend → Übertrag 0', va(D, 2025).uebertrag === 0);
  ok('2026: neue Zeile 30, Übertrag 0 (Vergangenheit yearend)', va(D, 2026).anspruch === 30 && va(D, 2026).uebertrag === 0);
  ok('2027: 2026 lief never → Übertrag = Rest 2026', va(D, 2027).uebertrag === restOf(D, 2026));

  // ===== Erik: nichts konfiguriert =====
  console.log('\nErik (unkonfiguriert):');
  ok('configured=false, anspruch 0, verfuegbar 0', va(E, 2026).configured === false && va(E, 2026).anspruch === 0 && va(E, 2026).verfuegbar === 0);
  ok('genommen zählt trotzdem (5)', va(E, 2026).genommen === 5);

  // ===== UNABHÄNGIGKEIT: gleiche Jahre, aber jede MA-Rechnung eigenständig =====
  console.log('\nUnabhängigkeit der Mitarbeiter:');
  ok('A/B/C/D 2026 configured, E nicht', va(A, 2026).configured && va(B, 2026).configured && va(C, 2026).configured && va(D, 2026).configured && !va(E, 2026).configured);
  ok('Übertrag 2026 unterscheidet sich je MA (A=0, B>0, C=0, D=0)', va(A, 2026).uebertrag === 0 && va(B, 2026).uebertrag > 0 && va(C, 2026).uebertrag === 0 && va(D, 2026).uebertrag === 0);
  ok('Anspruch 2026 unterschiedlich (A=30, C=24)', va(A, 2026).anspruch === 30 && va(C, 2026).anspruch === 24);
  // Reihenfolge-/Seiteneffekt-Test: Snapshot A, alle anderen neu berechnen, A erneut → identisch
  const snapA = JSON.stringify(va(A, 2026));
  for (const u of [B, C, D, E]) { va(u, 2024); va(u, 2025); va(u, 2026); va(u, 2027); }
  ok('A unverändert nach Berechnung aller anderen (kein Seiteneffekt)', JSON.stringify(va(A, 2026)) === snapA, 'vorher=' + snapA + ' nachher=' + JSON.stringify(va(A, 2026)));
  ok('Wiederholte Berechnung deterministisch', JSON.stringify(va(B, 2026)) === JSON.stringify(va(B, 2026)));

  console.log(`\nVacation-Multi: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
