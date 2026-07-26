// Komplexer Integrationstest: Berechnung (Soll/Ist/Ueber) + Versionierung (Papierkorb/History)
//
// Voraussetzung: lokaler Server laeuft auf :3000 mit einem anonymisierten Prod-Clone
// (alle Passwoerter 'test', siehe scripts/clone-db.sh). Start z.B. `PORT=3000 npm start`.
// Ausfuehren: node tests/complex-saldo-versioning.js
// Legt einen frischen Test-Mitarbeiter an (Soll 8h/Tag) und loescht ihn am Ende wieder.
//
// Prueft das End-to-End-Zusammenspiel: krank/Urlaub/Feiertag setzen Soll=0, FZA nicht;
// Soft-Delete + Restore passen Ist/Soll sofort an; jede Aenderung landet in Papierkorb + History.
const BASE = 'http://localhost:3000';
let TOK = '';
let pass = 0, fail = 0;
const fails = [];

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOK) opts.headers.Authorization = 'Bearer ' + TOK;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data };
}
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function approxEq(a, b) { return Math.abs(a - b) < 0.001; }

// Soll/Ist/Ueber fuer eine Woche (date = Montag) eines Users
async function weekStat(uid, monday) {
  const r = await api('GET', `/api/statistics?period=week&date=${monday}&user_ids=${uid}`);
  const u = r.data.users ? r.data.users[0] : (r.data.userStats ? r.data.userStats[0] : null);
  // Antwortstruktur: { users: [...], combined: {...} } — Feldname pruefen
  return u || (r.data.combined ? r.data.combined : r.data);
}

function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

(async () => {
  // Login
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'test' });
  TOK = login.data.token;
  if (!TOK) { console.log('LOGIN FEHLGESCHLAGEN'); process.exit(1); }

  // Frischen Test-Mitarbeiter anlegen: alle Wochentage 8h Soll (Wochen-Soll 40)
  const uname = 'tutest_' + Date.now();
  const cu = await api('POST', '/api/users', {
    username: uname, password: 'Test1234!', name: 'Test Mitarbeiter', role: 'mitarbeiter',
    hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8,
  });
  const uid = cu.data.user.id;
  console.log('Test-Mitarbeiter id=' + uid + ' (' + uname + '), Soll 8h/Tag\n');

  // Test-Woche: ~10 Wochen in der Zukunft, Montag bestimmen
  let base = addDays(new Date(), 70);
  while (base.getDay() !== 1) base = addDays(base, 1);
  const D = [0,1,2,3,4].map(i => fmt(addDays(base, i))); // Mo..Fr
  const MON = D[0];
  console.log('Test-Woche Mo–Fr: ' + D.join(', ') + '\n');

  const stundenEintrag = (date, uid) => api('POST', '/api/entries', {
    date, time_from: '07:00', time_to: '15:00', break_minutes: 0, user_id: uid, description: 'Test ' + date,
  });

  // ===== S0: Baseline =====
  console.log('S0 — Baseline (keine Eintraege/Abwesenheiten):');
  let s = await weekStat(uid, MON);
  assert('Soll = 40', approxEq(s.soll, 40), 'soll=' + s.soll);
  assert('Ist = 0', approxEq(s.ist, 0), 'ist=' + s.ist);
  assert('Ueber = -40', approxEq(s.ueber, -40), 'ueber=' + s.ueber);

  // ===== S1: Mo–Do je 8h Eintrag, Fr krank =====
  console.log('\nS1 — Eintraege Mo–Do (je 8h) + Freitag krank:');
  const eIds = [];
  for (let i = 0; i < 4; i++) { const r = await stundenEintrag(D[i], uid); eIds.push(r.data.entry.id); }
  const krank = await api('POST', '/api/absences', { type: 'krank', date_from: D[4], date_to: D[4], target_user_id: uid });
  const krankId = krank.data.absence.id;
  s = await weekStat(uid, MON);
  assert('Soll = 32 (Fr durch krank auf 0)', approxEq(s.soll, 32), 'soll=' + s.soll);
  assert('Ist = 32 (4×8h)', approxEq(s.ist, 32), 'ist=' + s.ist);
  assert('Ueber = 0', approxEq(s.ueber, 0), 'ueber=' + s.ueber);

  // ===== S2: krank loeschen + FZA Freitag + genehmigen =====
  console.log('\nS2 — krank loeschen (Papierkorb) + Freizeitausgleich Fr genehmigt:');
  const delKrank = await api('DELETE', '/api/absences/' + krankId, { reason: 'durch FZA ersetzt' });
  assert('krank Soft-Delete HTTP 200', delKrank.status === 200, 'status=' + delKrank.status);
  const fza = await api('POST', '/api/absences', { type: 'freizeitausgleich', date_from: D[4], date_to: D[4], target_user_id: uid });
  const fzaId = fza.data.absence.id;
  const appFza = await api('POST', '/api/absences/' + fzaId + '/approve');
  assert('FZA genehmigt HTTP 200', appFza.status === 200, 'status=' + appFza.status);
  // krank im Papierkorb?
  const trashAbs = await api('GET', '/api/absences/deleted/list');
  const krankInTrash = trashAbs.data.absences.find(a => a.id === krankId);
  assert('krank ist im Abwesenheits-Papierkorb', !!krankInTrash);
  assert('krank-Papierkorb zeigt Begruendung', krankInTrash && krankInTrash.delete_reason === 'durch FZA ersetzt', krankInTrash && krankInTrash.delete_reason);
  // History des krank-Eintrags
  const krankHist = await api('GET', '/api/absences/' + krankId + '/history');
  assert('krank-History enthaelt delete', krankHist.data.history.some(h => h.action === 'delete'));
  // Saldo: FZA setzt Soll NICHT auf 0 → Soll wieder 40
  s = await weekStat(uid, MON);
  assert('Soll = 40 (FZA setzt Soll nicht auf 0)', approxEq(s.soll, 40), 'soll=' + s.soll);
  assert('Ist = 32 (unveraendert)', approxEq(s.ist, 32), 'ist=' + s.ist);
  assert('Ueber = -8 (FZA zehrt 8h Ueberstunden)', approxEq(s.ueber, -8), 'ueber=' + s.ueber);

  // ===== S3: Montags-Eintrag loeschen =====
  console.log('\nS3 — Montags-Eintrag loeschen (Papierkorb):');
  const monEntryId = eIds[0];
  const delMon = await api('DELETE', '/api/entries/' + monEntryId, { reason: 'Doppelt erfasst' });
  assert('Montags-Eintrag Soft-Delete HTTP 200', delMon.status === 200, 'status=' + delMon.status);
  const trashEnt = await api('GET', '/api/entries/deleted');
  assert('Montags-Eintrag im Eintrags-Papierkorb', trashEnt.data.entries.some(e => e.id === monEntryId));
  const entHist = await api('GET', '/api/entries/' + monEntryId + '/history');
  assert('Eintrags-History enthaelt delete + Vorher-Werte', entHist.data.history.some(h => h.action === 'delete' && h.snapshot && h.snapshot.date === D[0]));
  s = await weekStat(uid, MON);
  assert('Ist = 24 (Mo faellt weg)', approxEq(s.ist, 24), 'ist=' + s.ist);
  assert('Soll = 40 (unveraendert)', approxEq(s.soll, 40), 'soll=' + s.soll);
  assert('Ueber = -16', approxEq(s.ueber, -16), 'ueber=' + s.ueber);

  // ===== S4: Urlaub Montag + genehmigen =====
  console.log('\nS4 — Urlaub Montag genehmigt (Soll Mo → 0):');
  const url = await api('POST', '/api/absences', { type: 'urlaub', date_from: D[0], date_to: D[0], target_user_id: uid });
  const urlId = url.data.absence.id;
  await api('POST', '/api/absences/' + urlId + '/approve');
  s = await weekStat(uid, MON);
  assert('Soll = 32 (Mo Urlaub 0, Di–Fr 8 = 32)', approxEq(s.soll, 32), 'soll=' + s.soll);
  assert('Ist = 24 (Mo-Eintrag bleibt geloescht)', approxEq(s.ist, 24), 'ist=' + s.ist);
  assert('Ueber = -8', approxEq(s.ueber, -8), 'ueber=' + s.ueber);

  // ===== Zusatz A: Ueberlappende Eintraege werden nicht doppelt gezaehlt =====
  console.log('\nZusatz A — Ueberlappende Eintraege (eigene, separate Woche):');
  let base2 = addDays(new Date(), 140); while (base2.getDay() !== 1) base2 = addDays(base2, 1);
  const MON2 = fmt(base2), TUE2 = fmt(addDays(base2, 1));
  // Zwei ueberlappende Eintraege am Di2: 07:00-12:00 (5h) und 11:00-15:00 (4h) → merged 8h
  await api('POST', '/api/entries', { date: TUE2, time_from: '07:00', time_to: '12:00', break_minutes: 0, user_id: uid });
  await api('POST', '/api/entries', { date: TUE2, time_from: '11:00', time_to: '15:00', break_minutes: 0, user_id: uid });
  const s2 = await weekStat(uid, MON2);
  assert('Ueberlappung: Ist = 8 (nicht 9)', approxEq(s2.ist, 8), 'ist=' + s2.ist);

  // ===== Zusatz B: Feiertag setzt Soll auf 0 =====
  console.log('\nZusatz B — Feiertag (global) setzt Soll auf 0:');
  let base3 = addDays(new Date(), 210); while (base3.getDay() !== 1) base3 = addDays(base3, 1);
  const MON3 = fmt(base3), WED3 = fmt(addDays(base3, 2));
  const sB0 = await weekStat(uid, MON3);
  const feier = await api('POST', '/api/absences', { type: 'feiertag', date_from: WED3, date_to: WED3 });
  const feierId = feier.data.absence.id;
  const sB1 = await weekStat(uid, MON3);
  assert('Feiertag senkt Soll um 8 (Mi)', approxEq(sB1.soll, sB0.soll - 8), `vorher=${sB0.soll} nachher=${sB1.soll}`);
  // Feiertag loeschen → Soll zurueck
  await api('DELETE', '/api/absences/' + feierId, { reason: 'Test-Aufraeumen' });
  const sB2 = await weekStat(uid, MON3);
  assert('Feiertag geloescht → Soll wieder normal', approxEq(sB2.soll, sB0.soll), `erwartet=${sB0.soll} ist=${sB2.soll}`);

  // ===== Zusatz C: Restore eines geloeschten Eintrags stellt Ist wieder her =====
  console.log('\nZusatz C — Restore des Montags-Eintrags stellt Ist wieder her:');
  await api('POST', '/api/entries/' + monEntryId + '/restore', { reason: 'doch gueltig' });
  const sC = await weekStat(uid, MON);
  // Mo: Urlaub (Soll 0) + wiederhergestellter Eintrag (8h Ist). Ist = 24+8 = 32. Soll bleibt 32.
  assert('Ist nach Restore = 32', approxEq(sC.ist, 32), 'ist=' + sC.ist);
  assert('Soll bleibt 32 (Urlaub Mo weiterhin 0)', approxEq(sC.soll, 32), 'soll=' + sC.soll);
  assert('Ueber = 0', approxEq(sC.ueber, 0), 'ueber=' + sC.ueber);

  console.log('\n========================================');
  console.log(`ERGEBNIS: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) console.log('Fehlgeschlagen: ' + fails.join(' | '));
  console.log('========================================');

  // Aufraeumen: Test-User loeschen
  await api('DELETE', '/api/users/' + uid);
  process.exit(fail ? 1 : 0);
})();
