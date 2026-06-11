const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function getSeenAt(db, userId, topic) {
  const row = db.prepare('SELECT seen_at FROM user_seen WHERE user_id = ? AND topic = ?').get(userId, topic);
  return row ? row.seen_at : '2000-01-01 00:00:00';
}

router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const role = req.user.role;

  const bulletinSince = getSeenAt(db, uid, 'bulletin');
  const notesSince    = getSeenAt(db, uid, 'notes');

  const bulletin = db.prepare(
    "SELECT COUNT(*) as n FROM bulletin_entries WHERE updated_at > ? AND COALESCE(updated_by, created_by) != ?"
  ).get(bulletinSince, uid).n;

  const sharedNotes = db.prepare(`
    SELECT COUNT(DISTINCT id) as n FROM (
      SELECT n.id FROM notes n
      WHERE n.user_id = ? AND n.updated_at > ? AND COALESCE(n.updated_by, n.user_id) != ?
      UNION
      SELECT n.id FROM notes n
      JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = ?
      WHERE (n.updated_at > ? AND COALESCE(n.updated_by, n.user_id) != ?) OR ns.created_at > ?
    )
  `).get(uid, notesSince, uid, uid, notesSince, uid, notesSince).n;

  const offers = db.prepare(
    "SELECT COUNT(*) as n FROM note_offers WHERE to_user_id = ? AND status = 'pending'"
  ).get(uid).n;

  let orders = 0;
  if (role === 'chef') {
    orders = db.prepare("SELECT COUNT(*) as n FROM orders WHERE ordered_at IS NULL").get().n;
  }

  // Abwesenheits-Badge für Chef/Admin/Buchhalter: neue Items zu bearbeiten
  let absences = 0;
  if (role !== 'mitarbeiter') {
    const absencesSince = getSeenAt(db, uid, 'absences');
    absences = db.prepare(`
      SELECT COUNT(*) as n FROM absences
      WHERE updated_at > ?
        AND deleted_at IS NULL
        AND (user_id IS NULL OR user_id != ?)
        AND COALESCE(created_by, user_id) != ?
        AND (processed_by IS NULL OR processed_by != ?)
        AND (
          status = 'pending'
          OR (status = 'active' AND type IN ('krank','berufsschule','innung')
              AND (notified_at IS NULL OR notified_at > ?))
        )
    `).get(absencesSince, uid, uid, uid, absencesSince).n;
  }

  // Alle Rollen: eigene Abwesenheiten mit ausstehender Bestätigung (Manager hat Änderungen vorgenommen)
  const maAckCount = db.prepare(
    'SELECT COUNT(*) as n FROM absences WHERE user_id = ? AND ma_needs_ack = 1 AND deleted_at IS NULL'
  ).get(uid).n;

  // MA: Status-Änderungen (genehmigt/abgelehnt) an eigenen Abwesenheiten seit letztem Besuch
  let maStatusCount = 0;
  if (role === 'mitarbeiter') {
    const statusSince = getSeenAt(db, uid, 'absence_status');
    maStatusCount = db.prepare(`
      SELECT COUNT(*) as n FROM absences
      WHERE user_id = ? AND updated_at > ? AND ma_needs_ack = 0
      AND deleted_at IS NULL
      AND (
        status IN ('approved','rejected')
        OR (status = 'pending' AND created_by IS NOT NULL AND created_by != user_id
            AND type IN ('urlaub','freizeitausgleich','sonderurlaub'))
      )
    `).get(uid, statusSince).n;
  }

  res.json({ bulletin, notes: sharedNotes + offers, orders, absences: absences + maAckCount + maStatusCount });
});

router.post('/:topic', authenticate, (req, res) => {
  const { topic } = req.params;
  if (!['bulletin', 'notes', 'absences', 'absence_status'].includes(topic)) return res.status(400).json({ error: 'Unbekanntes Topic' });
  const db = getDb();
  db.prepare(
    "INSERT INTO user_seen (user_id, topic, seen_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')) " +
    "ON CONFLICT(user_id, topic) DO UPDATE SET seen_at = strftime('%Y-%m-%d %H:%M:%f', 'now')"
  ).run(req.user.id, topic);
  res.json({ success: true });
});

module.exports = router;
