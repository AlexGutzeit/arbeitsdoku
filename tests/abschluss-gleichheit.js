// DIE zentrale Probe zum Abrechnungs-Abschluss: Ändert das Abschließen eine angezeigte Zahl?
//
// Der Abschluss stellt die Rechenbasis für den Überstundenstand um — statt seit Firmenbeginn wird
// ab dem letzten Stichtag gerechnet. Rechnerisch soll das dasselbe ergeben. "Soll" ist hier eine
// Behauptung: calcActualHours und calcTargetHours runden am ENDE ihres Zeitraums auf zwei
// Stellen. Wird ein Zeitraum geteilt, wird zweimal gerundet statt einmal — theoretisch bis zu
// einem Hundertstel Abweichung, das sich über viele Abschlüsse aufsummieren könnte.
//
// Dieser Test misst genau das, statt es zu behaupten: Er nimmt vor dem Abschließen ALLE Zahlen
// auf, schließt dann Monat für Monat ab und vergleicht nach jedem Abschluss erneut.
//
// Der Test prüft ZUERST, dass er überhaupt etwas gemessen hat. Ohne diese Selbstkontrolle wäre
// ein Vergleich zweier leerer Listen grün — genau daran ist der PDF-Vergleich beim Lohn-Export
// schon einmal vorbeigelaufen.
//   node tests/abschluss-gleichheit.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), 'abschluss-gleich-' + Date.now() + '.db');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { initDatabase, getDb } = require('../database/init');
const { stundenFuerZeitraum } = require('../routes/user-hours');
const { monatsBereich, lohnZeilen } = require('../routes/payroll');
const { abschliessen } = require('../routes/closure');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✅ ' + n)) : (fail++, fails.push(n), console.log('  ❌ ' + n + (e ? '  → ' + e : '')));

const JAHR = new Date().getFullYear() - 1;          // sicher vollständig vergangen
const MONATE = ['01', '02', '03', '04', '05', '06'];
const d2 = (n) => String(n).padStart(2, '0');

function seed(db) {
  const nutzer = [];
  // Bewusst unterschiedliche Zuschnitte: Teilzeit mit krummen Tagesstunden erzeugt die
  // Nachkommastellen, bei denen eine Rundungsabweichung überhaupt entstehen kann.
  const profile = [
    { name: 'Vollzeit', tage: [8, 8, 8, 8, 8], ot: 0 },
    { name: 'Teilzeit krumm', tage: [6.5, 6.5, 6.5, 6.5, 3.7], ot: 12.34 },
    { name: 'Mit Startsaldo', tage: [8, 8, 8, 8, 6], ot: -7.5 },
    { name: 'Sehr krumm', tage: [7.4, 5.3, 8.1, 6.7, 4.9], ot: 3.33 },
  ];
  for (const p of profile) {
    const r = db.prepare(
      "INSERT INTO users (username, password_hash, name, role, target_hours_per_week, start_overtime, personnel_no) VALUES (?, 'x', ?, 'mitarbeiter', ?, ?, ?)"
    ).run(p.name.replace(/\s/g, '_').toLowerCase(), p.name, p.tage.reduce((a, b) => a + b, 0), p.ot, 'P' + nutzer.length);
    const uid = r.lastInsertRowid;
    db.prepare(
      'INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uid, p.tage.reduce((a, b) => a + b, 0), ...p.tage, `${JAHR}-01-01`);
    db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(uid, `${JAHR}-01-01`);
    nutzer.push({ id: uid, name: p.name });
  }

  // Zeiteinträge: krumme Minuten, damit netMin/60 nicht glatt aufgeht (z. B. 07:00–15:37).
  const ins = db.prepare(
    'INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours) VALUES (?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  for (const u of nutzer) {
    for (const m of MONATE) {
      for (let tag = 1; tag <= 28; tag++) {
        const datum = `${JAHR}-${m}-${d2(tag)}`;
        const wt = new Date(datum + 'T12:00:00Z').getUTCDay();
        if (wt === 0 || wt === 6) continue;
        const bis = 15 * 60 + ((tag * 7 + u.id * 13) % 59);       // krumme Endzeit
        const pause = 30 + (tag % 3) * 5;
        const netMin = Math.max(0, bis - 7 * 60 - pause);
        ins.run(u.id, datum, '07:00', `${d2(Math.floor(bis / 60))}:${d2(bis % 60)}`, pause, netMin / 60);
        n++;
      }
    }
  }

  // Abwesenheiten quer über die Monate — Krank rechnet gegen die Ist-Stunden (Variante C) und ist
  // damit der empfindlichste Fall für eine Zeitraum-Teilung.
  const insA = db.prepare(
    "INSERT INTO absences (user_id, type, date_from, date_to, status, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insA.run(nutzer[0].id, 'krank', `${JAHR}-02-10`, `${JAHR}-02-14`, 'active', nutzer[0].id);
  insA.run(nutzer[1].id, 'urlaub', `${JAHR}-03-02`, `${JAHR}-03-06`, 'approved', nutzer[1].id);
  insA.run(nutzer[2].id, 'krank', `${JAHR}-04-20`, `${JAHR}-04-24`, 'active', nutzer[2].id);
  insA.run(nutzer[3].id, 'freizeitausgleich', `${JAHR}-05-11`, `${JAHR}-05-12`, 'approved', nutzer[3].id);
  // Krank GENAU ueber eine Monatsgrenze — der Fall, an dem eine Teilung am ehesten bricht.
  insA.run(nutzer[0].id, 'krank', `${JAHR}-03-30`, `${JAHR}-04-03`, 'active', nutzer[0].id);
  insA.run(null, 'feiertag', `${JAHR}-05-01`, `${JAHR}-05-01`, 'active', nutzer[0].id);

  return { nutzer, eintraege: n };
}

// Alle Zahlen, die ein Nutzer irgendwo angezeigt bekommt — je Nutzer über viele Zeiträume.
function alleZahlen(db, nutzer) {
  const werte = [];
  const zeitraeume = [];
  for (const m of MONATE) {
    const b = monatsBereich(`${JAHR}-${m}`);
    zeitraeume.push([b.von, b.bis]);                     // Monatssicht
    zeitraeume.push([`${JAHR}-01-01`, b.bis]);           // „seit Jahresbeginn"
    zeitraeume.push([`${JAHR}-${m}-08`, b.bis]);         // krummer Ausschnitt
  }
  zeitraeume.push([`${JAHR}-01-01`, `${JAHR}-12-31`]);   // Gesamtjahr
  for (const u of nutzer) {
    for (const [von, bis] of zeitraeume) {
      const h = stundenFuerZeitraum(db, u.id, von, bis);
      for (const feld of ['istStunden', 'sollStunden', 'saldo', 'ueberstundenGesamt']) {
        werte.push({ schluessel: `${u.name} ${von}..${bis} ${feld}`, wert: h[feld] });
      }
    }
  }
  // Zusaetzlich die Lohn-Export-Zeilen: das ist, was das Buero tatsaechlich bekommt.
  for (const m of MONATE) {
    const b = monatsBereich(`${JAHR}-${m}`);
    for (const z of lohnZeilen(db, b.von, b.bis, b.titel)) {
      for (const feld of ['soll', 'ist', 'saldo', 'ueberstundenGesamt', 'urlaub', 'krank', 'fza', 'feiertage']) {
        werte.push({ schluessel: `CSV ${z.name} ${b.titel} ${feld}`, wert: z[feld] });
      }
    }
  }
  return werte;
}

function vergleiche(vorher, nachher, titel) {
  const nachMap = new Map(nachher.map(w => [w.schluessel, w.wert]));
  let geprueft = 0, maxAbw = 0, schlimmster = '';
  const abweichungen = [];
  for (const v of vorher) {
    if (!nachMap.has(v.schluessel)) { abweichungen.push(`${v.schluessel}: fehlt danach`); continue; }
    geprueft++;
    const a = Number(v.wert) || 0, b = Number(nachMap.get(v.schluessel)) || 0;
    const diff = Math.abs(b - a);
    if (diff > maxAbw) { maxAbw = diff; schlimmster = `${v.schluessel}: ${a} → ${b}`; }
    if (diff > 0) abweichungen.push(`${v.schluessel}: ${a} → ${b}`);
  }
  ok(`${titel}: es wurde überhaupt etwas verglichen (${geprueft} Zahlen)`, geprueft > 100, String(geprueft));
  ok(`${titel}: keine einzige Zahl verändert`, abweichungen.length === 0,
    abweichungen.slice(0, 5).join(' | ') + (abweichungen.length > 5 ? ` … (${abweichungen.length} gesamt)` : ''));
  return { geprueft, maxAbw, schlimmster };
}

(async () => {
  await initDatabase();
  const db = getDb();
  const { nutzer, eintraege } = seed(db);
  ok('Testdaten angelegt', nutzer.length === 4 && eintraege > 400, `${nutzer.length} Nutzer, ${eintraege} Einträge`);

  const admin = { id: 1, username: 'admin', name: 'Admin' };

  const vorher = alleZahlen(db, nutzer);
  ok('Ausgangsmessung enthält Werte', vorher.length > 300, String(vorher.length));
  ok('Ausgangsmessung ist nicht durchweg 0', vorher.some(w => Number(w.wert) !== 0),
    'alle Werte 0 — dann würde der Vergleich nichts aussagen');

  // Gegenprobe, dass die Messung überhaupt empfindlich ist: Ein zusätzlicher Eintrag MUSS die
  // Zahlen bewegen. Täte er das nicht, wäre der gesamte Vergleich unten wertlos.
  db.prepare('INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nutzer[0].id, `${JAHR}-06-15`, '18:00', '20:00', 0, 2);
  const gestoert = alleZahlen(db, nutzer);
  const bewegt = gestoert.filter((w, i) => Number(w.wert) !== Number(vorher[i].wert)).length;
  ok('Gegenprobe: die Messung reagiert auf eine echte Änderung', bewegt > 0, `${bewegt} Werte bewegt`);
  db.prepare('DELETE FROM entries WHERE user_id = ? AND date = ? AND time_from = ?')
    .run(nutzer[0].id, `${JAHR}-06-15`, '18:00');
  ok('Störung wieder entfernt', JSON.stringify(alleZahlen(db, nutzer)) === JSON.stringify(vorher));

  // Monat für Monat abschließen und nach JEDEM Abschluss erneut alles messen.
  let maxAbwGesamt = 0, schlimmster = '', geprueftGesamt = 0;
  for (const m of MONATE) {
    const b = monatsBereich(`${JAHR}-${m}`);
    const { zeilen } = abschliessen(db, b, admin);
    ok(`${b.titel} abgeschlossen (${zeilen.length} Zeilen)`, zeilen.length === nutzer.length, String(zeilen.length));
    const r = vergleiche(vorher, alleZahlen(db, nutzer), `nach Abschluss ${b.titel}`);
    geprueftGesamt += r.geprueft;
    if (r.maxAbw > maxAbwGesamt) { maxAbwGesamt = r.maxAbw; schlimmster = r.schlimmster; }
  }

  console.log(`\n  Insgesamt ${geprueftGesamt} Zahlen über ${MONATE.length} Abschlüsse verglichen.`);
  console.log(`  Größte gemessene Abweichung: ${maxAbwGesamt}` + (schlimmster ? `  (${schlimmster})` : ''));
  ok('auch nach 6 aufeinanderfolgenden Abschlüssen keine Abweichung', maxAbwGesamt === 0, String(maxAbwGesamt));

  // Und die Kernaussage des Abschlusses: eine nachträgliche Korrektur im bezahlten Zeitraum darf
  // den heutigen Stand NICHT mehr verschieben.
  const standVor = stundenFuerZeitraum(db, nutzer[0].id, `${JAHR}-01-01`, `${JAHR}-12-31`).ueberstundenGesamt;
  db.prepare('INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nutzer[0].id, `${JAHR}-02-11`, '18:00', '22:00', 0, 4);
  const standNach = stundenFuerZeitraum(db, nutzer[0].id, `${JAHR}-01-01`, `${JAHR}-12-31`).ueberstundenGesamt;
  ok('nachträgliche Korrektur im abgerechneten Monat verschiebt den Gesamtstand NICHT',
    standVor === standNach, `${standVor} → ${standNach}`);

  console.log(`\nAbschluss-Gleichheit: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
