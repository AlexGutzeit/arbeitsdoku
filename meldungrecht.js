// Wer darf bei den Meldungen was? (30.09.2026)
//
// Melden darf JEDER — wer vor dem vollen Papiermüll steht, soll es loswerden können, ohne ein Recht zu
// brauchen. Das steht in routes/meldungen.js und braucht keine Regel.
//
// Zwei Fragen dagegen gehören hierher, weil mehrere Stellen sie stellen (Route, Zähler, Push,
// Zusammenfassung, Oberfläche). Beim Bestellrecht stand eine solche Regel an FÜNF Stellen, drei davon
// falsch (siehe bestellrecht.js) — deshalb steht sie hier EINMAL:
//
//   BEARBEITEN — alle Meldungen ändern, „in Arbeit"/„erledigt" setzen, wieder öffnen, eine Rückmeldung
//   schreiben; dazu Zähler und Push für jede neue oder geänderte Meldung. Chef und Admin per Rolle, alle
//   anderen über das Einzelrecht `can_meldungen` (Alex: gleich mitbauen, z. B. für einen Vorarbeiter).
//
//   VERWALTEN — Themen anlegen, umbenennen, sortieren, löschen und regelmäßige Meldungen einrichten.
//   NUR Chef und Admin, auch mit Einzelrecht nicht (Alex, 30.09.2026).
//
// ACHTUNG bei den Rollen: Der BUCHHALTER ist nicht dabei. Wer ihn braucht, gibt ihm das Häkchen.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet). Fehlt sie
// auf dem Server, startet der Dienst nach dem Neustart gar nicht mehr.

const ROLLEN_MIT_MELDUNGSRECHT = ['admin', 'chef'];

/** user: { role, can_meldungen } — genau das, was middleware/auth.js an jede Anfrage hängt. */
function darfMeldungenBearbeiten(user) {
  if (!user) return false;
  if (ROLLEN_MIT_MELDUNGSRECHT.includes(user.role)) return true;
  return Number(user.can_meldungen) === 1;
}

/** Themen und regelmäßige Meldungen: nur per Rolle. */
function darfMeldungenVerwalten(user) {
  return !!user && ROLLEN_MIT_MELDUNGSRECHT.includes(user.role);
}

// DIESELBE Regel als SQL — für die LISTE der Berechtigten (Push-Empfänger). Aus der Rollenliste gebaut
// und nicht hingeschrieben, damit beides nicht auseinanderläuft.
const SQL_MELDUNGSBERECHTIGT =
  `(role IN (${ROLLEN_MIT_MELDUNGSRECHT.map(() => '?').join(', ')}) OR can_meldungen = 1)`;
const SQL_MELDUNGSROLLEN = ROLLEN_MIT_MELDUNGSRECHT.slice();

module.exports = { ROLLEN_MIT_MELDUNGSRECHT, darfMeldungenBearbeiten, darfMeldungenVerwalten,
                   SQL_MELDUNGSBERECHTIGT, SQL_MELDUNGSROLLEN };
