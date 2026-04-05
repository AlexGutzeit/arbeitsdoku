const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

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

// --- Offers-Routen VOR /:id ---

// Eingehende Angebote (pending) für aktuellen User
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

// Angebot annehmen
router.post('/offers/:id/accept', authenticate, (req, res) => {
  const db = getDb();
  const offer = db.prepare('SELECT * FROM note_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.to_user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Angebot ist nicht mehr offen' });

  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(offer.note_id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });

  const insert = db.prepare(
    "INSERT INTO notes (user_id, title, body, project_id, project_text) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run(req.user.id, note.title, note.body, note.project_id, note.project_text);
  db.prepare("UPDATE note_offers SET status = 'accepted' WHERE id = ?").run(offer.id);
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
  res.json({ success: true });
});

// Angebot zurückziehen (Absender, nur solange pending)
router.delete('/offers/:id', authenticate, (req, res) => {
  const db = getDb();
  const offer = db.prepare('SELECT * FROM note_offers WHERE id = ?').get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.from_user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (offer.status !== 'pending') return res.status(400).json({ error: 'Angebot ist nicht mehr offen' });

  db.prepare('DELETE FROM note_offers WHERE id = ?').run(offer.id);
  res.json({ success: true });
});

// --- Notes CRUD ---

// Alle sichtbaren Notizen (eigene + freigegebene)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const notes = db.prepare(`
    SELECT DISTINCT n.*, u.name as owner_name,
      CASE WHEN n.user_id = ? THEN 'owner'
           ELSE COALESCE(ns.permission, '') END as access_level
    FROM notes n
    JOIN users u ON n.user_id = u.id
    LEFT JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = ?
    WHERE n.user_id = ? OR ns.user_id = ?
    ORDER BY n.updated_at DESC
  `).all(uid, uid, uid, uid);

  // Shares pro Notiz laden (Mitbearbeiter-Anzeige)
  if (notes.length) {
    const noteIds = notes.map(n => n.id);
    const placeholders = noteIds.map(() => '?').join(',');
    const shares = db.prepare(`
      SELECT ns.note_id, ns.user_id, ns.permission, u.name as user_name
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
  } else {
    // no notes
  }

  res.json({ notes });
});

// Neue Notiz erstellen
router.post('/', authenticate, (req, res) => {
  const { title, body, project_id, project_text } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }

  const db = getDb();
  const proj = resolveProject(db, project_id, project_text);
  const result = db.prepare(
    'INSERT INTO notes (user_id, title, body, project_id, project_text) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, title.trim(), (body || '').trim(), proj.project_id, proj.project_text);

  const note = db.prepare('SELECT n.*, u.name as owner_name FROM notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?')
    .get(result.lastInsertRowid);
  note.shares = [];
  res.status(201).json({ note });
});

// Notiz bearbeiten (Owner oder Write-Share)
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const { note, access } = canAccessNote(db, req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (!access || access === 'read') return res.status(403).json({ error: 'Keine Berechtigung' });

  const { title, body, project_id, project_text } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Titel ist erforderlich' });
  }

  const proj = resolveProject(db, project_id, project_text);
  db.prepare(
    "UPDATE notes SET title = ?, body = ?, project_id = ?, project_text = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title.trim(), (body || '').trim(), proj.project_id, proj.project_text, req.params.id);

  const updated = db.prepare('SELECT n.*, u.name as owner_name FROM notes n JOIN users u ON n.user_id = u.id WHERE n.id = ?')
    .get(req.params.id);
  res.json({ note: updated });
});

// Notiz löschen (nur Owner)
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann löschen' });

  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Sharing ---

// Aktuelle Freigaben abrufen
router.get('/:id/shares', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
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
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann Freigaben verwalten' });

  const { shares } = req.body;
  if (!Array.isArray(shares)) return res.status(400).json({ error: 'shares muss ein Array sein' });

  db.prepare('DELETE FROM note_shares WHERE note_id = ?').run(note.id);

  const insert = db.prepare('INSERT INTO note_shares (note_id, user_id, permission) VALUES (?, ?, ?)');
  for (const s of shares) {
    if (!s.user_id || s.user_id === note.user_id) continue;
    const perm = s.permission === 'write' ? 'write' : 'read';
    insert.run(note.id, s.user_id, perm);
  }

  const updated = db.prepare(`
    SELECT ns.user_id, ns.permission, u.name as user_name
    FROM note_shares ns
    JOIN users u ON ns.user_id = u.id
    WHERE ns.note_id = ?
  `).all(note.id);
  res.json({ shares: updated });
});

// --- Weitergeben ---

// Notiz an User anbieten
router.post('/:id/offer', authenticate, (req, res) => {
  const db = getDb();
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Nur der Eigentümer kann weitergeben' });

  const { user_ids } = req.body;
  if (!Array.isArray(user_ids) || !user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Empfänger erforderlich' });
  }

  const insert = db.prepare('INSERT OR IGNORE INTO note_offers (note_id, from_user_id, to_user_id) VALUES (?, ?, ?)');
  for (const uid of user_ids) {
    if (uid === req.user.id) continue;
    insert.run(note.id, req.user.id, uid);
  }

  res.json({ success: true });
});

module.exports = router;
