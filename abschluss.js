// Abrechnungs-Abschluss: Wächter über bereits abgerechnete Zeiträume.
//
// Das Problem, das dieses Modul löst: Der Überstundenstand wird bei JEDER Abfrage vom allerersten
// Tag an neu gerechnet (routes/user-hours.js). Wer heute einen Mai-Eintrag ändert, ändert damit
// seinen HEUTIGEN Stand — und der geht nächsten Monat wieder über den Lohn-Export ans Lohnbüro,
// obwohl die Mai-Stunden längst bezahlt sind. Die App protokolliert das zwar lückenlos, aber
// niemand schaut nach: eine Kontroll-, keine Protokollierungslücke.
//
// Ist ein Monat abgeschlossen, sind seine Zahlen festgehalten (payroll_closure_rows) und alles
// davor ist schreibgeschützt. Der Admin kommt weiterhin durch — aber nur mit Begründung, und der
// Eingriff steht im Audit-Log.
//
// Hier stehen bewusst NUR Datenbank-Abfragen und keine require auf routes/*: entries.js,
// absences.js, statistics.js und users.js binden dieses Modul ein. Ein require in die Gegenrichtung
// ergäbe denselben Zirkelbezug, der schon zwischen user-hours.js und statistics.js entstanden ist.
//
// ACHTUNG bei neuen Dateien im Projektstamm: deploy.sh überträgt eine FESTE Dateiliste. Wer hier
// etwas anlegt und dort nicht einträgt, legt den Dienst beim nächsten Neustart lahm.
// tests/deploy-vollstaendigkeit.js fängt genau das ab.

// Eine Begründung soll eine Begründung sein, kein Tastendruck. Bewusst niedrig gehalten: Die
// Hürde soll zum Nachdenken zwingen, nicht zum Ausweichen auf "xxxxx".
const MIN_GRUND = 3;

const deDatum = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};

// Alle Leser sind gegen eine fehlende Tabelle abgesichert: Beim Hochziehen einer sehr alten
// Sicherung kann dieses Modul laufen, bevor ensureClosureSchema durch ist. Ein Absturz hier
// würde jede Anfrage treffen — "noch nichts abgeschlossen" ist die richtige Antwort.

/** Letzter Stichtag insgesamt ('JJJJ-MM-TT') oder null, wenn noch nie abgeschlossen wurde. */
function abgerechnetBis(db) {
  try {
    const r = db.prepare('SELECT MAX(period_to) AS bis FROM payroll_closures').get();
    return (r && r.bis) || null;
  } catch (_) { return null; }
}

/**
 * Jüngster Abschluss, dessen Zeitraum spätestens am `datum` endet — die Rechenbasis für den
 * Überstunden-Gesamtstand bis zu diesem Tag.
 *
 * Bewusst `<=` und nicht `<`: Fragt jemand den Stand exakt zum Stichtag ab (30.06. bei
 * abgeschlossenem Juni), soll der festgehaltene Juni-Wert kommen — nicht eine Neuberechnung des
 * Juni. Sonst würde eine nachträgliche Korrektur im Juni genau dort doch wieder durchschlagen.
 */
function letzterAbschlussBis(db, datum) {
  try {
    return db.prepare(
      'SELECT * FROM payroll_closures WHERE period_to <= ? ORDER BY period_to DESC LIMIT 1'
    ).get(String(datum)) || null;
  } catch (_) { return null; }
}

/** Tag nach `iso` — Beginn des noch nicht abgerechneten Rests. */
function tagDanach(iso) {
  const d = new Date(String(iso) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Festgehaltene Zahlen eines Mitarbeiters aus einem Abschluss. */
function snapshotZeile(db, closureId, userId) {
  try {
    return db.prepare(
      'SELECT * FROM payroll_closure_rows WHERE closure_id = ? AND user_id = ?'
    ).get(closureId, userId) || null;
  } catch (_) { return null; }
}

function istGesperrt(db, datum) {
  const bis = abgerechnetBis(db);
  return !!(bis && datum && String(datum) <= bis);
}

function darfEingreifen(user, grund) {
  // NICHT über authorize() lösen: dort kommt der Admin grundsätzlich immer durch
  // (middleware/auth.js), die Sperre wäre damit für ihn unsichtbar wirkungslos. Hier wird die
  // Rolle ausdrücklich geprüft UND eine Begründung verlangt.
  return !!(user && user.role === 'admin' && String(grund || '').trim().length >= MIN_GRUND);
}

const HINWEIS = (bis) =>
  `Der Zeitraum ist abgerechnet (bis ${deDatum(bis)}). Änderungen daran sind nur durch den ` +
  `Administrator und nur mit Begründung möglich.`;

/**
 * Prüft eine Schreiboperation gegen den Stichtag.
 *
 * @param {string[]} datumsListe  ALLE betroffenen Daten. Bei einer Änderung gehören das alte UND
 *   das neue Datum hinein — sonst ließe sich ein Eintrag aus dem gesperrten Zeitraum
 *   herausschieben (oder hinein).
 * @returns null            → nichts gesperrt, Route macht normal weiter
 *          {fehler, bis}   → 403 mit `fehler`
 *          {eingriff, bis} → Admin darf, Route muss protokollieren (protokolliereEingriff)
 */
function pruefeSperre(db, datumsListe, user, grund) {
  const bis = abgerechnetBis(db);
  if (!bis) return null;
  const betroffen = (Array.isArray(datumsListe) ? datumsListe : [datumsListe])
    .filter(Boolean).map(String).filter(d => d <= bis);
  if (!betroffen.length) return null;
  if (darfEingreifen(user, grund)) return { eingriff: true, bis, betroffen };
  return { fehler: HINWEIS(bis), bis, betroffen };
}

/**
 * Für Werte OHNE Datum, die über die gesamte Historie wirken — Start-Überstunden,
 * Anfangs-Resturlaub, Wochenstunden im Mitarbeiter-Formular. Die lassen sich nicht teilweise
 * schützen: Sobald irgendein Monat abgeschlossen ist, verschieben sie eine bezahlte Zahl.
 */
function pruefeSperreGlobal(db, user, grund) {
  const bis = abgerechnetBis(db);
  if (!bis) return null;
  if (darfEingreifen(user, grund)) return { eingriff: true, bis, betroffen: [bis] };
  return {
    fehler: `Dieser Wert wirkt rückwirkend auf abgerechnete Zeiträume (bis ${deDatum(bis)}). ` +
            `Eine Änderung ist nur durch den Administrator und nur mit Begründung möglich.`,
    bis, betroffen: [bis],
  };
}

/**
 * Protokolliert einen Admin-Eingriff in einen abgerechneten Zeitraum.
 *
 * Ohne diesen Eintrag wäre der Ausweg eine stille Hintertür — und die Sperre damit wertlos.
 * Aufruf NACH dem erfolgreichen Schreiben; bei `sperre === null` (nichts gesperrt) passiert nichts.
 */
function protokolliereEingriff(db, req, sperre, was) {
  if (!sperre || !sperre.eingriff) return;
  const grund = String((req.body && req.body.reason) || '').trim();
  require('./audit').logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_override',
    details: `${was} im abgerechneten Zeitraum (bis ${deDatum(sperre.bis)}). Grund: ${grund}`,
    ip: req.ip,
  });
}

module.exports = {
  MIN_GRUND, deDatum, abgerechnetBis, letzterAbschlussBis, tagDanach, snapshotZeile,
  istGesperrt, darfEingreifen, pruefeSperre, pruefeSperreGlobal, protokolliereEingriff,
};
