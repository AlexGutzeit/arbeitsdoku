const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');
const push = require('../push');
const { darfBestellen, SQL_BESTELLBERECHTIGT, SQL_BESTELLROLLEN } = require('../bestellrecht');

const router = express.Router();

// Rolle ODER Einzelrecht — damit waehrend des Urlaubs von Chef und Chefin nicht alles steht.
// Die Regel selbst liegt in bestellrecht.js, weil badges.js und users.js dieselbe Frage stellen.
const canManage = (user) => darfBestellen(user);

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
/**
 * Verknuepfung zum Produktverzeichnis pruefen.
 *
 * `orders.product` (der TEXT) bleibt die Wahrheit — er wird immer mitgeschrieben. `product_id` ist
 * nur die Verknuepfung: Wird das Produkt spaeter umbenannt oder geloescht, bleibt die Bestellung
 * lesbar. Zeigt die Verknuepfung ins Leere, wird sie still verworfen statt die Bestellung
 * abzuweisen — eine Bestellung darf nicht daran scheitern, dass ein Katalogeintrag verschwunden
 * ist.
 */
function pruefeProduktId(db, wert) {
  const id = Number(wert);
  if (!wert || !Number.isFinite(id)) return null;
  try {
    const p = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
    return p ? p.id : null;
  } catch (_) { return null; }   // Tabelle fehlt (sehr alte Sicherung)
}

router.post('/', authenticate, (req, res) => {
  const { quantity, unit, product, comment, project_id, product_id } = req.body;
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
  const pid = pruefeProduktId(db, product_id);
  const result = db.prepare(
    'INSERT INTO orders (quantity, unit, product, comment, user_id, project_id, location_text, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(qty, (unit || '').trim() || null, product.trim(), (comment || '').trim() || null, req.user.id, loc.project_id, loc.location_text, pid);

  const order = db.prepare(`
    SELECT o.*, u.name as user_name
    FROM orders o JOIN users u ON o.user_id = u.id
    WHERE o.id = ?
  `).get(result.lastInsertRowid);
  broadcast('orders', req.headers['x-tab-id']);
  res.status(201).json({ order });

  // Push an alle, deren Bestell-Zaehler steigt (analog badges.js) — also an jeden, der bestellen
  // darf. Ohne das haette ein Vorarbeiter zwar den Knopf, erfuehre aber nie, dass es etwas zu
  // bestellen gibt.
  //
  // Der BUCHHALTER war hier bis zum 27.08.2026 ausgenommen. Alex hat das umgedreht: „wer bestellen
  // kann, muss auch coin und push bekommen." Die Bedingung kommt deshalb aus bestellrecht.js und
  // wird nicht mehr hier hingeschrieben.
  const chefIds = db.prepare(
    `SELECT id FROM users WHERE ${SQL_BESTELLBERECHTIGT} AND COALESCE(active,1) = 1`
  ).all(...SQL_BESTELLROLLEN).map(r => r.id);
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

  if (!canManage(req.user) && order.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  const { quantity, unit, product, comment, project_id, product_id } = req.body;
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
    'UPDATE orders SET quantity = ?, unit = ?, product = ?, comment = ?, project_id = ?, location_text = ?, product_id = ? WHERE id = ?'
  ).run(qty, (unit || '').trim() || null, product.trim(), (comment || '').trim() || null, loc.project_id, loc.location_text, pruefeProduktId(db, product_id), req.params.id);

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
    if (!canManage(req.user) && order.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
  }

  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  broadcast('orders', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Als bestellt markieren
router.post('/:id/order', authenticate, (req, res) => {
  if (!canManage(req.user)) {
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
