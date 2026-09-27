const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../database/init');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const { broadcast } = require('../sse');
const push = require('../push');
const live = require('../notizen-live');
const { zeileAusKlartext, zeileAusDelta } = require('../notiz-dokument');
const exporte = require('../notiz-export');

const router = express.Router();

// Spalten, die an Browser gehen. NIE `n.*`: `ydoc` ist das Yjs-Dokument als Binärdaten — als JSON
// würde daraus ein riesiges Zahlen-Objekt, und es gehört nur dem Live-Betrieb (notizen-live.js).
const SPALTEN = 'n.id, n.user_id, n.title, n.body, n.body_delta, n.project_id, n.project_text, n.created_at, n.updated_at, n.updated_by';

// Seit den Live-Notizen (26.09.2026) gibt es keine Bearbeitungs-Sperre und kein Speichern des
// ganzen Textes mehr. Ein noch nicht aktualisierter Programmstand würde beim Speichern aber genau
// das tun — und die Formatierung aller anderen mit Klartext überschreiben. Deshalb wird dieser
// Weg abgewiesen, mit einem Hinweis, der den Ausweg nennt.
const APP_VERALTET = {
  code: 'APP_VERALTET',
  error: 'Die App wurde aktualisiert. Bitte neu laden (oder „Jetzt aktualisieren" antippen), dann geht es weiter.',
};

function resolveProject(db, project_id, project_text) {
  if (project_id) {
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(project_id);
    if (p) return { project_id: Number(project_id), project_text: p.name };
  }
  return { project_id: null, project_text: (project_text || '').trim() };
}

function canAccessNote(db, noteId, userId) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  if (!note) return { note: null, access: null };
  if (note.user_id === userId) return { note, access: 'owner' };
  const share = db.prepare('SELECT permission FROM note_shares WHERE note_id = ? AND user_id = ?').get(noteId, userId);
  if (!share) return { note, access: null };
  return { note, access: share.permission };
}

function notizAusgeben(db, id) {
  return db.prepare(`SELECT ${SPALTEN}, u.name as owner_name FROM notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?`).get(id);
}

// --- Offers-Routen VOR /:id ---

// Eingehende Angebote (pending) fuer aktuellen User
router.get('/offers', authenticate, (req, res) => {
  const db = getDb();
  const offers = db.prepare(`
    SELECT no.*, n.title, n.body, n.project_text, u.name as from_user_name
    FROM note_offers no
    JOIN notes n ON no.note_id = n.id
    JOIN users u ON no.from_user_id = u.id
    WHERE no.to_user_id = ? AND no.status = 'pending'
    ORDER BY no.created_at DESC
  `).all(req.user.id);
  res.json({ offers });
});

// Angebot annehmen — legt beim Empfänger eine KOPIE an, das Original bleibt beim Absender.
router.post('/offers/:id/accept', authenticate, (req, res) => {
  const db = getDb();
  const offer = db.prepare('SELECT * FROM note_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.to_user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Angebot ist nicht mehr offen' });

  const note = db.prepare('SELECT title, body, body_delta, project_id, project_text FROM notes WHERE id = ?').get(offer.note_id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });

  // Ist die Notiz gerade offen, zählt der Stand von eben — nicht der letzte gespeicherte.
  const offen = live.offenerStand(offer.note_id);
  const kopie = zeileAusDelta(offen ? offen.body_delta : note.body_delta, offen ? offen.body : note.body);
  db.prepare(
    "INSERT INTO notes (user_id, title, body, body_delta, ydoc, project_id, project_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(req.user.id, note.title, kopie.body, kopie.body_delta, kopie.ydoc, note.project_id, note.project_text);
  db.prepare("UPDATE note_offers SET status = 'accepted' WHERE id = ?").run(offer.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Angebot ablehnen
router.post('/offers/:id/decline', authenticate, (req, res) => {
  const db = getDb();
  const offer = db.prepare('SELECT * FROM note_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.to_user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Angebot ist nicht mehr offen' });

  db.prepare("UPDATE note_offers SET status = 'declined' WHERE id = ?").run(offer.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Angebot zurueckziehen (Absender, nur solange pending)
router.delete('/offers/:id', authenticate, (req, res) => {
  const db = getDb();
  const offer = db.prepare('SELECT * FROM note_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.from_user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Angebot ist nicht mehr offen' });

  db.prepare('DELETE FROM note_offers WHERE id = ?').run(offer.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// --- Notes CRUD ---

// Alle sichtbaren Notizen (eigene + freigegebene)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const notes = db.prepare(`
    SELECT DISTINCT ${SPALTEN}, u.name as owner_name,
      CASE WHEN n.user_id = ? THEN 'owner'
           ELSE COALESCE(ns.permission, '') END as access_level,
      COALESCE(lu.name, u.name) as updated_by_name
    FROM notes n
    JOIN users u ON n.user_id = u.id
    LEFT JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = ?
    LEFT JOIN users lu ON n.updated_by = lu.id
    WHERE n.user_id = ? OR ns.user_id = ?
    ORDER BY n.updated_at DESC
  `).all(uid, uid, uid, uid);

  // Wer ist gerade in der Notiz? (ersetzt das frühere „🔒 gesperrt von …")
  const drin = live.anwesende();
  for (const n of notes) n.live = drin[n.id] || [];

  // Shares pro Notiz laden (Mitbearbeiter-Anzeige)
  if (notes.length) {
    const noteIds = notes.map(n => n.id);
    const placeholders = noteIds.map(() => '?').join(',');
    const shares = db.prepare(`
      SELECT ns.note_id, ns.user_id, ns.permission, ns.created_at, u.name as user_name
      FROM note_shares ns
      JOIN users u ON ns.user_id = u.id
      WHERE ns.note_id IN (${placeholders})
    `).all(...noteIds);

    const shareMap = {};
    for (const s of shares) {
      if (!shareMap[s.note_id]) shareMap[s.note_id] = [];
      shareMap[s.note_id].push(s);
    }
    for (const n of notes) {
      n.shares = shareMap[n.id] || [];
    }
  }

  const notesSince = (() => {
    const row = db.prepare('SELECT seen_at FROM user_seen WHERE user_id = ? AND topic = ?').get(uid, 'notes');
    return row ? row.seen_at : '2000-01-01 00:00:00';
  })();

  // Live gesehen (Notiz offen gehabt, während andere schrieben) zählt nicht als ungelesen — siehe badges.js.
  const gesehen = new Map(db.prepare('SELECT note_id, gesehen_am FROM note_gesehen WHERE user_id = ?').all(uid).map(g => [g.note_id, g.gesehen_am]));
  for (const n of notes) {
    const effectiveUpdater = n.updated_by ?? n.user_id;
    const neuSeitLive = n.updated_at > (gesehen.get(n.id) || '');
    if (n.user_id === uid) {
      n.is_unread = n.updated_at > notesSince && effectiveUpdater !== uid && neuSeitLive;
    } else {
      const share = (n.shares || []).find(s => s.user_id === uid);
      const shareNew = share ? share.created_at > notesSince : false;
      n.is_unread = (n.updated_at > notesSince && effectiveUpdater !== uid && neuSeitLive) || shareNew;
    }
  }

  res.json({ notes });
});

// Neue Notiz erstellen. `body` (Klartext) ist optional: Die neue Oberfläche legt die Notiz leer an
// und öffnet sie sofort live; ein älterer Programmstand schickt den Text gleich mit.
router.post('/', authenticate, (req, res) => {
  const { title, body, project_id, project_text } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }

  const db = getDb();
  const proj = resolveProject(db, project_id, project_text);
  const z = zeileAusKlartext((body || '').trim());
  const result = db.prepare(
    "INSERT INTO notes (user_id, updated_by, title, body, body_delta, ydoc, project_id, project_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(req.user.id, req.user.id, title.trim(), z.body, z.body_delta, z.ydoc, proj.project_id, proj.project_text);

  const note = notizAusgeben(db, result.lastInsertRowid);
  note.shares = [];
  note.live = [];
  broadcast('notes', req.headers['x-tab-id']);
  res.status(201).json({ note });
});

// Frühere Bearbeitungs-Sperre: gibt es nicht mehr. Ein alter Programmstand ruft sie vor dem
// Bearbeiten einer geteilten Notiz auf — er bekommt den Hinweis, neu zu laden, BEVOR er tippt.
router.post('/:id/lock', authenticate, (req, res) => res.status(409).json(APP_VERALTET));
// Das Freigeben ruft ein alter Stand beim Abbrechen und beim Schließen auf — harmlos bestätigen.
router.post('/:id/unlock', authenticate, (req, res) => res.json({ success: true }));

// Titel und Projekt ändern (Owner oder Write-Share). Der Text selbst läuft über den Live-Betrieb.
router.put('/:id', authenticate, (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'body')) return res.status(409).json(APP_VERALTET);
  const db = getDb();
  const { note, access } = canAccessNote(db, req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (!access || access === 'read') return res.status(403).json({ error: 'Keine Berechtigung' });

  const { title, project_id, project_text, verbindung } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }

  const proj = resolveProject(db, project_id, project_text);

  // Hat sich ueberhaupt etwas geaendert? Nur hineinschauen soll WEDER eine Meldung ausloesen NOCH
  // den Zaehler hochsetzen (Alex, 18.08.2026) — der Zaehler haengt an `updated_at`/`updated_by`.
  const gleich = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));
  const unveraendert = gleich(note.title, title.trim())
    && gleich(note.project_id, proj.project_id)
    && gleich(note.project_text, proj.project_text);
  if (unveraendert) return res.json({ note: notizAusgeben(db, req.params.id), unchanged: true });

  const vorher = live.inhaltVon(note.id);
  db.prepare(
    "UPDATE notes SET title = ?, project_id = ?, project_text = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ? WHERE id = ?"
  ).run(title.trim(), proj.project_id, proj.project_text, req.user.id, req.params.id);

  const updated = notizAusgeben(db, req.params.id);
  live.gesehenVermerken(note.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ note: updated });

  // In der offenen Notiz gehört die Umbenennung zur Bearbeitungsrunde (eine Meldung am Ende).
  // Ist niemand drin, wird wie früher sofort gemeldet — an Eigentümer und Mitleser, nicht an
  // den Bearbeiter selbst.
  const kopf = { title: updated.title, project_id: updated.project_id, project_text: updated.project_text };
  if (live.kopfGeaendert(note.id, kopf, verbindung, req.user.id, vorher)) return;
  const empfaenger = [
    note.user_id,
    ...db.prepare('SELECT user_id FROM note_shares WHERE note_id = ?').all(req.params.id).map(r => r.user_id),
  ];
  const bearbeiter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  push.notifyUsers(db, empfaenger, 'notes', {
    title: 'Notiz bearbeitet',
    body: `${bearbeiter ? bearbeiter.name : 'Jemand'} hat „${updated.title}" bearbeitet`,
    url: '/#/notes',
  }, req.user.id);
});

// Notiz loeschen (nur Owner). Wer gerade drin ist, fliegt sofort raus.
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann löschen' });

  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  // Abhängiges ausdrücklich mitlöschen. Heute erledigt das auch ON DELETE CASCADE (die Gegenprobe
  // ohne diese Zeile bleibt grün) — aber am Prod-Klon standen 17 Freigaben zu gelöschten Notizen aus
  // früherer Zeit. Das Netz kostet nichts.
  for (const t of ['note_shares', 'note_offers', 'note_gesehen']) db.prepare(`DELETE FROM ${t} WHERE note_id = ?`).run(req.params.id);
  live.notizGeloescht(req.params.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Empfaenger verlaesst eine geteilte Notiz (entfernt die EIGENE Freigabe). Der Eigentuemer sieht danach
// den Haken leer und kann durch erneutes Anhaken (PUT /:id/shares) wieder hinzufuegen.
router.delete('/:id/share/self', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id === req.user.id) {
    return res.status(400).json({ error: 'Als Eigentümer kannst du die Notiz löschen, nicht verlassen.' });
  }
  const r = db.prepare('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Für dich besteht keine Freigabe dieser Notiz.' });
  live.zugriffAbgleichen(req.params.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// --- Sharing ---

// Aktuelle Freigaben abrufen
router.get('/:id/shares', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT user_id FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann Freigaben verwalten' });

  const shares = db.prepare(`
    SELECT ns.user_id, ns.permission, u.name as user_name
    FROM note_shares ns
    JOIN users u ON ns.user_id = u.id
    WHERE ns.note_id = ?
  `).all(req.params.id);
  res.json({ shares });
});

// Freigabe-Matrix komplett ersetzen
router.put('/:id/shares', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT id, user_id, title FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann Freigaben verwalten' });

  const { shares } = req.body;
  if (!Array.isArray(shares)) return res.status(400).json({ error: 'shares muss ein Array sein' });

  // Vorher bestehende Empfaenger merken, um nur NEU hinzugekommene zu benachrichtigen.
  const prevShareIds = new Set(
    db.prepare('SELECT user_id FROM note_shares WHERE note_id = ?').all(note.id).map(r => r.user_id)
  );

  db.prepare('DELETE FROM note_shares WHERE note_id = ?').run(note.id);

  const insert = db.prepare("INSERT INTO note_shares (note_id, user_id, permission, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))");
  const newlyAdded = [];
  for (const s of shares) {
    if (!s.user_id || s.user_id === note.user_id) continue;
    const perm = s.permission === 'write' ? 'write' : 'read';
    insert.run(note.id, s.user_id, perm);
    if (!prevShareIds.has(s.user_id)) newlyAdded.push(s.user_id);
  }

  // Wer drin ist und sein Recht verloren hat, fliegt jetzt raus; Schreiben ↔ Lesen gilt sofort.
  live.zugriffAbgleichen(note.id);

  const updated = db.prepare(`
    SELECT ns.user_id, ns.permission, u.name as user_name
    FROM note_shares ns
    JOIN users u ON ns.user_id = u.id
    WHERE ns.note_id = ?
  `).all(note.id);
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ shares: updated });

  if (newlyAdded.length) {
    const sharer = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    push.notifyUsers(db, newlyAdded, 'notes', {
      title: 'Notiz geteilt',
      body: `${sharer ? sharer.name : 'Jemand'} hat „${note.title}" mit dir geteilt`,
      url: '/#/notes',
    }, req.user.id);
  }
});

// --- Weitergeben ---

// Notiz an User anbieten
router.post('/:id/offer', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT id, user_id, title FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann weitergeben' });

  const { user_ids } = req.body;
  if (!Array.isArray(user_ids) || !user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Empfänger erforderlich' });
  }

  const insert = db.prepare(
    "INSERT INTO note_offers (note_id, from_user_id, to_user_id) VALUES (?, ?, ?) " +
    "ON CONFLICT(note_id, to_user_id) DO UPDATE SET status = 'pending', from_user_id = excluded.from_user_id, created_at = strftime('%Y-%m-%d %H:%M:%f', 'now')"
  );
  const offered = [];
  for (const uid of user_ids) {
    if (uid === req.user.id) continue;
    insert.run(note.id, req.user.id, uid);
    offered.push(uid);
  }

  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });

  if (offered.length) {
    const from = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    push.notifyUsers(db, offered, 'notes', {
      title: 'Notiz angeboten',
      body: `${from ? from.name : 'Jemand'} bietet dir „${note.title}" an`,
      url: '/#/notes',
    }, req.user.id);
  }
});

// --- Drucken und „Speichern als" (Etappe B, siehe notiz-export.js) ---

// Stand einer Notiz: Ist sie gerade offen, der von eben (auch noch nicht gespeichert), sonst der gespeicherte.
function aktuellerStand(db, id) {
  const n = db.prepare('SELECT id, user_id, title, body, body_delta, project_id, project_text FROM notes WHERE id = ?').get(id);
  if (!n) return null;
  const offen = live.offenerStand(id);
  return offen ? { ...n, body: offen.body, body_delta: offen.body_delta } : n;
}

// Dateiname für den Kopf: UTF-8 in filename*, dazu eine ASCII-Fassung für alte Programme.
// (Ein „ä" oder „–" direkt in filename="…" lässt Node gar nicht erst durch.)
function anhang(res, name) {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

// Notiz als PDF, Word oder OpenDocument — für jeden mit Zugriff, auch mit Leserecht (Alex, 26.09.2026).
router.get('/:id/export/:format', authenticate, async (req, res) => {
  const format = exporte.FORMATE[req.params.format];
  if (!format) return res.status(404).json({ error: 'Unbekanntes Format' });
  const db = getDb();
  const { note, access } = canAccessNote(db, req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (!access) return res.status(403).json({ error: 'Keine Berechtigung' });
  const n = aktuellerStand(db, note.id);
  const jetzt = new Date();
  try {
    const datei = await format.bauen({ titel: n.title, deltaJson: n.body_delta, klartext: n.body, stand: exporte.standText(jetzt), jetzt });
    res.setHeader('Content-Type', format.typ);
    anhang(res, exporte.dateiname(n.title, req.params.format, jetzt));
    res.send(datei);
  } catch (e) {
    console.error('Notiz-Export fehlgeschlagen:', e);
    res.status(500).json({ error: 'Die Datei konnte nicht erstellt werden.' });
  }
});

// „Stand als eigene Notiz": Kopie des Stands von eben, gehört dem, der klickt — für jeden mit
// Zugriff, auch mit Leserecht (Alex, 26.09.2026: wirkt wie ein Ausdruck). Projekt wird übernommen,
// Freigaben nicht. Aus der Formatierung neu gebaut, ohne den Bearbeitungsverlauf des Originals.
router.post('/:id/kopie', authenticate, (req, res) => {
  const db = getDb();
  const { note, access } = canAccessNote(db, req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (!access) return res.status(403).json({ error: 'Keine Berechtigung' });
  const n = aktuellerStand(db, note.id);
  const kopie = zeileAusDelta(n.body_delta, n.body);
  const projekt = n.project_id && db.prepare('SELECT id FROM projects WHERE id = ?').get(n.project_id) ? n.project_id : null;
  const titel = `${n.title} (Stand ${exporte.standText()})`;
  const r = db.prepare(
    "INSERT INTO notes (user_id, updated_by, title, body, body_delta, ydoc, project_id, project_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(req.user.id, req.user.id, titel, kopie.body, kopie.body_delta, kopie.ydoc, projekt, n.project_text || '');
  const neu = notizAusgeben(db, r.lastInsertRowid);
  neu.shares = []; neu.live = [];
  broadcast('notes', req.headers['x-tab-id']);
  res.status(201).json({ note: neu });
});

// --- Live-Betrieb (siehe notizen-live.js) ---

// Ereignisstrom einer geöffneten Notiz. Ein EventSource kann keinen Authorization-Header senden,
// deshalb — wie beim allgemeinen Live-Strom (/api/events) — das 60-Sekunden-Ticket aus
// /api/events/ticket in der Adresse. Anders als dort NUR das Ticket: Der lange Anmelde-Token hat
// in Adressen nichts verloren, und alte Programmstände kennen diesen Weg ohnehin nicht.
router.get('/:id/live', (req, res) => {
  let nutzerId;
  try {
    const t = jwt.verify(String(req.query.ticket || ''), JWT_SECRET);
    if (!t.sse || t.pending2fa) throw new Error('kein Ticket');
    nutzerId = t.userId;
  } catch (_) { return res.status(401).json({ error: 'Nicht angemeldet' }); }
  const db = getDb();
  const nutzer = db.prepare('SELECT id, name, COALESCE(active,1) AS active FROM users WHERE id = ?').get(nutzerId);
  if (!nutzer || nutzer.active === 0) return res.status(401).json({ error: 'Nicht angemeldet' });
  const status = live.verbinden(Number(req.params.id), nutzer, req, res);
  if (status === 404) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (status === 403) return res.status(403).json({ error: 'Keine Berechtigung' });
});

function liveAntwort(res, erg) {
  if (erg.status === 200) return res.json({ success: true });
  res.status(erg.status).json({ error: erg.fehler, ...(erg.code ? { code: erg.code } : {}) });
}

// Änderung am Text (Yjs-Update, base64). Das Schreibrecht prüft notizen-live.js bei JEDER Sendung.
router.post('/:id/live/aenderung', authenticate, (req, res) => {
  const { verbindung, update } = req.body || {};
  liveAntwort(res, live.aenderung(Number(req.params.id), req.user.id, verbindung, update));
});

// Cursor und Anwesenheit (y-protocols, base64) — auch mit Leserecht.
router.post('/:id/live/anwesenheit', authenticate, (req, res) => {
  const { verbindung, update } = req.body || {};
  liveAntwort(res, live.anwesenheit(Number(req.params.id), req.user.id, verbindung, update));
});

module.exports = router;
