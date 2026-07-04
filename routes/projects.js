const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');

const router = express.Router();

const URGENCIES = ['gruen', 'gelb', 'orange', 'rot'];
const normUrgency = (u) => URGENCIES.includes(u) ? u : 'gelb';

// „Zugedachte" Mitarbeiter eines Projekts als [{user_id, name}]
function assignmentsOf(db, projectId) {
  return db.prepare(`
    SELECT pa.user_id, u.name
    FROM project_assignments pa JOIN users u ON u.id = pa.user_id
    WHERE pa.project_id = ? ORDER BY u.name
  `).all(projectId);
}
const withAssignments = (db, project) => ({ ...project, assigned_users: assignmentsOf(db, project.id) });

function setAssignments(db, projectId, userIds) {
  db.prepare('DELETE FROM project_assignments WHERE project_id = ?').run(projectId);
  const ins = db.prepare('INSERT OR IGNORE INTO project_assignments (project_id, user_id) VALUES (?, ?)');
  const seen = new Set();
  for (const uid of (Array.isArray(userIds) ? userIds : [])) {
    const n = Number(uid);
    if (n > 0 && !seen.has(n)) { seen.add(n); ins.run(projectId, n); }
  }
}

// Board: alle Projekte (für ALLE Rollen sichtbar). ?done=1 → Archiv, sonst offene.
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const done = req.query.done === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM projects WHERE COALESCE(done, 0) = ? ORDER BY name').all(done);
  res.json({ projects: rows.map(p => withAssignments(db, p)) });
});

// Einzelnes Projekt (für Übernehmen-Vorbefüllung)
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  res.json({ project: withAssignments(db, project) });
});

// Projekt/Auftrag erstellen (nur Chef/Admin)
router.post('/', authenticate, authorize('chef'), (req, res) => {
  const { name, client, address, note, urgency, assigned_user_ids } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Projektname ist erforderlich' });
  const db = getDb();
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name.trim());
  if (existing) return res.status(409).json({ error: 'Projekt existiert bereits' });
  const r = db.prepare(
    "INSERT INTO projects (name, client, address, note, urgency, done, created_by) VALUES (?, ?, ?, ?, ?, 0, ?)"
  ).run(name.trim(), (client || '').trim(), (address || '').trim(), (note || '').trim(), normUrgency(urgency), req.user.id);
  setAssignments(db, r.lastInsertRowid, assigned_user_ids);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
  broadcast('projects', req.headers['x-tab-id']);
  res.status(201).json({ project: withAssignments(db, project) });
});

// Projekt bearbeiten (nur Chef/Admin)
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const { name, client, address, note, urgency, assigned_user_ids } = req.body;
  if (name !== undefined && name.trim() && name.trim() !== project.name) {
    const clash = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ?').get(name.trim(), project.id);
    if (clash) return res.status(409).json({ error: 'Projekt existiert bereits' });
  }
  db.prepare('UPDATE projects SET name = ?, client = ?, address = ?, note = ?, urgency = ? WHERE id = ?').run(
    name !== undefined && name.trim() ? name.trim() : project.name,
    client !== undefined ? (client || '').trim() : (project.client || ''),
    address !== undefined ? (address || '').trim() : (project.address || ''),
    note !== undefined ? (note || '').trim() : (project.note || ''),
    urgency !== undefined ? normUrgency(urgency) : (project.urgency || 'gelb'),
    project.id
  );
  if (assigned_user_ids !== undefined) setAssignments(db, project.id, assigned_user_ids);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ project: withAssignments(db, updated) });
});

// Als erledigt markieren (verschwindet vom Board, bleibt archiviert) — nur Chef/Admin
router.post('/:id/done', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  db.prepare("UPDATE projects SET done = 1, done_at = strftime('%Y-%m-%d %H:%M:%f','now'), done_by = ? WHERE id = ?").run(req.user.id, project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Wieder öffnen — nur Chef/Admin
router.post('/:id/reopen', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  db.prepare('UPDATE projects SET done = 0, done_at = NULL, done_by = NULL WHERE id = ?').run(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Projekt löschen (nur Chef/Admin) — Projektname VOR dem Löschen in die Freitexte sichern,
// damit vorhandene Planungen/Zeitnachweise/Notizen/Werkzeuge ihre Daten behalten.
router.delete('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });

  db.prepare(`UPDATE entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE planning_entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE tool_checkouts SET project_text = ?, project_id = NULL WHERE project_id = ?`).run(project.name, project.id);
  db.prepare(`UPDATE orders SET project_id = NULL WHERE project_id = ?`).run(project.id);
  db.prepare(`UPDATE notes SET project_text = ?, project_id = NULL WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);

  db.prepare('DELETE FROM project_assignments WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
