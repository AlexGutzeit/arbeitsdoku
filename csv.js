// Gemeinsame CSV-Bausteine.
//
// Die Konvention war bereits in routes/projects.js und routes/audit.js fast wortgleich dupliziert.
// Mit dem Lohn-Export waere es die dritte Kopie geworden — deshalb hier an einer Stelle.
//
// Konvention (auf Excel abgestimmt):
//   * Semikolon als Trenner (deutsches Excel erwartet das, nicht das Komma)
//   * JEDES Feld in Anfuehrungszeichen, innere Anfuehrungszeichen verdoppelt — damit Semikolon,
//     Zeilenumbrueche und Anfuehrungszeichen im Text die Tabelle nicht zerreissen
//   * CRLF als Zeilenende
//   * UTF-8-BOM am Anfang, sonst zeigt Excel Umlaute falsch an
//   * Zellen, die wie eine Formel beginnen, werden entschaerft — siehe csvZelle

const BOM = '﻿';

// Formeln entschaerfen (Sicherheitspruefung 10.11.2026, P2).
//
// Excel und LibreOffice werten eine Zelle als FORMEL aus, wenn sie mit = + - oder @ beginnt — auch
// in einer CSV-Datei, auch in Anfuehrungszeichen. Freitext aus der App landet hier (Namen,
// Projektnamen, Audit-Details), und der Benutzername einer FEHLANMELDUNG kommt sogar von jemandem,
// der gar nicht angemeldet ist. Wer dort „=HYPERLINK(…)" eintippte, legte dem Admin eine Formel in
// den Export.
//
// Solche Zellen bekommen ein Hochkomma vorangestellt (Empfehlung von OWASP) — die Tabelle zeigt sie
// dann als Text. Tabulator und Wagenruecklauf am Anfang zaehlen mit, ebenso Leerraum vor dem
// Formelzeichen: Manche Programme schneiden ihn beim Einlesen weg.
//
// AUSNAHME reine Zahlen: Ein negativer Saldo („-3,5") beginnt auch mit einem Minus, ist aber keine
// Formel und muss eine Zahl bleiben — das Lohnbuero rechnet damit weiter.
const FORMEL_ANFANG = /^(?:[=+\-@\t\r]|\s+[=+\-@])/;
const REINE_ZAHL = /^[+-]?\d+(?:[.,]\d+)?$/;

function csvZelle(v) {
  let s = String(v ?? '');
  if (typeof v !== 'number' && FORMEL_ANFANG.test(s) && !REINE_ZAHL.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Fertige Datei aus vorbereiteten Zeilen (Strings).
function csvDatei(zeilen) {
  return BOM + zeilen.join('\r\n');
}

module.exports = { csvZelle, csvDatei, BOM };
