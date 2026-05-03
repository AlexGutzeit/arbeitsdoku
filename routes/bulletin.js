const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');

const router = express.Router();

function getSeenAt(db, userId, topic) {
  const row = db.prepare('SELECT seen_at FROM user_seen WHERE user_id = ? AND topic = ?').get(userId, topic);
  return row ? row.seen_at : '2000-01-01 00:00:00';
}

function canBulletin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'chef' || req.user.can_bulletin) return next();
  return res.status(403).json({ error: 'Keine Berechtigung' });
}

// Abgelaufene Einträge automatisch löschen
function cleanExpired(db) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('DELETE FROM bulletin_entries WHERE auto_delete_date IS NOT NULL AND auto_delete_date != \'\' AND auto_delete_date < ?').run(today);
}

// Alle Einträge abrufen (für alle sichtbar)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  cleanExpired(db);

  const entries = db.prepare(`
    SELECT b.*, u.name as author_name
    FROM bulletin_entries b
    JOIN users u ON b.created_by = u.id
    ORDER BY b.created_at DESC
  `).all();

  const uid = req.user.id;
  const since = getSeenAt(db, uid, 'bulletin');
  for (const e of entries) {
    e.is_unread = e.updated_at > since && (e.updated_by ?? e.created_by) !== uid;
  }

  res.json({ entries });
});

// Eintrag erstellen
router.post('/', authenticate, canBulletin, (req, res) => {
  const db = getDb();
  const { title, text, event_date, auto_delete_date } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Überschrift ist ein Pflichtfeld' });
  }

  const result = db.prepare(`
    INSERT INTO bulletin_entries (created_by, updated_by, title, text, event_date, auto_delete_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, req.user.id, title.trim(), text || '', event_date || null, auto_delete_date || null);

  const entry = db.prepare(`
    SELECT b.*, u.name as author_name
    FROM bulletin_entries b JOIN users u ON b.created_by = u.id
    WHERE b.id = ?
  `).get(result.lastInsertRowid);

  broadcast('bulletin', req.headers['x-tab-id']);
  res.status(201).json({ entry });
});

// Eintrag bearbeiten
router.put('/:id', authenticate, canBulletin, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM bulletin_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  const { title, text, event_date, auto_delete_date } = req.body;

  db.prepare(`
    UPDATE bulletin_entries SET title=?, text=?, event_date=?, auto_delete_date=?, updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(
    title !== undefined ? title.trim() : entry.title,
    text !== undefined ? text : entry.text,
    event_date !== undefined ? (event_date || null) : entry.event_date,
    auto_delete_date !== undefined ? (auto_delete_date || null) : entry.auto_delete_date,
    req.user.id,
    req.params.id
  );

  const updated = db.prepare(`
    SELECT b.*, u.name as author_name
    FROM bulletin_entries b JOIN users u ON b.created_by = u.id
    WHERE b.id = ?
  `).get(req.params.id);

  broadcast('bulletin', req.headers['x-tab-id']);
  res.json({ entry: updated });
});

// Eintrag löschen
router.delete('/:id', authenticate, canBulletin, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM bulletin_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  db.prepare('DELETE FROM bulletin_entries WHERE id = ?').run(req.params.id);
  broadcast('bulletin', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
