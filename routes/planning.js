const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');

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

// Alle Einträge einer Gruppe laden (MUSS vor /:id stehen!)
router.get('/group/:groupId', authenticate, (req, res) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.group_id = ?
    ORDER BY pe.date ASC
  `).all(req.params.groupId);

  if (!entries.length) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  // Assigned users vom ersten Eintrag (sind für alle gleich)
  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa
    JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(entries[0].id);

  res.json({ entries, assigned_users: assigned });
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

// Planung erstellen (einzeln oder Gruppe)
router.post('/', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const { days, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  // Rückwärtskompatibel: einzelner Eintrag (altes Format)
  if (req.body.date) {
    const { date, time_from, time_to, break_minutes } = req.body;
    if (!date || !time_from || !time_to) {
      return res.status(400).json({ error: 'Datum, Von und Bis sind Pflichtfelder' });
    }
    if (!assigned_user_ids || !assigned_user_ids.length) {
      return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
    }

    const insert = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, date, time_from, time_to, break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', color || '#f59e0b');

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

    broadcast('planning', req.headers['x-tab-id']);
    return res.status(201).json({ entry: { ...entry, assigned_users: assigned } });
  }

  // Neues Format: Mehrfach-Einträge mit days[]
  if (!days || !days.length) {
    return res.status(400).json({ error: 'Mindestens ein Tag ist erforderlich' });
  }
  if (!assigned_user_ids || !assigned_user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  }

  const groupId = days.length > 1 ? crypto.randomUUID() : null;

  const insert = db.transaction(() => {
    const ids = [];
    for (const day of days) {
      if (!day.date || !day.time_from || !day.time_to) continue;
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', groupId, color || '#f59e0b');

      const planningId = result.lastInsertRowid;
      for (const userId of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, userId);
      }
      ids.push(planningId);
    }
    return ids;
  });

  const ids = insert();
  broadcast('planning', req.headers['x-tab-id']);
  res.status(201).json({ success: true, count: ids.length, group_id: groupId });
});

// Gruppe aktualisieren (alle Tage ersetzen) — MUSS vor /:id stehen!
router.put('/group/:groupId', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const { days, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  if (!days || !days.length) {
    return res.status(400).json({ error: 'Mindestens ein Tag ist erforderlich' });
  }
  if (!assigned_user_ids || !assigned_user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  }

  const groupId = req.params.groupId;

  const update = db.transaction(() => {
    // Alte Einträge der Gruppe löschen (CASCADE löscht auch assignments)
    db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(groupId);

    // Entscheide ob weiterhin Gruppe oder Einzeleintrag
    const newGroupId = days.length > 1 ? groupId : null;

    const ids = [];
    for (const day of days) {
      if (!day.date || !day.time_from || !day.time_to) continue;
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', newGroupId, color || '#f59e0b');

      const planningId = result.lastInsertRowid;
      for (const uid of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, uid);
      }
      ids.push(planningId);
    }
    return ids;
  });

  const ids = update();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true, count: ids.length, group_id: days.length > 1 ? groupId : null });
});

// Planung bearbeiten (einzeln)
router.put('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  const { date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE planning_entries SET date=?, time_from=?, time_to=?, break_minutes=?, address=?, client=?, project_id=?, project_text=?, description=?, color=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      date || entry.date, time_from || entry.time_from, time_to || entry.time_to,
      break_minutes !== undefined ? break_minutes : entry.break_minutes,
      address !== undefined ? address : entry.address,
      client !== undefined ? client : entry.client,
      project_id !== undefined ? (project_id || null) : entry.project_id,
      project_text !== undefined ? project_text : entry.project_text,
      description !== undefined ? description : entry.description,
      color !== undefined ? color : (entry.color || '#f59e0b'),
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

  broadcast('planning', req.headers['x-tab-id']);
  res.json({ entry: { ...updated, assigned_users: assigned } });
});

// Gruppe löschen — MUSS vor /:id stehen!
router.delete('/group/:groupId', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(req.params.groupId);
  if (result.changes === 0) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Planung löschen (einzeln oder Gruppe)
router.delete('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  // Wenn Gruppeneintrag: gesamte Gruppe löschen
  if (entry.group_id) {
    db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(entry.group_id);
  } else {
    db.prepare('DELETE FROM planning_entries WHERE id = ?').run(req.params.id);
  }
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
