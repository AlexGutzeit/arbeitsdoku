const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const role = req.user.role;
  const bulletinSince = req.query.bulletin_since || '2000-01-01 00:00:00';
  const notesSince    = req.query.notes_since    || '2000-01-01 00:00:00';

  const bulletin = db.prepare(
    "SELECT COUNT(*) as n FROM bulletin_entries WHERE updated_at > ? AND COALESCE(updated_by, created_by) != ?"
  ).get(bulletinSince, uid).n;

  const sharedNotes = db.prepare(`
    SELECT COUNT(DISTINCT id) as n FROM (
      SELECT n.id FROM notes n WHERE n.user_id = ? AND n.updated_at > ?
      UNION
      SELECT n.id FROM notes n
      JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = ?
      WHERE n.updated_at > ? OR ns.created_at > ?
    )
  `).get(uid, notesSince, uid, notesSince, notesSince).n;

  const offers = db.prepare(
    "SELECT COUNT(*) as n FROM note_offers WHERE to_user_id = ? AND status = 'pending'"
  ).get(uid).n;

  let orders = 0;
  if (role === 'chef') {
    orders = db.prepare(
      "SELECT COUNT(*) as n FROM orders WHERE ordered_at IS NULL"
    ).get().n;
  }

  res.json({ bulletin, notes: sharedNotes + offers, orders });
});

module.exports = router;
