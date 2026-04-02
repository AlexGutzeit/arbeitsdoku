const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Alle Projekte abrufen
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  res.json({ projects });
});

// Projekt erstellen (nur Chef/Admin)
router.post('/', authenticate, authorize('chef'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Projektname ist erforderlich' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name.trim());
  if (existing) {
    return res.status(409).json({ error: 'Projekt existiert bereits' });
  }

  const result = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ project });
});

// Projekt bearbeiten (nur Chef/Admin)
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

  const { name, address } = req.body;
  db.prepare('UPDATE projects SET name = ?, address = ? WHERE id = ?').run(
    name || project.name, address !== undefined ? address : (project.address || ''), req.params.id
  );
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json({ project: updated });
});

// Projekt löschen (nur Chef/Admin)
router.delete('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

  // Projektnamen in Einträgen, Planungen und Werkzeug-Checkouts sichern, bevor FK auf NULL gesetzt wird
  db.prepare(`UPDATE entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE planning_entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE tool_checkouts SET project_text = ?, project_id = NULL WHERE project_id = ?`).run(project.name, project.id);

  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
