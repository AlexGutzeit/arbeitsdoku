// Wer darf einen Artikel ins Verzeichnis EINLERNEN?
//
// Gemeint ist der Moment am Regal: Ein unbekannter Barcode wird gescannt. Bisher durfte darauf
// JEDER ein Produkt anlegen — mit der Begründung, wer im Lager nichts eintragen kann, umgeht die
// App. Alex hat das am 13.09.2026 umgedreht: „ich würde da doch gerne eine Berechtigung vergeben
// um die datenhygiene hoch zu halten."
//
// Das ist eine bewusste Abwägung, keine Korrektur eines Fehlers. Der Preis ist bekannt: Wer den
// Karton in der Hand hat und nicht darf, muss jemanden fragen. Dafür entstehen die Einträge nur
// noch dort, wo jemand auf Schreibweise, Kategorie und Doppel achtet — und ein Doppel kostet
// hinterher mehr Zeit als das Fragen.
//
// DREI RECHTE, DIE MAN AUSEINANDERHALTEN MUSS:
//
//   BESTELLEN            (bestellrecht.js)  — Material anfordern. Braucht kein Verzeichnisrecht.
//   EINLERNEN            (diese Datei)      — neue Artikel/Barcodes ins Verzeichnis bringen.
//   LAGERDATEN PFLEGEN   (produktrecht.js)  — umbenennen, zusammenführen, löschen, Großhändler.
//
// Wer PFLEGEN darf, darf auch EINLERNEN. Ohne diese Folgerung entstünde ein Widerspruch: Im
// Produktverzeichnis kann ein Pfleger längst Barcodes anlernen und sogar Produkte ohne Barcode
// anlegen — er dürfte es dann nur nicht am Regal. Umgekehrt gilt es NICHT: Einlernen ist das
// kleinere Recht und zieht keine Änderung an fremden Einträgen nach sich.
//
// ROLLEN: Chef und Admin immer. Der BUCHHALTER ausdrücklich NICHT per Rolle — anders als beim
// Bestellen, wo er die Rechnungen bekommt. Alex: „Buchhalter und MA nur mit Berechtigung."
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (STAMMDATEIEN). Fehlt sie auf dem
// Server, startet der Dienst nach dem Neustart gar nicht mehr.

const { darfProduktePflegen } = require('./produktrecht');

const ROLLEN_MIT_EINLERNRECHT = ['admin', 'chef'];

/** user: { role, can_products_add, can_products_edit } — genau das, was middleware/auth.js anhängt. */
function darfBarcodeEinlernen(user) {
  if (!user) return false;
  if (ROLLEN_MIT_EINLERNRECHT.includes(user.role)) return true;
  if (darfProduktePflegen(user)) return true;   // das grössere Recht schliesst das kleinere ein
  return Number(user.can_products_add) === 1;
}

// DIESELBE Regel als SQL — für den Fall, dass die LISTE der Berechtigten gebraucht wird.
// Aus der Rollenliste gebaut und nicht hingeschrieben, damit beides nicht auseinanderläuft.
// `can_products_edit` steht mit drin, weil die Folgerung oben sonst hier fehlte.
const SQL_EINLERNBERECHTIGT =
  `(role IN (${ROLLEN_MIT_EINLERNRECHT.map(() => '?').join(', ')}) OR can_products_add = 1 OR can_products_edit = 1)`;
const SQL_EINLERNROLLEN = ROLLEN_MIT_EINLERNRECHT.slice();

module.exports = { ROLLEN_MIT_EINLERNRECHT, darfBarcodeEinlernen,
                   SQL_EINLERNBERECHTIGT, SQL_EINLERNROLLEN };
