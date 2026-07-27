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

module.exports = { ZEIT_RE, istUhrzeit };
