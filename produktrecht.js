// Wer darf das Produktverzeichnis PFLEGEN?
//
// Zwei verschiedene Fragen, die man leicht verwechselt:
//
//   ANLEGEN darf JEDER Mitarbeiter — wer im Lager vor einem unbekannten Barcode steht und nichts
//   tun kann, umgeht die App. Das steht in routes/products.js und braucht kein Recht.
//
//   PFLEGEN — umbenennen, Kategorie wechseln, Barcodes entfernen oder umhängen, Produkte
//   zusammenführen und löschen — greift in Einträge ein, die alle anderen benutzen. Dafür gibt es
//   dieses Recht.
//
// Bis hierher hing das allein an der Rolle (Chef und Admin). Alex (08.09.2026): Auch ein
// Mitarbeiter soll es bekommen können — derselbe Gedanke wie beim Bestellrecht, wo Urlaub und
// Krankheit sonst die ganze Firma ausbremsen.
//
// DIESE DATEI IST DER GRUND, WARUM ES SIE GIBT: Beim Bestellrecht stand dieselbe Regel an FÜNF
// Stellen, drei davon falsch (siehe bestellrecht.js). Eine hingeschriebene Bedingung
// `role IN ('chef','admin')` sieht richtig aus und übersieht das Einzelrecht still — niemand
// merkt es, weil nichts kaputtgeht; es geht nur nicht.
//
// ACHTUNG bei den Rollen: Der BUCHHALTER ist hier NICHT dabei. Beim Bestellen zählt er mit, weil
// er die Rechnungen bekommt — mit dem Lagerverzeichnis hat er nichts zu tun. Wer ihn trotzdem
// braucht, bekommt das Häkchen wie jeder andere.
//
// Diese Datei gehört in die feste Dateiliste von deploy.sh (STAMMDATEIEN). Fehlt sie auf dem
// Server, startet der Dienst nach dem Neustart gar nicht mehr.

const ROLLEN_MIT_PRODUKTRECHT = ['admin', 'chef'];

/** user: { role, can_products } — genau das, was middleware/auth.js an jede Anfrage hängt. */
function darfProduktePflegen(user) {
  if (!user) return false;
  if (ROLLEN_MIT_PRODUKTRECHT.includes(user.role)) return true;
  return Number(user.can_products) === 1;
}

// DIESELBE Regel als SQL — für den Fall, dass die LISTE der Berechtigten gebraucht wird.
// Aus der Rollenliste gebaut und nicht hingeschrieben, damit beides nicht auseinanderläuft.
const SQL_PRODUKTBERECHTIGT =
  `(role IN (${ROLLEN_MIT_PRODUKTRECHT.map(() => '?').join(', ')}) OR can_products = 1)`;
const SQL_PRODUKTROLLEN = ROLLEN_MIT_PRODUKTRECHT.slice();

module.exports = { ROLLEN_MIT_PRODUKTRECHT, darfProduktePflegen,
                   SQL_PRODUKTBERECHTIGT, SQL_PRODUKTROLLEN };
