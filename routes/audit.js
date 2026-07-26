const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const { csvZelle, csvDatei } = require('../csv');

const router = express.Router();

// Gemeinsame WHERE-Klausel fuer Filter (action + Datumsbereich from/to). Parametrisiert.
function buildWhere(q) {
  const where = [];
  const params = [];
  if (typeof q.action === 'string' && q.action) { where.push('a.action = ?'); params.push(q.action); }
  if (typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('a.ts >= ?'); params.push(q.from); }
  if (typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('a.ts <= ?'); params.push(q.to + ' 23:59:59'); }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// Audit-Log einsehen (nur Admin). Paginiert, neueste zuerst, optional gefiltert.
router.get('/', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { clause, params } = buildWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs a ${clause}`).get(...params).c;
  const rows = db.prepare(`
    SELECT a.id, a.ts, a.user_id, a.username, a.action, a.details, a.ip, u.name as user_name
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    ${clause}
    ORDER BY a.ts DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ logs: rows, total, limit, offset });
});

// CSV-Export ALLER passenden Eintraege (gefiltert, ohne Limit) — fuers Archiv. Nur Admin.
router.get('/export', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const { clause, params } = buildWhere(req.query);
  const rows = db.prepare(`
    SELECT a.ts, a.action, a.username, u.name as user_name, a.details, a.ip
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    ${clause}
    ORDER BY a.ts DESC, a.id DESC
  `).all(...params);

  const cell = csvZelle;   // gemeinsame Konvention, siehe csv.js
  const header = ['Zeit', 'Aktion', 'Benutzername', 'Name', 'Details', 'IP'].map(cell).join(';');
  const lines = rows.map(r => [r.ts, r.action, r.username, r.user_name, r.details, r.ip].map(cell).join(';'));
  const csv = csvDatei([header, ...lines]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

module.exports = router;
