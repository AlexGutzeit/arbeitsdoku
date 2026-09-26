// Eine Notiz als gemeinsames Dokument (Yjs) — und was die übrige App daraus liest.
//
// Seit den Live-Notizen (Etappe A, 26.09.2026) ist der Inhalt einer Notiz ein Yjs-Dokument
// (`notes.ydoc`). Daneben stehen zwei ABGELEITETE Spalten, die nur der Server schreibt:
//   body        Klartext — für Suche, Vorschau, Push-Text, Datenauskunft, alte Programmstände
//   body_delta  Quill-Delta als JSON — für die formatierte Anzeige in der Liste
// Wer den Inhalt ändern will, ändert das Dokument; die beiden Spalten folgen beim Speichern.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const Y = require('yjs');

// Name des Textes im Dokument — Browser (Quill-Anbindung) und Server müssen ihn gleich nennen.
const TEXT = 'notiz';

/**
 * Das Dokument endet IMMER mit einem Zeilenende und ist nie ganz leer.
 *
 * Quill hat stets einen Schluss-Zeilenumbruch. Fehlt er im gemeinsamen Dokument, zeigt die
 * Gegenseite eine Leerzeile zu viel, sobald jemand die letzte Zeile formatiert (Checkliste) —
 * gemessen beim Bau des Bündels (tests/kollab-buendel.js).
 */
function zeilenendeSichern(text) {
  if (text.length === 0 || text.toString().slice(-1) !== '\n') text.insert(text.length, '\n');
}

/** Neues Dokument aus Klartext (neue Notiz, Umstellung alter Notizen, alte Programmstände). */
function ausKlartext(klartext) {
  const doc = new Y.Doc();
  const text = doc.getText(TEXT);
  if (klartext) text.insert(0, String(klartext));
  zeilenendeSichern(text);
  const stand = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return stand;
}

/** Dokument aus dem gespeicherten Stand laden (fehlt er, aus dem Klartext bauen). */
function laden(stand, klartext) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stand && stand.length ? stand : ausKlartext(klartext));
  zeilenendeSichern(doc.getText(TEXT));
  return doc;
}

/** Die abgeleiteten Spalten eines Dokuments. */
function felder(doc) {
  const text = doc.getText(TEXT);
  return {
    body: text.toString().replace(/\n$/, ''),
    body_delta: JSON.stringify(text.toDelta()),
  };
}

/**
 * Neues Dokument aus einer Formatierung (Quill-Delta) — für Kopien („Weitergeben", später „Stand
 * als eigene Notiz"). Bewusst NICHT die Bytes des Originals: Die Kopie soll dessen
 * Bearbeitungsverlauf nicht mitschleppen, sondern nur den Inhalt.
 */
function zeileAusDelta(deltaJson, klartext) {
  let delta = null;
  try { delta = JSON.parse(deltaJson); } catch (_) { /* fällt auf den Klartext zurück */ }
  if (!Array.isArray(delta)) return zeileAusKlartext(klartext);
  const doc = new Y.Doc();
  const text = doc.getText(TEXT);
  text.applyDelta(delta);
  zeilenendeSichern(text);
  const aus = { ydoc: Y.encodeStateAsUpdate(doc), ...felder(doc) };
  doc.destroy();
  return aus;
}

/** Stand + abgeleitete Spalten aus Klartext — für INSERTs. */
function zeileAusKlartext(klartext) {
  const stand = ausKlartext(klartext);
  const doc = laden(stand);
  const f = felder(doc);
  doc.destroy();
  return { ydoc: stand, ...f };
}

module.exports = { Y, TEXT, ausKlartext, laden, felder, zeileAusKlartext, zeileAusDelta, zeilenendeSichern };
