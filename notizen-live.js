// Live-Notizen: mehrere bearbeiten eine Notiz gleichzeitig (Etappe A, 26.09.2026).
//
// Jede GEÖFFNETE Notiz hat hier einen „Raum": das gemeinsame Dokument (Yjs), wer gerade drin ist
// (Anwesenheit mit Cursor, y-protocols) und die offenen Verbindungen. Der Draht ist derselbe wie
// bei den übrigen Live-Aktualisierungen: ein Ereignisstrom je geöffneter Notiz (SSE) vom Server zum
// Browser, kurze POSTs vom Browser zum Server. Kein WebSocket — der Weg durch Caddy und das
// Freifunk-Netz der Zweitanlage ist mit SSE erprobt.
//
// Was hier bewusst streng ist:
//   * Das Schreibrecht wird bei JEDER Änderung neu aus der Datenbank geholt — der Strom ist nur
//     die Zustellung, die Tür ist der POST.
//   * Wer sein Recht verliert (Freigabe entzogen, Notiz gelöscht, ausgestellt), fliegt sofort
//     raus; wer von Schreiben auf Lesen fällt, bekommt das sofort mitgeteilt.
//   * Name und Farbe am Cursor setzt der Server, nicht der Browser — sonst könnte sich jemand
//     als ein anderer ausgeben.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const crypto = require('crypto');
const decoding = require('lib0/decoding');
const awarenessProtocol = require('y-protocols/awareness');
const { getDb } = require('./database/init');
const { Y, TEXT, laden, felder } = require('./notiz-dokument');
const { broadcast } = require('./sse');
const push = require('./push');

const SPEICHERN_NACH_MS = 1500;       // Ruhe, nach der gespeichert wird
const SPEICHERN_SPAETESTENS_MS = 10000; // … und spätestens so oft, auch wenn ununterbrochen getippt wird
// So lange ohne Änderung, dann gilt eine Bearbeitungsrunde als beendet. Als Objekt, damit ein Test
// die zwei Minuten verkürzen kann (tests/push-targeting.js).
const zeiten = { rundeMs: 2 * 60 * 1000 };
const PING_MS = 25000;
const GROESSTE_AENDERUNG = 96 * 1024; // Bytes je Sendung (die JSON-Grenze des Servers liegt bei 100 KB)

// Farben je Person. Jeder hat eine Stammfarbe (nach Nutzernummer); ist sie im Raum schon vergeben,
// nimmt er die nächste freie — in EINER Notiz sind zwei Leute nie gleich gefärbt.
const FARBEN = ['#2563eb', '#c2410c', '#7c3aed', '#0f766e', '#be123c', '#a16207',
  '#0369a1', '#4d7c0f', '#9d174d', '#475569', '#b45309', '#15803d'];

const raeume = new Map(); // noteId -> raum

const b64 = (u8) => Buffer.from(u8).toString('base64');
const ausB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));

/** Zugriff eines Nutzers auf eine Notiz: 'owner' | 'write' | 'read' | null (nicht vorhanden → undefined). */
function zugriffVon(db, noteId, userId) {
  const n = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(noteId);
  if (!n) return undefined;
  if (n.user_id === userId) return 'owner';
  const s = db.prepare('SELECT permission FROM note_shares WHERE note_id = ? AND user_id = ?').get(noteId, userId);
  return s ? (s.permission === 'write' ? 'write' : 'read') : null;
}
const darfSchreiben = (z) => z === 'owner' || z === 'write';

function senden(v, ereignis, daten) {
  try { v.res.write(`event: ${ereignis}\ndata: ${JSON.stringify(daten)}\n\n`); } catch (_) { /* Abbau folgt über close */ }
}
function anAlle(raum, ereignis, daten, ausser) {
  for (const v of raum.verbindungen.values()) if (v !== ausser) senden(v, ereignis, daten);
}

function raumHolen(noteId) {
  let raum = raeume.get(noteId);
  if (raum) return raum;
  const zeile = getDb().prepare('SELECT ydoc, body FROM notes WHERE id = ?').get(noteId);
  if (!zeile) return null;
  const doc = laden(zeile.ydoc, zeile.body);
  const aw = new awarenessProtocol.Awareness(doc);
  aw.setLocalState(null);   // der Server selbst ist kein Teilnehmer
  raum = { noteId, doc, aw, verbindungen: new Map(), speicherTimer: null, ungespeichertSeit: 0,
    zuletztGeaendertVon: null, runden: new Map() };
  // Anwesenheit, die der Server selbst beendet (Zeitüberschreitung, Verbindung weg), an alle melden
  aw.on('update', ({ removed }, herkunft) => {
    if ((herkunft === 'timeout' || herkunft === 'trennung') && removed.length) {
      anAlle(raum, 'anwesenheit', { update: b64(awarenessProtocol.encodeAwarenessUpdate(aw, removed)) });
    }
  });
  raeume.set(noteId, raum);
  return raum;
}

function raumSchliessen(raum) {
  jetztSpeichern(raum);
  for (const userId of [...raum.runden.keys()]) rundeBeenden(raum, userId);
  raum.aw.destroy();
  raum.doc.destroy();
  raeume.delete(raum.noteId);
}

// ─── Speichern ───────────────────────────────────────────────────────────────────────────────

function speichernPlanen(raum) {
  const jetzt = Date.now();
  if (!raum.speicherTimer) raum.ungespeichertSeit = jetzt;
  else if (jetzt - raum.ungespeichertSeit < SPEICHERN_SPAETESTENS_MS) clearTimeout(raum.speicherTimer);
  else return;   // läuft schon und ist fällig — nicht weiter aufschieben
  raum.speicherTimer = setTimeout(() => jetztSpeichern(raum), SPEICHERN_NACH_MS);
}

function jetztSpeichern(raum) {
  if (raum.speicherTimer) { clearTimeout(raum.speicherTimer); raum.speicherTimer = null; }
  const db = getDb();
  const alt = db.prepare('SELECT body, body_delta FROM notes WHERE id = ?').get(raum.noteId);
  if (!alt) return;   // inzwischen gelöscht
  const f = felder(raum.doc);
  const stand = Y.encodeStateAsUpdate(raum.doc);
  // Nur eine INHALTLICHE Änderung setzt Zeitstempel und Bearbeiter — daran hängen Zähler und
  // „Bearbeitet … von …" (Regel vom 18.08.2026: nur hineinschauen löst nichts aus).
  if (alt.body !== f.body || alt.body_delta !== f.body_delta) {
    db.prepare("UPDATE notes SET ydoc = ?, body = ?, body_delta = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ? WHERE id = ?")
      .run(stand, f.body, f.body_delta, raum.zuletztGeaendertVon, raum.noteId);
    broadcast('notes', null);
  } else {
    db.prepare('UPDATE notes SET ydoc = ? WHERE id = ?').run(stand, raum.noteId);
  }
}

// ─── Bearbeitungsrunden und Meldung ──────────────────────────────────────────────────────────
//
// Eine Meldung je Runde statt je Tastendruck (Alex, 26.09.2026). Eine Runde beginnt mit der ersten
// Änderung eines Nutzers und endet, wenn er die Notiz verlässt oder 2 Minuten nichts ändert.
// Gemeldet wird nur, wenn der Inhalt danach wirklich anders ist als vorher, und nur an die, die
// gerade NICHT in der Notiz sind — wer drin ist, hat es live gesehen.

// Titel gehört dazu: Umbenennen ist auch eine Bearbeitung.
function inhalt(raum) {
  const n = getDb().prepare('SELECT title FROM notes WHERE id = ?').get(raum.noteId);
  const f = felder(raum.doc);
  return (n ? n.title : '') + '\u0000' + f.body + '\u0000' + f.body_delta;
}

function rundeFortsetzen(raum, userId, vorher) {
  let r = raum.runden.get(userId);
  if (!r) { r = { vorher, timer: null }; raum.runden.set(userId, r); }
  clearTimeout(r.timer);
  r.timer = setTimeout(() => rundeBeenden(raum, userId), zeiten.rundeMs);
}

function rundeBeenden(raum, userId) {
  const r = raum.runden.get(userId);
  if (!r) return;
  clearTimeout(r.timer);
  raum.runden.delete(userId);
  if (r.vorher === inhalt(raum)) return;   // hin und zurück geändert — nichts zu melden
  jetztSpeichern(raum);
  const db = getDb();
  const note = db.prepare('SELECT user_id, title FROM notes WHERE id = ?').get(raum.noteId);
  if (!note) return;
  const drin = new Set([...raum.verbindungen.values()].map(v => v.userId));
  const empfaenger = [note.user_id,
    ...db.prepare('SELECT user_id FROM note_shares WHERE note_id = ?').all(raum.noteId).map(s => s.user_id)]
    .filter(id => !drin.has(id));
  const wer = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  push.notifyUsers(db, empfaenger, 'notes', {
    title: 'Notiz bearbeitet',
    body: `${wer ? wer.name : 'Jemand'} hat „${note.title}" bearbeitet`,
    url: '/#/notes',
  }, userId);
}

// ─── Verbindungen ────────────────────────────────────────────────────────────────────────────

/**
 * Ereignisstrom einer Notiz öffnen. `nutzer` = { id, name } (bereits geprüft), `res` = Antwort.
 * Liefert false, wenn die Notiz fehlt oder der Nutzer keinen Zugriff hat.
 */
function verbinden(noteId, nutzer, req, res) {
  const db = getDb();
  const zugriff = zugriffVon(db, noteId, nutzer.id);
  if (zugriff === undefined) return 404;
  if (!zugriff) return 403;
  const raum = raumHolen(noteId);
  if (!raum) return 404;

  const belegt = new Set([...raum.verbindungen.values()].filter(v => v.userId !== nutzer.id).map(v => v.farbe));
  const eigene = [...raum.verbindungen.values()].find(v => v.userId === nutzer.id);
  const stamm = FARBEN[nutzer.id % FARBEN.length];
  const farbe = eigene ? eigene.farbe : (!belegt.has(stamm) ? stamm : (FARBEN.find(f => !belegt.has(f)) || stamm));

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const v = { id: crypto.randomUUID(), noteId, userId: nutzer.id, name: nutzer.name, farbe, zugriff, res,
    clientIds: new Set(), ping: null };
  raum.verbindungen.set(v.id, v);
  v.ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, PING_MS);

  const fremde = [...raum.aw.getStates().keys()];
  senden(v, 'start', {
    verbindung: v.id,
    zugriff,
    du: { name: nutzer.name, farbe },
    stand: b64(Y.encodeStateAsUpdate(raum.doc)),
    sv: b64(Y.encodeStateVector(raum.doc)),
    anwesenheit: fremde.length ? b64(awarenessProtocol.encodeAwarenessUpdate(raum.aw, fremde)) : null,
  });
  // Eigenes Signal statt 'notes': „gerade drin" in den Listen auffrischen, ohne dass bei allen
  // der Zähler neu geholt wird — hineinschauen ist keine Änderung.
  broadcast('notes-anwesend', null);

  let weg = false;
  const abbauen = () => {
    if (weg) return; weg = true;
    clearInterval(v.ping);
    raum.verbindungen.delete(v.id);
    if (v.clientIds.size) awarenessProtocol.removeAwarenessStates(raum.aw, [...v.clientIds], 'trennung');
    const nochDa = [...raum.verbindungen.values()].some(x => x.userId === v.userId);
    if (!nochDa) rundeBeenden(raum, v.userId);
    if (!raum.verbindungen.size) raumSchliessen(raum);
    broadcast('notes-anwesend', null);
  };
  v.abbauen = abbauen;
  req.on('close', abbauen); res.on('close', abbauen); res.on('error', abbauen);
  return 200;
}

function verbindungFuer(noteId, verbindungId, userId) {
  const raum = raeume.get(noteId);
  const v = raum && raum.verbindungen.get(String(verbindungId || ''));
  return (v && v.userId === userId) ? { raum, v } : null;
}

/** Eine Änderung am Dokument übernehmen. Liefert { status, fehler? }. */
function aenderung(noteId, userId, verbindungId, updateB64) {
  const treffer = verbindungFuer(noteId, verbindungId, userId);
  if (!treffer) return { status: 409, code: 'VERBINDUNG_WEG', fehler: 'Die Verbindung zur Notiz ist unterbrochen. Sie wird neu aufgebaut.' };
  const { raum, v } = treffer;
  const zugriff = zugriffVon(getDb(), noteId, userId);
  if (!darfSchreiben(zugriff)) {
    zugriffAbgleichen(noteId);
    return { status: 403, fehler: 'Du darfst diese Notiz nur lesen.' };
  }
  const update = ausB64(updateB64);
  if (!update.length || update.length > GROESSTE_AENDERUNG) return { status: 413, fehler: 'Diese Änderung ist zu groß.' };
  const vorher = inhalt(raum);
  try {
    Y.applyUpdate(raum.doc, update, v);
  } catch (_) {
    return { status: 400, fehler: 'Die Änderung war beschädigt und wurde nicht übernommen.' };
  }
  // Das Dokument endet immer mit einem Zeilenende (siehe notiz-dokument.js). Löscht jemand
  // alles bis auf den letzten Rest, wird es hier wieder angefügt — und an ALLE verteilt.
  anAlle(raum, 'aenderung', { update: updateB64 }, v);
  const text = raum.doc.getText(TEXT);
  if (text.length === 0 || text.toString().slice(-1) !== '\n') {
    const sv = Y.encodeStateVector(raum.doc);
    text.insert(text.length, '\n');
    anAlle(raum, 'aenderung', { update: b64(Y.encodeStateAsUpdate(raum.doc, sv)) }, null);
  }
  if (inhalt(raum) !== vorher) {
    raum.zuletztGeaendertVon = userId;
    rundeFortsetzen(raum, userId, vorher);
  }
  speichernPlanen(raum);
  return { status: 200 };
}

/** Clientnummern in einem Anwesenheits-Update (ohne es anzuwenden). */
function clientIdsIn(update) {
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  const ids = [];
  for (let i = 0; i < n; i++) { ids.push(decoding.readVarUint(d)); decoding.readVarUint(d); decoding.readVarString(d); }
  return ids;
}

/** Cursor / Anwesenheit übernehmen und an die anderen weitergeben. */
function anwesenheit(noteId, userId, verbindungId, updateB64) {
  const treffer = verbindungFuer(noteId, verbindungId, userId);
  if (!treffer) return { status: 409, code: 'VERBINDUNG_WEG', fehler: 'Die Verbindung zur Notiz ist unterbrochen.' };
  const { raum, v } = treffer;
  const update = ausB64(updateB64);
  let ids;
  try { ids = clientIdsIn(update); } catch (_) { return { status: 400, fehler: 'Ungültige Anwesenheit.' }; }
  // Eine Clientnummer gehört einer Verbindung. Übernehmen darf sie nur dieselbe Person (neu
  // aufgebaute Verbindung, deren alte noch nicht abgemeldet ist) — nie jemand anderes.
  for (const id of ids) {
    for (const x of raum.verbindungen.values()) {
      if (x !== v && x.clientIds.has(id)) {
        if (x.userId !== userId) return { status: 403, fehler: 'Ungültige Anwesenheit.' };
        x.clientIds.delete(id);
      }
    }
    v.clientIds.add(id);
  }
  try { awarenessProtocol.applyAwarenessUpdate(raum.aw, update, v); } catch (_) { return { status: 400, fehler: 'Ungültige Anwesenheit.' }; }
  // Name und Farbe setzt der Server — was der Browser mitschickt, zählt nicht.
  for (const id of ids) { const st = raum.aw.states.get(id); if (st) st.user = { name: v.name, color: v.farbe }; }
  anAlle(raum, 'anwesenheit', { update: b64(awarenessProtocol.encodeAwarenessUpdate(raum.aw, ids)) }, v);
  return { status: 200 };
}

// ─── Rauswerfen und Rechte nachziehen ────────────────────────────────────────────────────────

function rauswerfen(v, grund) {
  senden(v, 'raus', { grund });
  try { v.res.end(); } catch (_) {}
  if (v.abbauen) v.abbauen();
}

/**
 * Nach einer Rechte-Änderung an einer Notiz: jeden Verbundenen neu prüfen. Kein Zugriff mehr →
 * raus; Schreiben ↔ Lesen → sofort mitteilen. Wird von den Freigabe-Routen aufgerufen.
 */
function zugriffAbgleichen(noteId) {
  const raum = raeume.get(Number(noteId));
  if (!raum) return;
  const db = getDb();
  for (const v of [...raum.verbindungen.values()]) {
    const z = zugriffVon(db, raum.noteId, v.userId);
    if (z === undefined) rauswerfen(v, 'geloescht');
    else if (!z) rauswerfen(v, 'freigabe-entzogen');
    else if (z !== v.zugriff) { v.zugriff = z; senden(v, 'zugriff', { zugriff: z }); }
  }
}

/** Notiz gelöscht: alle raus, nichts mehr speichern. */
function notizGeloescht(noteId) {
  const raum = raeume.get(Number(noteId));
  if (!raum) return;
  clearTimeout(raum.speicherTimer); raum.speicherTimer = null;
  for (const r of raum.runden.values()) clearTimeout(r.timer);
  raum.runden.clear();
  for (const v of [...raum.verbindungen.values()]) rauswerfen(v, 'geloescht');
}

/** Nutzer ausgestellt: aus allen Notizen raus. */
function nutzerRauswerfen(userId) {
  for (const raum of [...raeume.values()]) {
    for (const v of [...raum.verbindungen.values()]) if (v.userId === userId) rauswerfen(v, 'abgemeldet');
  }
}

/** Inhalt einer offenen Notiz vor einer Titel-Änderung (null, wenn niemand drin ist). */
function inhaltVon(noteId) {
  const raum = raeume.get(Number(noteId));
  return raum ? inhalt(raum) : null;
}

/**
 * Titel oder Projekt geändert: an alle in der Notiz (außer dem Absender) und als Teil der
 * Bearbeitungsrunde des Nutzers vermerken. Liefert false, wenn die Notiz gerade nicht offen ist —
 * dann meldet die Route selbst.
 */
function kopfGeaendert(noteId, kopf, verbindungId, userId, vorher) {
  const raum = raeume.get(Number(noteId));
  if (!raum) return false;
  anAlle(raum, 'kopf', kopf, raum.verbindungen.get(String(verbindungId || '')));
  if (vorher != null && vorher !== inhalt(raum)) rundeFortsetzen(raum, userId, vorher);
  return true;
}

/** Wer ist gerade in welcher Notiz? { noteId: [Namen] } — für die Liste. */
function anwesende() {
  const aus = {};
  for (const raum of raeume.values()) {
    aus[raum.noteId] = [...new Map([...raum.verbindungen.values()].map(v => [v.userId, v.name])).values()];
  }
  return aus;
}

/** Aktueller Stand einer offenen Notiz (für Kopien), sonst null. */
function offenerStand(noteId) {
  const raum = raeume.get(Number(noteId));
  if (!raum) return null;
  return { ydoc: Y.encodeStateAsUpdate(raum.doc), ...felder(raum.doc) };
}

/** Alles sofort speichern (vor dem Beenden des Servers). */
function allesSpeichern() { for (const raum of raeume.values()) jetztSpeichern(raum); }

module.exports = { verbinden, aenderung, anwesenheit, zugriffAbgleichen, notizGeloescht, nutzerRauswerfen,
  kopfGeaendert, inhaltVon, anwesende, offenerStand, allesSpeichern, zugriffVon, FARBEN,
  zeiten, _intern: { raeume } };
