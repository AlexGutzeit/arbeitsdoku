// Ausgezahlte Überstunden — die Regel an EINER Stelle.
//
// Gebraucht wird sie in der Stundenrechnung (routes/user-hours.js), im Lohn-Export
// (routes/payroll.js), im PDF und in der Statistik. Stünde sie mehrfach im Code, liefe sie
// auseinander, sobald jemand nur eine Stelle anfasst — genau die Falle, die beim Bestellrecht
// dreimal zugeschlagen hat (siehe bestellrecht.js) und die beim Ausstellen dazu geführt hat,
// dass ausstellen.js überhaupt existiert.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (STAMMDATEIEN). Fehlt sie auf dem
// Server, startet der Dienst nach dem Neustart gar nicht mehr.

const OFFEN = 'offen';
const BESTAETIGT = 'bestaetigt';
const ABGELEHNT = 'abgelehnt';
const ZURUECKGEZOGEN = 'zurueckgezogen';
const STATUS = [OFFEN, BESTAETIGT, ABGELEHNT, ZURUECKGEZOGEN];

const BELEG_APP = 'app';
const BELEG_UNTERSCHRIFT = 'unterschrift';

/**
 * Summe der bestätigten Auszahlungen, die auf den Stand bis `bis` wirken.
 *
 * NUR `bestaetigt` zählt. Eine offene Anfrage darf keine Zahl bewegen: Solange der Mitarbeiter
 * nicht zugestimmt hat, sind die Stunden noch da. Sie wird nur ANGEZEIGT (siehe offeneSumme),
 * damit niemand dieselben Stunden zweimal verplant.
 *
 * Das Ergebnis wird ABGEZOGEN:
 *   ueberstundenGesamt = startOT + istRoh − sollRoh + korrekturen − auszahlungen
 *
 * `try/catch` wie bei korrekturenSumme: Beim Wiederherstellen einer Sicherung kann dieses Modul
 * laufen, bevor das Schema durch ist. Ein Absturz hier würde die Wiederherstellung abbrechen —
 * eine 0 ist dann das richtige Verhalten, die Zahl stimmt eine Sekunde später von selbst.
 */
function auszahlungenSumme(db, userId, bis) {
  try {
    const r = db.prepare(
      'SELECT COALESCE(SUM(stunden), 0) AS s FROM overtime_payouts WHERE user_id = ? AND wirksam_ab <= ? AND status = ?'
    ).get(userId, String(bis), BESTAETIGT);
    return (r && Number(r.s)) || 0;
  } catch (_) { return 0; }
}

/**
 * Summe der noch OFFENEN Anfragen. Bewegt keine Zahl — nur zur Anzeige
 * („davon 87,5 h zur Auszahlung angefragt"), damit niemand dieselben Stunden zweimal verplant.
 */
function offeneSumme(db, userId) {
  try {
    const r = db.prepare(
      'SELECT COALESCE(SUM(stunden), 0) AS s FROM overtime_payouts WHERE user_id = ? AND status = ?'
    ).get(userId, OFFEN);
    return (r && Number(r.s)) || 0;
  } catch (_) { return 0; }
}

/** Bestätigte Auszahlungen, die in [von, bis] wirksam werden — für den Ausweis im Lohn-Export. */
function auszahlungenImZeitraum(db, userId, von, bis) {
  try {
    return db.prepare(
      `SELECT id, stunden, wirksam_ab, belegweg, entschieden_am
         FROM overtime_payouts
        WHERE user_id = ? AND status = ? AND wirksam_ab >= ? AND wirksam_ab <= ?
        ORDER BY wirksam_ab`
    ).all(userId, BESTAETIGT, String(von), String(bis));
  } catch (_) { return []; }
}

module.exports = {
  auszahlungenSumme, offeneSumme, auszahlungenImZeitraum,
  OFFEN, BESTAETIGT, ABGELEHNT, ZURUECKGEZOGEN, STATUS,
  BELEG_APP, BELEG_UNTERSCHRIFT,
};
