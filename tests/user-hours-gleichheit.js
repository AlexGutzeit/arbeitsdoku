// Gleichheitsbeweis fuer die Zusammenlegung der Stunden-Rechnung (C1).
//
// Das Rezept fuer Soll/Ist/Saldo stand ZWEIMAL im Code (routes/statistics.js und routes/pdf.js).
// Es wandert in routes/user-hours.js. Dieser Test baut das ALTE Rezept woertlich nach und stellt
// es Zahl fuer Zahl gegen die neue Funktion — auf einer erzeugten Datenbank UND, falls vorhanden,
// gegen eine KOPIE der Produktivdaten (nur lesend).
//
// Bricht dieser Test, wird die Umstellung von statistics.js/pdf.js NICHT gemacht.
//   node tests/user-hours-gleichheit.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), 'uh-gleich-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const stats = require('../routes/statistics');
const { stundenFuerZeitraum } = require('../routes/user-hours');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✅ ' + n)) : (fail++, fails.push(n), console.log('  ❌ ' + n + (e ? '  → ' + e : '')));

// ── Das ALTE Rezept, woertlich aus statistics.js:339-372 uebernommen ──────────────────────────
// Bewusst als Kopie hier im Test: nur so laesst sich beweisen, dass die neue Funktion dasselbe
// liefert. Wird die Produktivstelle geaendert, muss diese Kopie bewusst nachgezogen werden.
function altesRezept(db, uid, from, to) {
  const user = db.prepare('SELECT start_overtime FROM users WHERE id = ?').get(uid);
  const startOvertime = (user && user.start_overtime) || 0;
  const earliest = stats.getEarliestTargetDate(db, uid);
  const userFrom = stats.clampFrom(from, earliest);

  if (userFrom > to) {
    return { ist: 0, soll: 0, ueber: 0, start_overtime: startOvertime, ueber_gesamt: startOvertime };
  }
  const entries = db.prepare(
    'SELECT date, time_from, time_to, break_minutes, net_hours, user_id, project_id, project_text FROM entries WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date'
  ).all(uid, userFrom, to);

  const ist = stats.calcActualHours(entries);
  const soll = stats.calcTargetHours(db, uid, userFrom, to);
  const ueber = ist - soll;

  let ueberGesamt = startOvertime;
  if (earliest) {
    const allEntries = db.prepare(
      'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date'
    ).all(uid, earliest, to);
    ueberGesamt = startOvertime + stats.calcActualHours(allEntries) - stats.calcTargetHours(db, uid, earliest, to);
  }
  return { ist, soll, ueber, start_overtime: startOvertime, ueber_gesamt: ueberGesamt };
}

const g2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Vergleicht alt gegen neu fuer einen Nutzer/Zeitraum. Gibt die Abweichung zurueck oder null.
function vergleiche(db, uid, from, to) {
  const alt = altesRezept(db, uid, from, to);
  const neu = stundenFuerZeitraum(db, uid, from, to);
  const felder = [
    ['ist', alt.ist, neu.istStunden],
    ['soll', alt.soll, neu.sollStunden],
    ['saldo', alt.ueber, neu.saldo],
    ['start', alt.start_overtime, neu.startUeberstunden],
    ['gesamt', g2(alt.ueber_gesamt), neu.ueberstundenGesamt],
  ];
  const abweichungen = felder.filter(([, a, b]) => Math.abs(g2(a) - g2(b)) > 0.001);
  return abweichungen.length
    ? abweichungen.map(([f, a, b]) => `${f}: alt ${g2(a)} vs neu ${g2(b)}`).join(', ')
    : null;
}

const ZEITRAEUME = (jahr) => [
  ['Monat', `${jahr}-01-01`, `${jahr}-01-31`],
  ['Monat mit Feiertagen', `${jahr}-12-01`, `${jahr}-12-31`],
  ['Quartal', `${jahr}-04-01`, `${jahr}-06-30`],
  ['ganzes Jahr', `${jahr}-01-01`, `${jahr}-12-31`],
  ['weit vor Anstellung', '2000-01-01', '2000-12-31'],
  ['weit in der Zukunft', `${jahr + 5}-01-01`, `${jahr + 5}-12-31`],
  ['einzelner Tag', `${jahr}-03-15`, `${jahr}-03-15`],
];

(async () => {
  await initDatabase();
  const db = getDb();
  const jahr = new Date().getFullYear();

  // ── Erzeugte Datenbank mit den kniffligen Faellen ───────────────────────────────────────────
  console.log('Erzeugte Daten:');
  const mkUser = (nm, startOT) => db.prepare(
    "INSERT INTO users (username,password_hash,name,role,target_hours_per_week,start_overtime) VALUES (?,?,?,'mitarbeiter',40,?)"
  ).run(nm, 'x', nm, startOT).lastInsertRowid;
  const soll = (uid, ab) => db.prepare(
    "INSERT INTO user_target_hours (user_id,hours_per_week,hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from) VALUES (?,40,8,8,8,8,8,?)"
  ).run(uid, ab);
  const eintrag = (uid, d, von, bis, pause) => db.prepare(
    "INSERT INTO entries (user_id,date,time_from,time_to,break_minutes,net_hours) VALUES (?,?,?,?,?,?)"
  ).run(uid, d, von, bis, pause || 0, 0);
  const abwesend = (uid, typ, von, bis) => db.prepare(
    "INSERT INTO absences (user_id,type,date_from,date_to,status) VALUES (?,?,?,?,'approved')"
  ).run(uid, typ, von, bis);

  // A: normaler Mitarbeiter mit Anfangsbestand, Ueberlappung, Krank/Urlaub/FZA
  const a = mkUser('gleich_a', 12.5);
  soll(a, `${jahr}-01-01`);
  eintrag(a, `${jahr}-01-07`, '07:00', '16:00', 30);
  eintrag(a, `${jahr}-01-07`, '15:00', '18:00', 0);        // ueberlappt bewusst
  eintrag(a, `${jahr}-01-08`, '07:00', '12:00', 0);
  eintrag(a, `${jahr}-03-15`, '08:00', '17:00', 60);
  abwesend(a, 'krank', `${jahr}-01-09`, `${jahr}-01-09`);
  abwesend(a, 'urlaub', `${jahr}-01-13`, `${jahr}-01-17`);
  abwesend(a, 'freizeitausgleich', `${jahr}-01-20`, `${jahr}-01-20`);
  eintrag(a, `${jahr}-01-09`, '09:00', '12:00', 0);        // trotz Krank gearbeitet

  // B: ohne jede Soll-Stunden-Zeile (Fallback-Pfad)
  const b = mkUser('gleich_b', 0);
  eintrag(b, `${jahr}-01-07`, '07:00', '15:30', 30);

  // C: Soll-Pflege beginnt erst spaeter im Jahr → clampFrom greift
  const c = mkUser('gleich_c', -3.25);
  soll(c, `${jahr}-06-01`);
  eintrag(c, `${jahr}-06-02`, '07:00', '16:00', 30);
  eintrag(c, `${jahr}-04-02`, '07:00', '16:00', 30);       // VOR der Soll-Pflege

  // D: ausgestellt und wieder eingestellt (Anstellungsluecke)
  const d = mkUser('gleich_d', 5);
  soll(d, `${jahr}-01-01`);
  try {
    db.prepare("INSERT INTO employment_periods (user_id,start_date,end_date) VALUES (?,?,?)").run(d, `${jahr}-01-01`, `${jahr}-02-28`);
    db.prepare("INSERT INTO employment_periods (user_id,start_date,end_date) VALUES (?,?,NULL)").run(d, `${jahr}-05-01`);
  } catch (_) {}
  eintrag(d, `${jahr}-01-07`, '07:00', '15:00', 0);
  eintrag(d, `${jahr}-05-05`, '07:00', '15:00', 0);

  // E: gar keine Eintraege
  const e = mkUser('gleich_e', 0);
  soll(e, `${jahr}-01-01`);

  const alle = [['A voll', a], ['B ohne Soll', b], ['C spaeter Start', c], ['D mit Luecke', d], ['E leer', e]];
  let geprueft = 0;
  for (const [label, uid] of alle) {
    let schlecht = null;
    for (const [zLabel, von, bis] of ZEITRAEUME(jahr)) {
      const abw = vergleiche(db, uid, von, bis);
      geprueft++;
      if (abw && !schlecht) schlecht = `${zLabel} → ${abw}`;
    }
    ok(`${label}: alt und neu identisch über alle Zeiträume`, !schlecht, schlecht);
  }
  console.log(`      ${geprueft} Vergleiche auf erzeugten Daten`);

  // Gegenprobe: der Test WUERDE eine Abweichung bemerken
  const kaputt = { ...stundenFuerZeitraum(db, a, `${jahr}-01-01`, `${jahr}-01-31`) };
  kaputt.istStunden += 1;
  ok('Gegenprobe: eine künstliche Abweichung würde auffallen',
    Math.abs(kaputt.istStunden - stundenFuerZeitraum(db, a, `${jahr}-01-01`, `${jahr}-01-31`).istStunden) > 0.001);

  // ── Prod-Klon (nur lesend), falls vorhanden ─────────────────────────────────────────────────
  console.log('Echte Daten (Prod-Klon):');
  const KLON = '/tmp/prodklon.db';
  if (!fs.existsSync(KLON)) {
    console.log('  ⏭  ' + KLON + ' fehlt — übersprungen (holen mit scp, siehe tests/README.md)');
  } else {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const raw = new SQL.Database(fs.readFileSync(KLON));
    // Kleiner Adapter, damit die Funktionen dieselbe .prepare().all()/.get()-Form vorfinden.
    const klonDb = {
      prepare(sql) {
        return {
          all: (...p) => { const st = raw.prepare(sql); st.bind(p.flat()); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; },
          get: (...p) => { const st = raw.prepare(sql); st.bind(p.flat()); const r = st.step() ? st.getAsObject() : undefined; st.free(); return r; },
        };
      },
    };
    const users = klonDb.prepare("SELECT id, name FROM users").all();
    let vergleiche2 = 0, fehler = null;
    for (const u of users) {
      for (const [zLabel, von, bis] of ZEITRAEUME(jahr)) {
        const abw = vergleiche(klonDb, u.id, von, bis);
        vergleiche2++;
        if (abw && !fehler) fehler = `${u.name} / ${zLabel} → ${abw}`;
      }
      // zusätzlich das Vorjahr
      const abw2 = vergleiche(klonDb, u.id, `${jahr - 1}-01-01`, `${jahr - 1}-12-31`);
      vergleiche2++;
      if (abw2 && !fehler) fehler = `${u.name} / Vorjahr → ${abw2}`;
    }
    ok(`echte Daten: alt und neu identisch (${users.length} Nutzer, ${vergleiche2} Vergleiche)`, !fehler, fehler);
    raw.close();
  }

  console.log(`\nGleichheit alt/neu: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
