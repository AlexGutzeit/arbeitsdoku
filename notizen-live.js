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
//   * Gäste (Etappe C, notiz-gaeste.js) sind Teilnehmer wie alle anderen, nur mit eigener Kennung
//     `wer` = 'g<Nummer>' statt der Nutzernummer. Sie sehen von Mitarbeitern nur den Vornamen und
//     vom Kopf nur den Titel (kein Projekt).
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const crypto = require('crypto');
const decoding = require('lib0/decoding');
const awarenessProtocol = require('y-protocols/awareness');
const { getDb } = require('./database/init');
const { Y, TEXT, laden, felder, zulaessig } = require('./notiz-dokument');
const { broadcast } = require('./sse');
const push = require('./push');
const notizGaeste = require('./notiz-gaeste');
const projektNotiz = require('./projekt-notiz');

const SPEICHERN_NACH_MS = 1500;       // Ruhe, nach der gespeichert wird
const SPEICHERN_SPAETESTENS_MS = 10000; // … und spätestens so oft, auch wenn ununterbrochen getippt wird
// So lange ohne Änderung, dann gilt eine Bearbeitungsrunde als beendet. Als Objekt, damit ein Test
// die zwei Minuten verkürzen kann (tests/push-targeting.js).
const zeiten = { rundeMs: 2 * 60 * 1000 };
const PING_MS = 25000;
// Bytes je Sendung. Base64 macht daraus ein Drittel mehr, und die JSON-Grenze des Servers liegt bei
// 100 KB — 70 KB passen mit Luft hinein (vorher 96 KB: die Anfrage scheiterte schon an der Grenze).
const GROESSTE_AENDERUNG = 70 * 1024;

// Farben je Person. Jeder hat eine Stammfarbe (nach Nutzernummer); ist sie im Raum schon vergeben,
// nimmt er die nächste freie — in EINER Notiz sind zwei Leute nie gleich gefärbt.
const FARBEN = ['#2563eb', '#c2410c', '#7c3aed', '#0f766e', '#be123c', '#a16207',
  '#0369a1', '#4d7c0f', '#9d174d', '#475569', '#b45309', '#15803d'];

const raeume = new Map(); // noteId -> raum

const b64 = (u8) => Buffer.from(u8).toString('base64');
const ausB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));

// Teilnehmer-Kennung: Nutzernummer (Zahl) oder 'g<Nummer>' für einen Gast
const gastNr = (wer) => (typeof wer === 'string' && /^g\d+$/.test(wer)) ? Number(wer.slice(1)) : null;

/**
 * Zugriff eines Teilnehmers auf eine Notiz: 'owner' | 'write' | 'read' | null (Notiz nicht vorhanden
 * → undefined). `wer` = Nutzernummer oder 'g<Nummer>' (Gast).
 */
function zugriffVon(db, noteId, wer) {
  const n = db.prepare('SELECT user_id, projekt_notiz_fuer FROM notes WHERE id = ?').get(noteId);
  if (!n) return undefined;
  const g = gastNr(wer);
  if (g !== null) {
    const z = notizGaeste.zugriff(db, g);
    return (z.zugriff && z.gast.note_id === Number(noteId)) ? z.zugriff : null;
  }
  // Projektnotiz: kein Eigentümer — Rolle und Zuteilung entscheiden (projekt-notiz.js)
  if (n.projekt_notiz_fuer) return projektNotiz.zugriff(db, n, wer);
  if (n.user_id === wer) return 'owner';
  const s = db.prepare('SELECT permission FROM note_shares WHERE note_id = ? AND user_id = ?').get(noteId, wer);
  return s ? (s.permission === 'write' ? 'write' : 'read') : null;
}
const darfSchreiben = (z) => z === 'owner' || z === 'write';

function senden(v, ereignis, daten) {
  try { v.res.write(`event: ${ereignis}\ndata: ${JSON.stringify(daten)}\n\n`); } catch (_) { /* Abbau folgt über close */ }
}
function anAlle(raum, ereignis, daten, ausser) {
  for (const v of raum.verbindungen.values()) if (v !== ausser) senden(v, ereignis, daten);
}

// Anwesenheit (Cursor mit Namen) verschicken. Gäste bekommen dieselben Angaben, aber mit dem
// VORNAMEN der Mitarbeiter (Alex, 26.09.2026) — der Server kodiert für sie eigens.
function anwesenheitFuer(raum, empfaenger, ids) {
  if (!empfaenger.gast) return b64(awarenessProtocol.encodeAwarenessUpdate(raum.aw, ids));
  const states = new Map();
  for (const id of ids) {
    const st = raum.aw.states.get(id);
    if (!st) continue;
    const besitzer = [...raum.verbindungen.values()].find(x => x.clientIds.has(id));
    if (!besitzer) continue;   // niemandem zuzuordnen — dann lieber gar nicht zeigen
    states.set(id, st.user ? { ...st, user: { ...st.user, name: besitzer.gast ? besitzer.name : besitzer.vorname } } : st);
  }
  return b64(awarenessProtocol.encodeAwarenessUpdate(raum.aw, ids, states));
}
function anwesenheitAnAlle(raum, ids, ausser) {
  for (const v of raum.verbindungen.values()) if (v !== ausser) senden(v, 'anwesenheit', { update: anwesenheitFuer(raum, v, ids) });
}
// Kopf einer Notiz: Titel, Projekt — und bei einer Projektnotiz das Projekt, dem sie gehört
function kopfVon(db, noteId) {
  const k = db.prepare(`SELECT n.title, n.project_id, n.project_text, n.projekt_notiz_fuer, p.name AS projekt_name
    FROM notes n LEFT JOIN projects p ON p.id = n.projekt_notiz_fuer WHERE n.id = ?`).get(noteId);
  if (!k) return null;
  return { title: k.title, project_id: k.project_id, project_text: k.project_text,
    projekt: k.projekt_notiz_fuer ? { id: k.projekt_notiz_fuer, name: k.projekt_name } : null };
}
// Kopf (Titel, Projekt): Gäste sehen nur den Titel
const kopfFuer = (v, kopf) => (v.gast ? { title: kopf.title } : kopf);

function raumHolen(noteId) {
  let raum = raeume.get(noteId);
  if (raum) return raum;
  const zeile = getDb().prepare('SELECT ydoc, body FROM notes WHERE id = ?').get(noteId);
  if (!zeile) return null;
  const doc = laden(zeile.ydoc, zeile.body);
  const aw = new awarenessProtocol.Awareness(doc);
  aw.setLocalState(null);   // der Server selbst ist kein Teilnehmer
  raum = { noteId, doc, aw, verbindungen: new Map(), speicherTimer: null, ungespeichertSeit: 0,
    zuletztGeaendertVon: null, zuletztGeaendertName: null, runden: new Map() };
  // Anwesenheit, die der Server selbst beendet (Zeitüberschreitung, Verbindung weg), an alle melden
  aw.on('update', ({ removed }, herkunft) => {
    if ((herkunft === 'timeout' || herkunft === 'trennung') && removed.length) {
      anAlle(raum, 'anwesenheit', { update: b64(awarenessProtocol.encodeAwarenessUpdate(aw, removed)) });   // ohne Namen
    }
  });
  raeume.set(noteId, raum);
  return raum;
}

function raumSchliessen(raum) {
  jetztSpeichern(raum);
  for (const wer of [...raum.runden.keys()]) rundeBeenden(raum, wer);
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
  // Nach dem Zurückspielen einer Sicherung darf der alte Stand nicht mehr hinein. Solange
  // allesVerwerfen() VOR dem Tausch läuft, landete ein letzter Speichervorgang ohnehin in der alten
  // Datenbank; diese Sperre hält auch, falls die Reihenfolge je umgedreht wird (geprüft 27.09.2026).
  if (raum.verworfen) return;
  const db = getDb();
  const alt = db.prepare('SELECT body, body_delta, projekt_notiz_fuer FROM notes WHERE id = ?').get(raum.noteId);
  if (!alt) return;   // inzwischen gelöscht
  const f = felder(raum.doc);
  const stand = Y.encodeStateAsUpdate(raum.doc);
  // Nur eine INHALTLICHE Änderung setzt Zeitstempel und Bearbeiter — daran hängen Zähler und
  // „Bearbeitet … von …" (Regel vom 18.08.2026: nur hineinschauen löst nichts aus).
  if (alt.body !== f.body || alt.body_delta !== f.body_delta) {
    // Ein Gast ist kein Nutzer: `updated_by` bleibt leer, sein Name steht in `updated_by_gast`
    const gast = gastNr(raum.zuletztGeaendertVon) !== null;
    db.prepare("UPDATE notes SET ydoc = ?, body = ?, body_delta = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ?, updated_by_gast = ? WHERE id = ?")
      .run(stand, f.body, f.body_delta, gast ? null : raum.zuletztGeaendertVon, gast ? raum.zuletztGeaendertName : null, raum.noteId);
    gesehenVermerken(raum.noteId);   // vor der Meldung: sonst zählt der Zähler der Anwesenden kurz hoch
    broadcast('notes', null);
    // Projektnotiz: Das Board zeigt 📝, sobald sie Inhalt hat — nur dann auffrischen, nicht bei jedem Tippen
    if (alt.projekt_notiz_fuer && !(alt.body || '').trim() !== !(f.body || '').trim()) broadcast('projects', null);
  } else {
    db.prepare('UPDATE notes SET ydoc = ? WHERE id = ?').run(stand, raum.noteId);
  }
}

// Wer drin ist, sieht jede Änderung live — für den Zähler gilt die Notiz bei ihm als gesehen, und
// zwar genau bis zum gespeicherten Stand (`updated_at`), nicht „bis jetzt". Sonst zählte eine
// Änderung, die zwischen zwei Speicherungen jemand anderes macht, nie als neu.
function gesehenVermerken(noteId, nurUserId) {
  const raum = raeume.get(Number(noteId));
  // Nur Mitarbeiter — Gäste haben keinen Zähler
  const leute = nurUserId != null ? [nurUserId] : (raum ? [...new Set([...raum.verbindungen.values()].filter(v => !v.gast).map(v => v.userId))] : []);
  if (!leute.length) return;
  const db = getDb();
  const n = db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(Number(noteId));
  if (!n || !n.updated_at) return;
  const setzen = db.prepare(`INSERT INTO note_gesehen (user_id, note_id, gesehen_am) VALUES (?, ?, ?)
    ON CONFLICT(user_id, note_id) DO UPDATE SET gesehen_am = excluded.gesehen_am`);
  for (const uid of leute) setzen.run(uid, Number(noteId), n.updated_at);
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

function rundeFortsetzen(raum, wer, vorher, name) {
  let r = raum.runden.get(wer);
  if (!r) { r = { vorher, timer: null, name }; raum.runden.set(wer, r); }
  clearTimeout(r.timer);
  r.timer = setTimeout(() => rundeBeenden(raum, wer), zeiten.rundeMs);
}

function rundeBeenden(raum, wer) {
  const r = raum.runden.get(wer);
  if (!r) return;
  clearTimeout(r.timer);
  raum.runden.delete(wer);
  if (r.vorher === inhalt(raum)) return;   // hin und zurück geändert — nichts zu melden
  jetztSpeichern(raum);
  const db = getDb();
  const note = db.prepare('SELECT user_id, title, projekt_notiz_fuer FROM notes WHERE id = ?').get(raum.noteId);
  if (!note) return;
  const drin = new Set([...raum.verbindungen.values()].filter(v => !v.gast).map(v => v.userId));
  // Projektnotiz: nur die Zugeteilten (Alex, 28.09.2026); sonst Eigentümer + Freigaben
  const empfaenger = (note.projekt_notiz_fuer ? projektNotiz.empfaenger(db, note.projekt_notiz_fuer)
    : [note.user_id, ...db.prepare('SELECT user_id FROM note_shares WHERE note_id = ?').all(raum.noteId).map(s => s.user_id)])
    .filter(id => id != null && !drin.has(id));
  const gast = gastNr(wer) !== null;
  const nutzer = gast ? null : db.prepare('SELECT name FROM users WHERE id = ?').get(wer);
  const name = gast ? r.name : (nutzer ? nutzer.name : null);
  push.notifyUsers(db, empfaenger, 'notes', note.projekt_notiz_fuer ? {
    title: 'Projektnotiz bearbeitet',
    body: `${name || 'Jemand'} hat die Projektnotiz „${note.title}" bearbeitet`,
    url: '/#/projects',
  } : {
    title: 'Notiz bearbeitet',
    body: `${name || 'Jemand'} hat „${note.title}" bearbeitet`,
    url: '/#/notes',
  }, gast ? null : wer);
}

// ─── Verbindungen ────────────────────────────────────────────────────────────────────────────

/**
 * Ereignisstrom einer Notiz öffnen. `nutzer` = { id, name } eines Mitarbeiters ODER
 * { gast: <Nummer>, name } eines Gasts (beides bereits geprüft), `res` = Antwort.
 * Liefert 404/403, wenn die Notiz fehlt oder kein Zugriff besteht, sonst 200.
 */
function verbinden(noteId, nutzer, req, res) {
  const db = getDb();
  const gast = Number.isInteger(nutzer.gast);
  const wer = gast ? 'g' + nutzer.gast : nutzer.id;
  const zugriff = zugriffVon(db, noteId, wer);
  if (zugriff === undefined) return 404;
  if (!zugriff) return 403;
  const raum = raumHolen(noteId);
  if (!raum) return 404;

  const belegt = new Set([...raum.verbindungen.values()].filter(v => v.wer !== wer).map(v => v.farbe));
  const eigene = [...raum.verbindungen.values()].find(v => v.wer === wer);
  const stamm = FARBEN[(gast ? nutzer.gast * 5 + 3 : nutzer.id) % FARBEN.length];
  const farbe = eigene ? eigene.farbe : (!belegt.has(stamm) ? stamm : (FARBEN.find(f => !belegt.has(f)) || stamm));
  const name = gast ? notizGaeste.anzeigeName({ name: nutzer.name }) : nutzer.name;

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const v = { id: crypto.randomUUID(), noteId, wer, userId: gast ? null : nutzer.id, gast, gastId: gast ? nutzer.gast : null,
    name, vorname: String(nutzer.name || '').trim().split(/\s+/)[0] || name, farbe, zugriff, res,
    clientIds: new Set(), ping: null };
  raum.verbindungen.set(v.id, v);
  v.ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, PING_MS);

  const fremde = [...raum.aw.getStates().keys()];
  const kopf = kopfVon(db, noteId);
  senden(v, 'start', {
    verbindung: v.id,
    zugriff,
    kopf: kopfFuer(v, kopf),
    du: { name, farbe },
    stand: b64(Y.encodeStateAsUpdate(raum.doc)),
    sv: b64(Y.encodeStateVector(raum.doc)),
    anwesenheit: fremde.length ? anwesenheitFuer(raum, v, fremde) : null,
  });
  if (!gast) gesehenVermerken(noteId, nutzer.id);   // wer öffnet, sieht den aktuellen Stand
  // Eigenes Signal statt 'notes': „gerade drin" in den Listen auffrischen, ohne dass bei allen
  // der Zähler neu geholt wird — hineinschauen ist keine Änderung.
  broadcast('notes-anwesend', null);

  let weg = false;
  const abbauen = () => {
    if (weg) return; weg = true;
    clearInterval(v.ping);
    raum.verbindungen.delete(v.id);
    if (v.clientIds.size) awarenessProtocol.removeAwarenessStates(raum.aw, [...v.clientIds], 'trennung');
    const nochDa = [...raum.verbindungen.values()].some(x => x.wer === v.wer);
    if (!nochDa) {
      rundeBeenden(raum, v.wer);
      jetztSpeichern(raum);                    // was er gesehen hat, ist damit auch gespeichert …
      if (!v.gast) gesehenVermerken(raum.noteId, v.userId); // … und gilt bei ihm als gesehen
    }
    if (!raum.verbindungen.size) raumSchliessen(raum);
    broadcast('notes-anwesend', null);
  };
  v.abbauen = abbauen;
  req.on('close', abbauen); res.on('close', abbauen); res.on('error', abbauen);
  return 200;
}

function verbindungFuer(noteId, verbindungId, wer) {
  const raum = raeume.get(noteId);
  const v = raum && raum.verbindungen.get(String(verbindungId || ''));
  return (v && v.wer === wer) ? { raum, v } : null;
}

/** Eine Änderung am Dokument übernehmen. `wer` = Nutzernummer oder 'g<Nummer>'. Liefert { status, fehler? }. */
function aenderung(noteId, wer, verbindungId, updateB64) {
  const treffer = verbindungFuer(noteId, verbindungId, wer);
  if (!treffer) return { status: 409, code: 'VERBINDUNG_WEG', fehler: 'Die Verbindung zur Notiz ist unterbrochen. Sie wird neu aufgebaut.' };
  const { raum, v } = treffer;
  const zugriff = zugriffVon(getDb(), noteId, wer);
  if (!darfSchreiben(zugriff)) {
    zugriffAbgleichen(noteId);
    return { status: 403, code: 'NUR_LESEN', fehler: 'Du darfst diese Notiz nur lesen.' };
  }
  const update = ausB64(updateB64);
  if (!update.length || update.length > GROESSTE_AENDERUNG) return { status: 413, code: 'ZU_GROSS', fehler: 'Diese Änderung ist zu groß (z. B. ein sehr langer eingefügter Text).' };
  // Erst an einer Kopie ausprobieren: Ist sie lesbar, und steht danach nur Erlaubtes im Dokument?
  // Ins echte Dokument (und zu den anderen) kommt sie nur dann — zurücknehmen lässt sich in Yjs nichts.
  const probe = new Y.Doc();
  let inOrdnung = false;
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(raum.doc));
    Y.applyUpdate(probe, update);
    inOrdnung = zulaessig(probe);
  } catch (_) {
    probe.destroy();
    return { status: 400, code: 'BESCHAEDIGT', fehler: 'Die Änderung war beschädigt und wurde nicht übernommen.' };
  }
  probe.destroy();
  if (!inOrdnung) return { status: 400, code: 'BESCHAEDIGT', fehler: 'Die Änderung enthielt etwas, das in einer Notiz nicht vorkommen kann, und wurde nicht übernommen.' };
  const vorher = inhalt(raum);
  Y.applyUpdate(raum.doc, update, v);
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
    raum.zuletztGeaendertVon = wer;
    raum.zuletztGeaendertName = v.gast ? v.name.replace(/ \(Gast\)$/, '') : null;
    rundeFortsetzen(raum, wer, vorher, v.name);
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
function anwesenheit(noteId, wer, verbindungId, updateB64) {
  const treffer = verbindungFuer(noteId, verbindungId, wer);
  if (!treffer) return { status: 409, code: 'VERBINDUNG_WEG', fehler: 'Die Verbindung zur Notiz ist unterbrochen.' };
  const { raum, v } = treffer;
  const update = ausB64(updateB64);
  // Cursor + Name passen in wenige hundert Bytes; mehr würde nur an alle anderen weitergereicht.
  if (!update.length || update.length > 4096) return { status: 413, fehler: 'Anwesenheit zu groß.' };
  let ids;
  try { ids = clientIdsIn(update); } catch (_) { return { status: 400, fehler: 'Ungültige Anwesenheit.' }; }
  // Eine Clientnummer gehört einer Verbindung. Übernehmen darf sie nur dieselbe Person (neu
  // aufgebaute Verbindung, deren alte noch nicht abgemeldet ist) — nie jemand anderes.
  for (const id of ids) {
    for (const x of raum.verbindungen.values()) {
      if (x !== v && x.clientIds.has(id)) {
        if (x.wer !== wer) return { status: 403, fehler: 'Ungültige Anwesenheit.' };
        x.clientIds.delete(id);
      }
    }
    v.clientIds.add(id);
  }
  try { awarenessProtocol.applyAwarenessUpdate(raum.aw, update, v); } catch (_) { return { status: 400, fehler: 'Ungültige Anwesenheit.' }; }
  // Name und Farbe setzt der Server — was der Browser mitschickt, zählt nicht.
  for (const id of ids) { const st = raum.aw.states.get(id); if (st) st.user = { name: v.name, color: v.farbe }; }
  anwesenheitAnAlle(raum, ids, v);
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
  const istProjektNotiz = !!(db.prepare('SELECT projekt_notiz_fuer FROM notes WHERE id = ?').get(raum.noteId) || {}).projekt_notiz_fuer;
  for (const v of [...raum.verbindungen.values()]) {
    const z = zugriffVon(db, raum.noteId, v.wer);
    if (z === undefined) rauswerfen(v, istProjektNotiz ? 'projekt-geloescht' : 'geloescht');
    else if (!z) rauswerfen(v, v.gast ? (notizGaeste.zugriff(db, v.gastId).grund || 'gast-entfernt') : 'freigabe-entzogen');
    else if (z !== v.zugriff) { v.zugriff = z; senden(v, 'zugriff', { zugriff: z }); }
  }
}

/** Alle offenen Notizen neu prüfen (z. B. nach einer Rollenänderung — sie entscheidet über Projektnotizen). */
function alleAbgleichen() { for (const raum of [...raeume.values()]) zugriffAbgleichen(raum.noteId); }

/** Einen Gast aus seiner Notiz werfen (entfernt, neues Passwort). */
function gastRauswerfen(gastId, grund) {
  for (const raum of [...raeume.values()]) {
    for (const v of [...raum.verbindungen.values()]) if (v.gast && v.gastId === Number(gastId)) rauswerfen(v, grund);
  }
}

/** Alle Gäste neu prüfen (Firmenschalter, Ablauf um Mitternacht, Eigentümer ausgestellt). */
function gaesteAbgleichen() {
  for (const raum of [...raeume.values()]) {
    if ([...raum.verbindungen.values()].some(v => v.gast)) zugriffAbgleichen(raum.noteId);
  }
}
// Ein Ablaufdatum endet um Mitternacht — auch für den, der gerade nur mitliest und nichts sendet.
const ABLAUF_PRUEFEN_MS = 60 * 1000;
setInterval(() => { try { gaesteAbgleichen(); } catch (e) { console.error('Gäste prüfen:', e.message); } }, ABLAUF_PRUEFEN_MS).unref();

/** Notiz gelöscht: alle raus, nichts mehr speichern. */
function notizGeloescht(noteId) {
  const raum = raeume.get(Number(noteId));
  if (!raum) return;
  clearTimeout(raum.speicherTimer); raum.speicherTimer = null;
  for (const r of raum.runden.values()) clearTimeout(r.timer);
  raum.runden.clear();
  for (const v of [...raum.verbindungen.values()]) rauswerfen(v, 'geloescht');
}

/**
 * Eine Sicherung wird zurückgespielt: Die offenen Notizen im Speicher stammen aus der ALTEN Datenbank.
 * Würden sie noch gespeichert, überschrieben sie die zurückgespielten Notizen. Deshalb alle Räume
 * schließen, OHNE zu speichern und ohne Meldungen, und alle Drinnen hinauswerfen. Muss aufgerufen
 * werden, BEVOR die neue Datenbank eingesetzt wird (routes/backup.js, einsetzen).
 */
function allesVerwerfen(grund = 'zurueckgespielt') {
  for (const raum of [...raeume.values()]) {
    raum.verworfen = true;
    clearTimeout(raum.speicherTimer); raum.speicherTimer = null;
    for (const r of raum.runden.values()) clearTimeout(r.timer);
    raum.runden.clear();
    for (const v of [...raum.verbindungen.values()]) rauswerfen(v, grund);
    if (raeume.get(raum.noteId) === raum) raumSchliessen(raum);
  }
}

/** Nutzer ausgestellt: aus allen Notizen raus — und die Gäste in SEINEN Notizen auch. */
function nutzerRauswerfen(userId) {
  for (const raum of [...raeume.values()]) {
    for (const v of [...raum.verbindungen.values()]) if (!v.gast && v.userId === userId) rauswerfen(v, 'abgemeldet');
  }
  gaesteAbgleichen();
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
  const absender = raum.verbindungen.get(String(verbindungId || ''));
  for (const v of raum.verbindungen.values()) if (v !== absender) senden(v, 'kopf', kopfFuer(v, kopf));
  if (vorher != null && vorher !== inhalt(raum)) rundeFortsetzen(raum, userId, vorher);
  return true;
}

/** Wer ist gerade in welcher Notiz? { noteId: [Namen] } — für die Liste. */
function anwesende() {
  const aus = {};
  for (const raum of raeume.values()) {
    aus[raum.noteId] = [...new Map([...raum.verbindungen.values()].map(v => [v.wer, v.name])).values()];
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
  gastRauswerfen, gaesteAbgleichen, alleAbgleichen, kopfVon,
  kopfGeaendert, inhaltVon, anwesende, offenerStand, allesSpeichern, allesVerwerfen, gesehenVermerken, zugriffVon, FARBEN,
  zeiten, _intern: { raeume } };
