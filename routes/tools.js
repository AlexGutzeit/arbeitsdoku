const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');

const router = express.Router();

// Alle Werkzeuge mit aktuellem Status abrufen
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const tools = db.prepare(`
    SELECT t.*,
      tc.id as checkout_id, tc.user_id as checked_out_by, tc.checked_out_at,
      tc.project_id as checkout_project_id,
      tc.project_text as checkout_project_text,
      tc.address as checkout_address,
      u.name as checked_out_by_name,
      p.name as checkout_project_name
    FROM tools t
    LEFT JOIN tool_checkouts tc ON tc.tool_id = t.id AND tc.returned_at IS NULL
    LEFT JOIN users u ON tc.user_id = u.id
    LEFT JOIN projects p ON tc.project_id = p.id
    ORDER BY t.name ASC
  `).all();
  res.json({ tools });
});

// Werkzeug-Historie abrufen
router.get('/:id/history', authenticate, (req, res) => {
  const db = getDb();
  const history = db.prepare(`
    SELECT tc.*, u.name as user_name, p.name as project_name
    FROM tool_checkouts tc
    JOIN users u ON tc.user_id = u.id
    LEFT JOIN projects p ON tc.project_id = p.id
    WHERE tc.tool_id = ?
    ORDER BY tc.checked_out_at DESC
    LIMIT 50
  `).all(req.params.id);
  res.json({ history });
});

// Werkzeug erstellen (nur Chef/Admin)
router.post('/', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist ein Pflichtfeld' });
  }
  const result = db.prepare('INSERT INTO tools (name) VALUES (?)').run(name.trim());
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(result.lastInsertRowid);
  broadcast('tools', req.headers['x-tab-id']);
  res.status(201).json({ tool });
});

// Werkzeug umbenennen (nur Chef/Admin)
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name ist ein Pflichtfeld' });
  }
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Werkzeug nicht gefunden' });
  db.prepare('UPDATE tools SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Werkzeug löschen (nur Chef/Admin)
router.delete('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Werkzeug nicht gefunden' });
  db.prepare('DELETE FROM tool_checkouts WHERE tool_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Werkzeug-Historie zurücksetzen (nur Admin)
router.delete('/:id/history', authenticate, authorize(), (req, res) => {
  const db = getDb();
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Werkzeug nicht gefunden' });
  db.prepare('DELETE FROM tool_checkouts WHERE tool_id = ?').run(req.params.id);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Werkzeug entnehmen
router.post('/:id/checkout', authenticate, (req, res) => {
  const db = getDb();
  const toolId = req.params.id;
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
  if (!tool) return res.status(404).json({ error: 'Werkzeug nicht gefunden' });

  const existing = db.prepare('SELECT * FROM tool_checkouts WHERE tool_id = ? AND returned_at IS NULL').get(toolId);
  if (existing) {
    return res.status(400).json({ error: 'Werkzeug ist bereits entnommen' });
  }

  const { project_id, project_text, address } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
  db.prepare(
    'INSERT INTO tool_checkouts (tool_id, user_id, checked_out_at, project_id, project_text, address) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(toolId, req.user.id, now, project_id || null, project_text || null, address || null);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Werkzeug zurückgeben
router.post('/:id/return', authenticate, (req, res) => {
  const db = getDb();
  const toolId = req.params.id;

  const checkout = db.prepare('SELECT * FROM tool_checkouts WHERE tool_id = ? AND returned_at IS NULL').get(toolId);
  if (!checkout) {
    return res.status(400).json({ error: 'Werkzeug ist nicht entnommen' });
  }
  if (checkout.user_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'chef') {
    return res.status(403).json({ error: 'Nur der aktuelle Besitzer kann zurückgeben' });
  }

  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
  db.prepare('UPDATE tool_checkouts SET returned_at = ? WHERE id = ?').run(now, checkout.id);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Werkzeug übernehmen (von anderem User)
router.post('/:id/takeover', authenticate, (req, res) => {
  const db = getDb();
  const toolId = req.params.id;

  const checkout = db.prepare('SELECT * FROM tool_checkouts WHERE tool_id = ? AND returned_at IS NULL').get(toolId);
  if (!checkout) {
    return res.status(400).json({ error: 'Werkzeug ist nicht entnommen' });
  }
  if (checkout.user_id === req.user.id) {
    return res.status(400).json({ error: 'Du hast das Werkzeug bereits' });
  }

  const { project_id, project_text, address } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
  db.prepare('UPDATE tool_checkouts SET returned_at = ? WHERE id = ?').run(now, checkout.id);
  db.prepare(
    'INSERT INTO tool_checkouts (tool_id, user_id, checked_out_at, project_id, project_text, address) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(toolId, req.user.id, now, project_id || null, project_text || null, address || null);
  broadcast('tools', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
