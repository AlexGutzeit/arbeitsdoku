const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');
const push = require('../push');

const router = express.Router();

function canManage(role) {
  return ['admin', 'chef', 'buchhalter'].includes(role);
}

// Alte bestellte Einträge aufräumen (> 1 Monat)
function cleanup(db) {
  db.prepare("DELETE FROM orders WHERE ordered_at IS NOT NULL AND ordered_at < datetime('now', '-1 month')").run();
}

function resolveLocation(db, project_id) {
  if (!project_id) return { project_id: null, location_text: 'Lager' };
  const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(project_id);
  if (!p) return { project_id: null, location_text: 'Lager' };
  return { project_id: Number(project_id), location_text: p.name };
}

// Offene Bestellungen
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  cleanup(db);
  const orders = db.prepare(`
    SELECT o.*, u.name as user_name
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.ordered_at IS NULL
    ORDER BY o.created_at ASC
  `).all();
  res.json({ orders });
});

// Letzte Bestellungen (bestellt, max 1 Monat)
router.get('/ordered', authenticate, (req, res) => {
  const db = getDb();
  cleanup(db);
  const orders = db.prepare(`
    SELECT o.*, u.name as user_name, ob.name as ordered_by_name
    FROM orders o
    JOIN users u ON o.user_id = u.id
    LEFT JOIN users ob ON o.ordered_by = ob.id
    WHERE o.ordered_at IS NOT NULL
    ORDER BY o.ordered_at DESC
  `).all();
  res.json({ orders });
});

// Neuen Eintrag erstellen
router.post('/', authenticate, (req, res) => {
  const { quantity, unit, product, comment, project_id } = req.body;
  if (!product || !product.trim()) {
    return res.status(400).json({ error: 'Produkt ist erforderlich' });
  }
  let qty = null;
  if (quantity !== null && quantity !== undefined && quantity !== '') {
    qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1) {
      return res.status(400).json({ error: 'Anzahl muss mindestens 1 sein' });
    }
  }

  const db = getDb();
  const loc = resolveLocation(db, project_id);
  const result = db.prepare(
    'INSERT INTO orders (quantity, unit, product, comment, user_id, project_id, location_text) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(qty, (unit || '').trim() || null, product.trim(), (comment || '').trim() || null, req.user.id, loc.project_id, loc.location_text);

  const order = db.prepare(`
    SELECT o.*, u.name as user_name
    FROM orders o JOIN users u ON o.user_id = u.id
    WHERE o.id = ?
  `).get(result.lastInsertRowid);
  broadcast('orders', req.headers['x-tab-id']);
  res.status(201).json({ order });

  // Push an alle Chefs (deren Bestell-Zaehler steigt; badges.js: nur Rolle 'chef'), nicht an den Auslöser.
  const chefIds = db.prepare("SELECT id FROM users WHERE role = 'chef' AND COALESCE(active,1) = 1").all().map(r => r.id);
  push.notifyUsers(db, chefIds, 'orders', {
    title: 'Neue Bestellung',
    body: `${qty ? qty + '× ' : ''}${order.product} — von ${order.user_name}`,
    url: '/#/orders',
  }, req.user.id);
});

// Eintrag bearbeiten
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  if (!canManage(req.user.role) && order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  const { quantity, unit, product, comment, project_id } = req.body;
  if (!product || !product.trim()) {
    return res.status(400).json({ error: 'Produkt ist erforderlich' });
  }
  let qty = null;
  if (quantity !== null && quantity !== undefined && quantity !== '') {
    qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1) {
      return res.status(400).json({ error: 'Anzahl muss mindestens 1 sein' });
    }
  }

  const loc = resolveLocation(db, project_id);
  db.prepare(
    'UPDATE orders SET quantity = ?, unit = ?, product = ?, comment = ?, project_id = ?, location_text = ? WHERE id = ?'
  ).run(qty, (unit || '').trim() || null, product.trim(), (comment || '').trim() || null, loc.project_id, loc.location_text, req.params.id);

  const updated = db.prepare(`
    SELECT o.*, u.name as user_name
    FROM orders o JOIN users u ON o.user_id = u.id
    WHERE o.id = ?
  `).get(req.params.id);
  broadcast('orders', req.headers['x-tab-id']);
  res.json({ order: updated });
});

// Eintrag löschen
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  if (order.ordered_at) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
  } else {
    if (!canManage(req.user.role) && order.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
  }

  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  broadcast('orders', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Als bestellt markieren
router.post('/:id/order', authenticate, (req, res) => {
  if (!canManage(req.user.role)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  if (order.ordered_at) return res.status(400).json({ error: 'Bereits bestellt' });

  db.prepare("UPDATE orders SET ordered_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), ordered_by = ? WHERE id = ?")
    .run(req.user.id, req.params.id);
  broadcast('orders', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
