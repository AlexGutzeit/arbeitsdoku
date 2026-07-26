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

const BOM = '﻿';

function csvZelle(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

// Fertige Datei aus vorbereiteten Zeilen (Strings).
function csvDatei(zeilen) {
  return BOM + zeilen.join('\r\n');
}

module.exports = { csvZelle, csvDatei, BOM };
