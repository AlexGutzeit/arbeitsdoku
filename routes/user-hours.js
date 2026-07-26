// Gemeinsame Berechnung der Stunden-Kennzahlen eines Mitarbeiters für einen Zeitraum.
//
// EINE Quelle der Wahrheit für Statistik-Bildschirm, Arbeitsnachweis-PDF und Lohn-Export —
// nach demselben Gedanken wie absence-days.js, das dasselbe für die Abwesenheitstage tut.
//
// Vorher stand dieses Rezept ZWEIMAL im Code (statistics.js und pdf.js) und war bereits leicht
// auseinandergelaufen: pdf.js nahm die Ist-Stunden aus einer Liste, die bei gesetztem
// Projektfilter vorgefiltert war — die Ist-Stunden schrumpften dann, die Soll-Stunden nicht,
// und der Saldo stimmte nicht mehr. Hier werden die Einträge daher IMMER frisch geholt.
//
// Die eigentliche Rechenarbeit machen weiterhin die Bausteine aus statistics.js; dieses Modul
// setzt sie nur in der einen richtigen Reihenfolge zusammen.

// Verzoegertes require, KEIN require am Modulkopf: statistics.js laedt seinerseits dieses Modul.
// Beim Laden waeren die Bausteine dort noch nicht zugewiesen (sie stehen am Dateiende) — wir
// bekaemen `undefined` und der Fehler faende sich erst beim ersten Aufruf. Zur Aufrufzeit ist
// das Modul vollstaendig geladen und im require-Zwischenspeicher.
function bausteine() { return require('./statistics'); }

const runde2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const SPALTEN = 'date, time_from, time_to, break_minutes, net_hours, user_id';

function eintraege(db, userId, from, to) {
  return db.prepare(
    `SELECT ${SPALTEN} FROM entries WHERE user_id = ? AND date >= ? AND date <= ? AND deleted_at IS NULL ORDER BY date`
  ).all(userId, from, to);
}

/**
 * Stunden-Kennzahlen eines Mitarbeiters für [from, to].
 *
 * @param {number} startUeberstunden  users.start_overtime; wird nur durchgereicht, damit der
 *   Aufrufer den Nutzer nicht doppelt laden muss. Weglassen → aus der Datenbank gelesen.
 * @returns {{
 *   angestelltAb: string|null,   // frühestes Soll-Stunden-Datum (null = nie Soll gepflegt)
 *   vonEffektiv: string,         // from, angehoben auf den Anstellungsbeginn
 *   ausserhalb: boolean,         // Zeitraum liegt komplett vor der Anstellung → alles 0
 *   istStunden: number,
 *   sollStunden: number,
 *   saldo: number,               // istStunden - sollStunden (nur dieser Zeitraum)
 *   startUeberstunden: number,
 *   ueberstundenGesamt: number,  // Anfangsbestand + alles seit dem allerersten Tag bis `to`
 * }}
 */
function stundenFuerZeitraum(db, userId, from, to, startUeberstunden) {
  const { calcTargetHours, calcActualHours, getEarliestTargetDate, clampFrom } = bausteine();
  let startOT = startUeberstunden;
  if (startOT === undefined || startOT === null) {
    const u = db.prepare('SELECT start_overtime FROM users WHERE id = ?').get(userId);
    startOT = (u && u.start_overtime) || 0;
  }
  startOT = Number(startOT) || 0;

  const angestelltAb = getEarliestTargetDate(db, userId);
  const vonEffektiv = clampFrom(from, angestelltAb);

  // Liegt der gesamte Zeitraum vor der Anstellung/Soll-Pflege? → alles 0, aber der
  // Anfangsbestand an Überstunden bleibt bestehen.
  if (vonEffektiv > to) {
    return {
      angestelltAb, vonEffektiv, ausserhalb: true,
      istStunden: 0, sollStunden: 0, saldo: 0,
      startUeberstunden: startOT, ueberstundenGesamt: runde2(startOT),
    };
  }

  const istStunden = calcActualHours(eintraege(db, userId, vonEffektiv, to));
  const sollStunden = calcTargetHours(db, userId, vonEffektiv, to);

  // Kumulierte Überstunden: vom allerersten Tag bis zum Ende des gewählten Zeitraums.
  let ueberstundenGesamt = startOT;
  if (angestelltAb) {
    ueberstundenGesamt = startOT
      + calcActualHours(eintraege(db, userId, angestelltAb, to))
      - calcTargetHours(db, userId, angestelltAb, to);
  }

  return {
    angestelltAb, vonEffektiv, ausserhalb: false,
    istStunden, sollStunden, saldo: istStunden - sollStunden,
    startUeberstunden: startOT, ueberstundenGesamt: runde2(ueberstundenGesamt),
  };
}

module.exports = { stundenFuerZeitraum };
