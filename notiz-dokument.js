// Eine Notiz als gemeinsames Dokument (Yjs) — und was die übrige App daraus liest.
//
// Seit den Live-Notizen (Etappe A, 26.09.2026) ist der Inhalt einer Notiz ein Yjs-Dokument
// (`notes.ydoc`). Daneben stehen zwei ABGELEITETE Spalten, die nur der Server schreibt:
//   body        Klartext — für Suche, Vorschau, Push-Text, Datenauskunft, alte Programmstände
//   body_delta  Quill-Delta als JSON — für die formatierte Anzeige in der Liste, Druck und Dateien
// Wer den Inhalt ändern will, ändert das Dokument; die beiden Spalten folgen beim Speichern.
//
// Zeichenflächen (24.11.2026, Aufbau in public/js/zeichnung.js): im Text ein Block { zeichnung: '<id>' },
// der Inhalt in der Karte ZEICHNUNGEN. In body_delta steht der Block MIT Inhalt
// ({ zeichnung: { id, b, h, e, s } }) — so braucht die Vorschau kein Dokument; im Klartext steht „[Zeichnung]".
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const Y = require('yjs');
const Z = require('./public/js/zeichnung');

// Name des Textes im Dokument — Browser (Quill-Anbindung) und Server müssen ihn gleich nennen.
const TEXT = 'notiz';
const ZEICHNUNGEN = 'zeichnungen';
const KLARTEXT_ZEICHNUNG = '[Zeichnung]';

/**
 * Das Dokument endet IMMER mit einem Zeilenende und ist nie ganz leer.
 *
 * Quill hat stets einen Schluss-Zeilenumbruch. Fehlt er im gemeinsamen Dokument, zeigt die
 * Gegenseite eine Leerzeile zu viel, sobald jemand die letzte Zeile formatiert (Checkliste) —
 * gemessen beim Bau des Bündels (tests/kollab-buendel.js).
 */
function zeilenendeSichern(text) {
  if (!endetMitZeilenende(text)) text.insert(text.length, '\n');
}

/**
 * Endet der Text mit einem Zeilenende? Über die Formatierung, nicht über toString(): Das lässt
 * eingebettete Blöcke (Zeichnungen) aus — steht eine Zeichnung am Schluss, sähe es das Zeilenende davor.
 */
function endetMitZeilenende(text) {
  if (text.length === 0) return false;
  const d = text.toDelta();
  const letzte = d[d.length - 1];
  return !!letzte && typeof letzte.insert === 'string' && letzte.insert.endsWith('\n');
}

/**
 * Neues Dokument aus Klartext (neue Notiz, Umstellung alter Notizen, alte Programmstände).
 *
 * Hängt IMMER genau ein Zeilenende an — die Umkehrung von felder(), das genau eins abschneidet.
 * Nur „fehlendes ergänzen" (zeilenendeSichern) verlor eine Leerzeile am Schluss: Klartext „…\n" blieb
 * „…\n", und felder() machte daraus „…". Gefunden am Prod-Klon 29.09.2026 (tests/notizen-live-prodklon.js,
 * eine Notiz endete auf eine Leerzeile) — betrifft die Umstellung, also auch den Rückweg ydoc = NULL.
 */
function ausKlartext(klartext) {
  const doc = new Y.Doc();
  const text = doc.getText(TEXT);
  text.insert(0, String(klartext || '') + '\n');
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

/** Inhalt einer Zeichenfläche als schlichtes Objekt ({ b, h, e, s }); fehlt sie, eine leere */
function zeichnungDaten(doc, id) {
  const m = doc.getMap(ZEICHNUNGEN).get(id);
  if (!(m instanceof Y.Map)) return Z.bereinigt({});
  const s = m.get('s');
  return Z.bereinigt({ b: m.get('b'), h: m.get('h'), e: m.get('e'), s: s instanceof Y.Array ? s.toArray() : [] });
}

/** Die abgeleiteten Spalten eines Dokuments. */
function felder(doc) {
  const text = doc.getText(TEXT);
  const delta = text.toDelta();
  let body = '';
  const mitZeichnungen = delta.map(op => {
    if (typeof op.insert === 'string') { body += op.insert; return op; }
    const id = op.insert && op.insert.zeichnung;
    if (typeof id !== 'string') return op;
    body += KLARTEXT_ZEICHNUNG + '\n';
    return { ...op, insert: { zeichnung: { id, ...zeichnungDaten(doc, id) } } };
  });
  return {
    body: body.replace(/\n$/, ''),
    body_delta: JSON.stringify(mitZeichnungen),
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
  // Zeichnungen: Inhalt zurück in die Karte, im Text nur die Kennung. Andere Blöcke gibt es nicht.
  const flaechen = doc.getMap(ZEICHNUNGEN);
  const ops = [];
  for (const op of delta) {
    if (!op || op.insert === undefined) continue;
    if (typeof op.insert === 'string') { ops.push(op); continue; }
    const z = op.insert && op.insert.zeichnung;
    if (!z || typeof z !== 'object' || typeof z.id !== 'string' || !Z.ID.test(z.id) || flaechen.has(z.id)) continue;
    flaechen.set(z.id, neueZeichnung(Z.bereinigt(z)));
    ops.push({ ...op, insert: { zeichnung: z.id } });
  }
  text.applyDelta(ops);
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

// Was in einer Notiz stehen darf — genau das, was die Knopfleiste kann. Alles andere (Bilder,
// Links, Überschriften, fremde Datenfelder im Dokument) kann nur ein manipulierter Browser schicken;
// es brächte das Schreibfeld der anderen durcheinander. Geprüft wird der Stand NACH einer Änderung.
// `false` heißt „nicht formatiert" und ist harmlos (Quill selbst entfernt mit null, das Yjs gar nicht speichert).
// Farben und Größen: dieselben Namen wie NOTIZ_FARBEN/NOTIZ_GROESSEN in public/js/notiz-sitzung.js
// (tests/notiz-formate.js hält beide gleich). Farbwert für PDF/Word/ODT; Größe als Faktor der Grundschrift
// (wie Quills .ql-size-*: 0,75 / 1,5 / 2,5 em).
const FARBEN = { rot: '#dc2626', orange: '#c2410c', gruen: '#15803d', blau: '#1d4ed8', lila: '#7e22ce', grau: '#6b7280' };
const GROESSEN = { small: 0.75, large: 1.5, huge: 2.5 };
const ERLAUBTE_FORMATE = { bold: [true, false], italic: [true, false], underline: [true, false], strike: [true, false], script: ['super', 'sub', false],
  color: [...Object.keys(FARBEN), false], size: [...Object.keys(GROESSEN), false], list: ['bullet', 'ordered', 'checked', 'unchecked', false] };
function zulaessig(doc) {
  if ([...doc.share.keys()].some(k => k !== TEXT && k !== ZEICHNUNGEN)) return false;
  let bloecke = 0;
  for (const op of doc.getText(TEXT).toDelta()) {
    if (typeof op.insert !== 'string') {
      // Einziger erlaubter Block: eine Zeichenfläche, als Objekt mit genau der Kennung
      const ins = op.insert;
      if (!ins || typeof ins !== 'object' || Object.keys(ins).length !== 1 || typeof ins.zeichnung !== 'string' || !Z.ID.test(ins.zeichnung)) return false;
      if (++bloecke > Z.MAX_FLAECHEN) return false;
    }
    // Formate gelten auch für Blöcke: Wer Text samt Zeichnung markiert und „fett" drückt, formatiert beide.
    for (const [k, v] of Object.entries(op.attributes || {})) {
      if (!Object.hasOwn(ERLAUBTE_FORMATE, k) || !ERLAUBTE_FORMATE[k].includes(v)) return false;
    }
  }
  return !doc.share.has(ZEICHNUNGEN) || zeichnungenZulaessig(doc.getMap(ZEICHNUNGEN));
}

// Die Karte der Zeichenflächen: nur Kennung → Y.Map { b, h, e, s: Y.Array von Strichen }. `_start` bzw.
// `_map` sind die Listen- bzw. Schlüsselteile eines Yjs-Typs — gehören dort nicht hin (ein manipulierter
// Browser könnte die Karte sonst als Liste befüllen; sichtbar wäre es nirgends, aber es läge in der Notiz).
function zeichnungenZulaessig(karte) {
  if (karte._start !== null || karte.size > Z.MAX_FLAECHEN) return false;
  for (const [id, m] of karte) {
    if (!Z.ID.test(id) || !(m instanceof Y.Map) || m._start !== null) return false;
    if ([...m.keys()].some(k => !['b', 'h', 'e', 's'].includes(k))) return false;
    const s = m.get('s');
    if (!Z.massOk(m.get('b'), m.get('h'), m.get('e')) || !(s instanceof Y.Array) || s._map.size) return false;
    if (s.length > Z.MAX_STRICHE || !s.toArray().every(Z.strichOk)) return false;
  }
  return true;
}

/** Eine Zeichenfläche als Yjs-Typ (zum Einfügen in die Karte) */
function neueZeichnung({ b, h, e, s = [] }) {
  const m = new Y.Map();
  m.set('b', b); m.set('h', h); m.set('e', e);
  const striche = new Y.Array();
  striche.push(s.map(st => ({ ...st, p: [...st.p] })));
  m.set('s', striche);
  return m;
}

module.exports = { Y, TEXT, ZEICHNUNGEN, FARBEN, GROESSEN, ausKlartext, laden, felder, zeileAusKlartext, zeileAusDelta,
  zeilenendeSichern, endetMitZeilenende, zulaessig, neueZeichnung };
