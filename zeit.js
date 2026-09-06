// Gemeinsame Uhrzeit-Prüfung (Format HH:MM, 00:00 bis 23:59).
//
// Dasselbe Regex lag dreimal im Code (Zeiteinträge, Push-Zusammenfassungen, Planungs-Erinnerungen);
// mit dem Arbeitsbeginn wäre es die vierte Kopie geworden — deshalb hier an einer Stelle.
//
// ACHTUNG bei neuen Dateien im Projektstamm: deploy.sh überträgt eine FESTE Dateiliste. Wer hier
// etwas anlegt und dort nicht einträgt, legt den Dienst beim nächsten Neustart lahm.
// tests/deploy-vollstaendigkeit.js fängt genau das ab.

const ZEIT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function istUhrzeit(s) {
  return typeof s === 'string' && ZEIT_RE.test(s);
}

/**
 * Datum und Zeitstempel in DEUTSCHER Ortszeit — die einzige Quelle dafür im Projekt.
 *
 * Warum das hier steht: Dieselben zwei Zeilen lagen dreifach herum (audit.js, ausstellen.js,
 * routes/payouts.js), und daneben rechneten einzelne Stellen mit `toISOString()`, also UTC.
 * Im Sommer sind das zwei Stunden Unterschied: Zwischen Mitternacht und zwei Uhr liefert die
 * UTC-Rechnung noch den VORTAG. Am 1. Januar früh wäre das das falsche Jahr.
 *
 * `toLocaleDateString('sv-SE')` OHNE Zeitzonenangabe ist ebenfalls eine Falle: Es nimmt die
 * Zeitzone des Prozesses. Auf dem Produktivserver ist das Europe/Berlin und damit richtig — auf
 * einem Server, der wie üblich auf UTC steht, wäre es lautlos falsch. server.js setzt `TZ`
 * deshalb vorsorglich, und diese Funktionen sagen es zusätzlich ausdrücklich.
 *
 * NICHT anzufassen: `strftime('now')` in SQL. Das ist überall UTC und wird auch überall gegen
 * UTC-Felder verglichen. Gemischt wird nur dort gefährlich, wo VERGLICHEN wird — dafür gibt es
 * getSeenAtBerlin() in routes/badges.js.
 */
const ZONE = 'Europe/Berlin';

/** 'JJJJ-MM-TT' in deutscher Ortszeit. */
function berlinHeute(d) {
  return (d || new Date()).toLocaleString('sv-SE', { timeZone: ZONE }).slice(0, 10);
}

/** 'JJJJ-MM-TT HH:MM:SS' in deutscher Ortszeit. */
function berlinJetzt(d) {
  return (d || new Date()).toLocaleString('sv-SE', { timeZone: ZONE }).replace('T', ' ');
}

/** Wochentag in deutscher Ortszeit: 1 = Montag … 7 = Sonntag. */
function berlinWochentag(d) {
  const kurz = (d || new Date()).toLocaleDateString('en-US', { timeZone: ZONE, weekday: 'short' });
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[kurz];
}

module.exports = { ZEIT_RE, istUhrzeit, ZONE, berlinHeute, berlinJetzt, berlinWochentag };
