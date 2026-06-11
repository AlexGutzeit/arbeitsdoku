const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Audit-Log einsehen (nur Admin). Paginiert, neueste zuerst.
router.get('/', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const action = typeof req.query.action === 'string' ? req.query.action : '';

  let where = '';
  const params = [];
  if (action) { where = 'WHERE a.action = ?'; params.push(action); }

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs a ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT a.id, a.ts, a.user_id, a.username, a.action, a.details, a.ip, u.name as user_name
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    ${where}
    ORDER BY a.ts DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ logs: rows, total, limit, offset });
});

module.exports = router;
