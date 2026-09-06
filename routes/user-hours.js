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

// abschluss.js bindet bewusst keine Routen ein — hier ist ein normales require gefahrlos.
const { letzterAbschlussBis, snapshotZeile, tagDanach, korrekturenSumme } = require('../abschluss');
const { auszahlungenSumme } = require('../auszahlung');

/**
 * Kumulierte Ist- und Soll-Stunden vom Anstellungsbeginn bis `to` — UNGERUNDET.
 *
 * Warum ungerundet: calcActualHours/calcTargetHours runden am Ende ihres Zeitraums, und Rundung
 * ist nicht additiv (round(a)+round(b) ≠ round(a+b)). Der Abschluss teilt den Zeitraum aber genau
 * am Stichtag. Mit den gerundeten Werten wanderte pro Abschluss bis zu ein Hundertstel in den
 * Überstundenstand — gemessen, nicht vermutet: tests/abschluss-gleichheit.js zeigte 0,01 h, bevor
 * es diese Funktion gab. Mit den Rohwerten ist die Teilung exakt, und erst die Summe wird
 * gerundet — also genau die Zahl, die vor dem Abschluss auch herauskam.
 *
 * Ist ein Zeitraum abgeschlossen, wird auf dessen festgehaltenen Rohwerten aufgesetzt statt neu
 * gerechnet. Das ist der eigentliche Zweck: Eine nachträgliche Korrektur in einem bezahlten Monat
 * kann den heutigen Stand nicht mehr verschieben.
 *
 * Rückfall auf die volle Rechnung auch dann, wenn es zwar einen Abschluss gibt, der Mitarbeiter
 * darin aber fehlt — er kann später eingetreten sein. Ohne diesen Zweig bekäme ein Neuzugang
 * stillschweigend 0 statt seiner eigenen Zahlen.
 */
function kumulierteRohwerte(db, userId, angestelltAb, to) {
  const { calcActualHoursRaw, calcTargetHoursRaw } = bausteine();
  let basisIst = 0, basisSoll = 0, ab = angestelltAb;
  const c = letzterAbschlussBis(db, to);
  if (c && c.period_to >= angestelltAb) {
    const zeile = snapshotZeile(db, c.id, userId);
    if (zeile) {
      basisIst = Number(zeile.ist_kumuliert) || 0;
      basisSoll = Number(zeile.soll_kumuliert) || 0;
      ab = tagDanach(c.period_to);
    }
  }
  return {
    istRoh: basisIst + calcActualHoursRaw(eintraege(db, userId, ab, to)),
    sollRoh: basisSoll + calcTargetHoursRaw(db, userId, ab, to),
    // Nachtraege, die in einem bereits bezahlten Monat entstanden und bewusst uebernommen wurden.
    // Sie stecken NICHT in istRoh/sollRoh — der festgehaltene Zeitraum bleibt unangetastet.
    korrekturen: korrekturenSumme(db, userId, to),
    // Ausgezahlte Ueberstunden. Stecken wie die Nachtraege NICHT in istRoh/sollRoh: Gearbeitet
    // wurden die Stunden irgendwann, abgegolten werden sie mit Geld — der Zeiteintrag bleibt,
    // wo er ist. Nur BESTAETIGTE zaehlen; eine offene Anfrage bewegt keine Zahl.
    auszahlungen: auszahlungenSumme(db, userId, to),
  };
}

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
  //
  // Ist ein Monat abgerechnet, wird nicht mehr seit Firmenbeginn gerechnet, sondern auf dem
  // festgehaltenen Stand aufgesetzt. Das ist der eigentliche Zweck des Abschlusses: Eine
  // nachträgliche Korrektur in einem bezahlten Monat darf den heutigen Stand NICHT still
  // verschieben. Sie wird stattdessen als Abweichung ausgewiesen (routes/closure.js).
  //
  // Nebenbei fällt damit die teuerste Abfrage der App weg — bisher lief sie bei jedem Aufruf
  // über die gesamte Firmengeschichte (Bugliste v6, B11 „Wachstum").
  let ueberstundenGesamt = startOT;
  if (angestelltAb) {
    // runde2 auf jeden Summanden EINZELN — genau wie calcActualHours/calcTargetHours es taten,
    // als hier noch über den gesamten Zeitraum am Stück gerechnet wurde. Nur so kommt bei
    // abgeschlossenen und nicht abgeschlossenen Zeiträumen dieselbe Zahl heraus.
    const kum = kumulierteRohwerte(db, userId, angestelltAb, to);
    ueberstundenGesamt = startOT + runde2(kum.istRoh) - runde2(kum.sollRoh) + kum.korrekturen - kum.auszahlungen;
  }

  return {
    angestelltAb, vonEffektiv, ausserhalb: false,
    istStunden, sollStunden, saldo: istStunden - sollStunden,
    startUeberstunden: startOT, ueberstundenGesamt: runde2(ueberstundenGesamt),
  };
}

module.exports = { stundenFuerZeitraum, kumulierteRohwerte };
