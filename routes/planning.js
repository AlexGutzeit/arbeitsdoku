const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Alle Planungen abrufen (für alle User sichtbar)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const { date_from, date_to, project_id } = req.query;

  let sql = `
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (date_from) { sql += ' AND pe.date >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND pe.date <= ?'; params.push(date_to); }
  if (project_id) { sql += ' AND pe.project_id = ?'; params.push(Number(project_id)); }

  sql += ' ORDER BY pe.date ASC, pe.time_from ASC';

  const entries = db.prepare(sql).all(...params);

  // Zugewiesene User für jeden Eintrag laden
  const result = entries.map(e => {
    const assigned = db.prepare(`
      SELECT pa.user_id, u.name as user_name
      FROM planning_assignments pa
      JOIN users u ON pa.user_id = u.id
      WHERE pa.planning_id = ?
    `).all(e.id);
    return { ...e, assigned_users: assigned };
  });

  res.json({ entries: result });
});

// Einzelne Planung abrufen
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.id = ?
  `).get(req.params.id);

  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa
    JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(entry.id);

  res.json({ entry: { ...entry, assigned_users: assigned } });
});

// Planungsrecht prüfen: Chef/Admin immer, andere wenn can_plan gesetzt
function canPlan(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'chef' || req.user.can_plan) return next();
  return res.status(403).json({ error: 'Keine Berechtigung für Planung' });
}

// Planung erstellen
router.post('/', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const { date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, assigned_user_ids } = req.body;

  if (!date || !time_from || !time_to) {
    return res.status(400).json({ error: 'Datum, Von und Bis sind Pflichtfelder' });
  }
  if (!assigned_user_ids || !assigned_user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  }

  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, date, time_from, time_to, break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '');

    const planningId = result.lastInsertRowid;
    for (const userId of assigned_user_ids) {
      db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, userId);
    }
    return planningId;
  });

  const planningId = insert();

  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(planningId);
  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(planningId);

  res.status(201).json({ entry: { ...entry, assigned_users: assigned } });
});

// Planung bearbeiten (nur Chef/Admin)
router.put('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  const { date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, assigned_user_ids } = req.body;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE planning_entries SET date=?, time_from=?, time_to=?, break_minutes=?, address=?, client=?, project_id=?, project_text=?, description=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      date || entry.date, time_from || entry.time_from, time_to || entry.time_to,
      break_minutes !== undefined ? break_minutes : entry.break_minutes,
      address !== undefined ? address : entry.address,
      client !== undefined ? client : entry.client,
      project_id !== undefined ? (project_id || null) : entry.project_id,
      project_text !== undefined ? project_text : entry.project_text,
      description !== undefined ? description : entry.description,
      req.params.id
    );

    if (assigned_user_ids && assigned_user_ids.length) {
      db.prepare('DELETE FROM planning_assignments WHERE planning_id = ?').run(req.params.id);
      for (const userId of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(req.params.id, userId);
      }
    }
  });

  update();

  const updated = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe JOIN users u ON pe.created_by = u.id LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.id = ?
  `).get(req.params.id);
  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(req.params.id);

  res.json({ entry: { ...updated, assigned_users: assigned } });
});

// Planung löschen (nur Chef/Admin)
router.delete('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  db.prepare('DELETE FROM planning_entries WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
