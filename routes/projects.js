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
// Zwischenziele eines Projekts (für den Fortschrittsbalken)
function milestonesOf(db, projectId) {
  return db.prepare('SELECT id, title, est_days, status, sort_order FROM project_milestones WHERE project_id = ? ORDER BY sort_order, id').all(projectId);
}
const withDetails = (db, project) => ({ ...project, assigned_users: assignmentsOf(db, project.id), milestones: milestonesOf(db, project.id) });

function isAssigned(db, projectId, userId) {
  return !!db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}

const MS_STATUS = ['offen', 'doing', 'done'];

// Zwischenziele setzen (aus POST/PUT, Chef). Merge nach id: vorhandene id → UPDATE (Status BLEIBT erhalten),
// ohne id → INSERT (status 'offen'), fehlende ids → DELETE. Leere Titel werden übersprungen.
function setMilestones(db, projectId, arr) {
  if (!Array.isArray(arr)) return;
  const existing = db.prepare('SELECT id FROM project_milestones WHERE project_id = ?').all(projectId).map(r => r.id);
  const keep = new Set();
  const upd = db.prepare('UPDATE project_milestones SET title = ?, est_days = ?, sort_order = ? WHERE id = ? AND project_id = ?');
  const ins = db.prepare("INSERT INTO project_milestones (project_id, title, est_days, status, sort_order) VALUES (?, ?, ?, 'offen', ?)");
  let order = 0;
  for (const m of arr) {
    const title = (m && m.title != null ? String(m.title) : '').trim();
    if (!title) continue;
    const days = Number(m && m.est_days);
    const est = (isFinite(days) && days >= 0) ? days : 1;
    const id = Number(m && m.id);
    if (id && existing.includes(id)) { upd.run(title, est, order, id, projectId); keep.add(id); }
    else { ins.run(projectId, title, est, order); }
    order++;
  }
  for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM project_milestones WHERE id = ?').run(id);
}

function setAssignments(db, projectId, userIds) {
  db.prepare('DELETE FROM project_assignments WHERE project_id = ?').run(projectId);
  const ins = db.prepare('INSERT OR IGNORE INTO project_assignments (project_id, user_id) VALUES (?, ?)');
  const seen = new Set();
  for (const uid of (Array.isArray(userIds) ? userIds : [])) {
    const n = Number(uid);
    if (n > 0 && !seen.has(n)) { seen.add(n); ins.run(projectId, n); }
  }
}

// Board: alle NICHT gelöschten Projekte (für ALLE Rollen sichtbar). ?done=1 → Archiv, sonst offene.
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const done = req.query.done === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL AND COALESCE(done, 0) = ? ORDER BY name').all(done);
  res.json({ projects: rows.map(p => withDetails(db, p)) });
});

// Papierkorb: gelöschte Projekte (nur Chef/Admin). MUSS vor GET /:id stehen.
router.get('/deleted', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, du.name AS deleted_by_name
    FROM projects p LEFT JOIN users du ON du.id = p.deleted_by
    WHERE p.deleted_at IS NOT NULL
    ORDER BY p.deleted_at DESC
  `).all();
  res.json({ projects: rows.map(p => withDetails(db, p)) });
});

// Einzelnes Projekt (für Übernehmen-Vorbefüllung) — nur aktive.
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  res.json({ project: withDetails(db, project) });
});

// Projekt/Auftrag erstellen (nur Chef/Admin)
router.post('/', authenticate, authorize('chef'), (req, res) => {
  const { name, client, address, note, urgency, assigned_user_ids } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Projektname ist erforderlich' });
  const db = getDb();
  const existing = db.prepare('SELECT id, deleted_at FROM projects WHERE name = ?').get(name.trim());
  if (existing) return res.status(409).json({ error: existing.deleted_at ? 'Ein gleichnamiges Projekt liegt im Papierkorb — bitte dort wiederherstellen oder endgültig löschen.' : 'Projekt existiert bereits' });
  const r = db.prepare(
    "INSERT INTO projects (name, client, address, note, urgency, done, created_by) VALUES (?, ?, ?, ?, ?, 0, ?)"
  ).run(name.trim(), (client || '').trim(), (address || '').trim(), (note || '').trim(), normUrgency(urgency), req.user.id);
  setAssignments(db, r.lastInsertRowid, assigned_user_ids);
  setMilestones(db, r.lastInsertRowid, req.body.milestones);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid);
  broadcast('projects', req.headers['x-tab-id']);
  res.status(201).json({ project: withDetails(db, project) });
});

// Projekt bearbeiten (nur Chef/Admin)
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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
  if (req.body.milestones !== undefined) setMilestones(db, project.id, req.body.milestones);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ project: withDetails(db, updated) });
});

// Als erledigt markieren (verschwindet vom Board, bleibt archiviert) — nur Chef/Admin
router.post('/:id/done', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  db.prepare("UPDATE projects SET done = 1, done_at = strftime('%Y-%m-%d %H:%M:%f','now'), done_by = ? WHERE id = ?").run(req.user.id, project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Wieder öffnen — nur Chef/Admin
router.post('/:id/reopen', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  db.prepare('UPDATE projects SET done = 0, done_at = NULL, done_by = NULL WHERE id = ?').run(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Auftrags-Statistik: gebuchte Netto-Stunden je Nutzer (alle Bucher außer Admin) — nur Manager.
// Zählt Zeiteinträge, die per project_id ODER per Freitext-Projektname zugeordnet sind (deckt Bestands-
// projekte + den Lösch→Freitext→Wiederherstellen-Fall ab). Nur net_hours (Pause bereits abgezogen).
router.get('/:id/stats', authenticate, (req, res) => {
  if (req.user.role === 'mitarbeiter') return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const rows = db.prepare(`
    SELECT e.user_id, u.name, ROUND(SUM(e.net_hours), 2) AS hours, COUNT(*) AS entries
    FROM entries e JOIN users u ON u.id = e.user_id
    WHERE (e.project_id = ? OR (e.project_text = ? AND e.project_text <> '')) AND u.role <> 'admin'
    GROUP BY e.user_id
    ORDER BY hours DESC, u.name ASC
  `).all(project.id, project.name);
  const total_hours = Math.round(rows.reduce((s, r) => s + (r.hours || 0), 0) * 100) / 100;
  const total_entries = rows.reduce((s, r) => s + r.entries, 0);
  res.json({ per_user: rows, total_hours, total_entries });
});

// Status eines Zwischenziels setzen (offen|doing|done) — Zugeteilte ODER Chef/Admin.
router.patch('/:id/milestones/:mid/status', authenticate, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  const allowed = ['admin', 'chef'].includes(req.user.role) || isAssigned(db, project.id, req.user.id);
  if (!allowed) return res.status(403).json({ error: 'Keine Berechtigung für dieses Zwischenziel' });
  const { status } = req.body;
  if (!MS_STATUS.includes(status)) return res.status(400).json({ error: 'Ungültiger Status' });
  const ms = db.prepare('SELECT id FROM project_milestones WHERE id = ? AND project_id = ?').get(req.params.mid, project.id);
  if (!ms) return res.status(404).json({ error: 'Zwischenziel nicht gefunden' });
  db.prepare('UPDATE project_milestones SET status = ? WHERE id = ?').run(status, ms.id);
  broadcast('projects', req.headers['x-tab-id']);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  res.json({ project: withDetails(db, updated) });
});

// Projekt in den Papierkorb legen (Soft-Delete, nur Chef/Admin). Zuweisungen/Ziele/Verknüpfungen bleiben
// erhalten → volle Wiederherstellung möglich. Verschwindet vom Board.
router.delete('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
  db.prepare("UPDATE projects SET deleted_at = strftime('%Y-%m-%d %H:%M:%f','now'), deleted_by = ? WHERE id = ?").run(req.user.id, project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Aus dem Papierkorb wiederherstellen (nur Chef/Admin). Name war nie freigegeben → kein Konflikt.
router.post('/:id/restore', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht im Papierkorb' });
  db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Endgültig löschen aus dem Papierkorb (nur Chef/Admin) — muss zuvor im Papierkorb liegen.
// Projektname VORHER in die Freitexte sichern, damit Planungen/Zeitnachweise/Notizen/Werkzeuge ihre Daten
// behalten (Statistik zählt Alt-Stunden über den Namen weiter).
router.delete('/:id/purge', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nicht im Papierkorb' });

  db.prepare(`UPDATE entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE planning_entries SET project_text = ? WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);
  db.prepare(`UPDATE tool_checkouts SET project_text = ?, project_id = NULL WHERE project_id = ?`).run(project.name, project.id);
  db.prepare(`UPDATE orders SET project_id = NULL WHERE project_id = ?`).run(project.id);
  db.prepare(`UPDATE notes SET project_text = ?, project_id = NULL WHERE project_id = ? AND (project_text IS NULL OR project_text = '')`).run(project.name, project.id);

  db.prepare('DELETE FROM project_assignments WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  broadcast('projects', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
