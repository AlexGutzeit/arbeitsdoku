const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');

const router = express.Router();

// Typen die sofort aktiv sind (kein Genehmigungsschritt)
const AUTO_ACTIVE = ['krank', 'feiertag', 'berufsschule', 'innung', 'dienstreise'];
// Typen die Chef-Benachrichtigung brauchen (auch nach Edit)
const NOTIFY_CHEF = ['krank', 'berufsschule', 'innung'];

function isManager(user) {
  return user.role === 'admin' || user.role === 'chef' || user.role === 'buchhalter';
}

function initialStatus(type) {
  return AUTO_ACTIVE.includes(type) ? 'active' : 'pending';
}

function withUserName(absence, db) {
  if (absence.user_id) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.user_id);
    absence.user_name = u ? u.name : 'Unbekannt';
  } else {
    absence.user_name = 'Alle';
  }
  if (absence.processed_by) {
    const p = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.processed_by);
    absence.processed_by_name = p ? p.name : 'Unbekannt';
  }
  return absence;
}

// GET /api/absences — eigene (MA) oder alle (Manager)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const { type, from, to, user_id } = req.query;

  let sql = 'SELECT * FROM absences WHERE 1=1';
  const params = [];

  if (!isManager(req.user)) {
    sql += ' AND user_id = ?';
    params.push(uid);
  } else if (user_id) {
    sql += ' AND user_id = ?';
    params.push(Number(user_id));
  }

  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (from) { sql += ' AND date_to >= ?'; params.push(from); }
  if (to)   { sql += ' AND date_from <= ?'; params.push(to); }

  sql += ' ORDER BY date_from DESC, created_at DESC';

  const absences = db.prepare(sql).all(...params).map(a => withUserName(a, db));
  res.json({ absences });
});

// GET /api/absences/pending — offene Anträge für Manager-Ansicht (Posteingang)
router.get('/pending', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const absences = db.prepare(`
    SELECT * FROM absences
    WHERE status = 'pending'
       OR (status = 'active' AND type IN ('krank','berufsschule','innung') AND notified_at IS NULL)
    ORDER BY updated_at DESC
  `).all().map(a => withUserName(a, db));
  res.json({ absences });
});

// GET /api/absences/by-date — für Timeline-Anzeige (Von-Bis-Bereich)
router.get('/by-date', authenticate, (req, res) => {
  const db = getDb();
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });

  const uid = req.user.id;
  let sql, params;

  if (isManager(req.user)) {
    // Manager: alle Abwesenheiten (auch pending) außer rejected
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND a.status IN ('active','approved','pending')
           ORDER BY a.date_from`;
    params = [to, from];
  } else {
    // Mitarbeiter: eigene (inkl. pending) + Feiertage (active)
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND (
             (a.user_id = ? AND a.status IN ('active','approved','pending'))
             OR (a.user_id IS NULL AND a.status = 'active')
           )
           ORDER BY a.date_from`;
    params = [to, from, uid];
  }

  res.json({ absences: db.prepare(sql).all(...params) });
});

// POST /api/absences — neue Abwesenheit anlegen
router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const { type, date_from, date_to, comment } = req.body;

  if (!type || !date_from || !date_to) {
    return res.status(400).json({ error: 'Typ, Datum von und bis sind Pflichtfelder' });
  }
  if (date_from > date_to) {
    return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  }

  const validTypes = ['krank','urlaub','freizeitausgleich','sonderurlaub','feiertag','berufsschule','innung','dienstreise'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Ungültiger Typ' });
  }

  // Feiertage nur für Manager
  if (type === 'feiertag' && !isManager(req.user)) {
    return res.status(403).json({ error: 'Feiertage können nur von Chef/Admin/Buchhalter eingetragen werden' });
  }

  const uid = type === 'feiertag' ? null : req.user.id;
  const status = initialStatus(type);

  const result = db.prepare(`
    INSERT INTO absences (user_id, type, date_from, date_to, status, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid, type, date_from, date_to, status, (comment || '').trim());

  const absence = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(result.lastInsertRowid), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.status(201).json({ absence });
});

// PUT /api/absences/:id — Abwesenheit bearbeiten
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  const manager = isManager(req.user);
  if (!isOwner && !manager) return res.status(403).json({ error: 'Keine Berechtigung' });

  const { date_from, date_to, comment } = req.body;
  if (!date_from || !date_to) return res.status(400).json({ error: 'Datum von und bis erforderlich' });
  if (date_from > date_to) return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });

  // Bei Owner-Edit einer genehmigten/aktiven Abwesenheit → zurück auf pending/re-notify
  let newStatus = absence.status;
  let notifiedAt = absence.notified_at;

  if (isOwner && !manager) {
    if (absence.status === 'approved' || absence.status === 'rejected') {
      newStatus = 'pending'; // Neu einreichen
    } else if (absence.status === 'active' && NOTIFY_CHEF.includes(absence.type)) {
      notifiedAt = null; // Chef erneut benachrichtigen
    }
  }

  db.prepare(`
    UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
      status = ?, notified_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// DELETE /api/absences/:id
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  if (!isOwner && !isManager(req.user)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  // MA kann nur pending/active löschen — approved erfordert Manager
  if (isOwner && !isManager(req.user) && !['pending', 'active'].includes(absence.status)) {
    return res.status(403).json({ error: 'Genehmigte Abwesenheiten können nur vom Vorgesetzten gelöscht werden' });
  }

  db.prepare('DELETE FROM absences WHERE id = ?').run(absence.id);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// POST /api/absences/:id/approve — genehmigen
router.post('/:id/approve', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const newStatus = AUTO_ACTIVE.includes(absence.type) ? 'active' : 'approved';

  db.prepare(`
    UPDATE absences SET status = ?, processed_by = ?, processed_at = datetime('now'),
      notified_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/reject — ablehnen
router.post('/:id/reject', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge — Krank/Berufsschule/Innung quittieren
router.post('/:id/acknowledge', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET notified_at = datetime('now'), processed_by = ?,
      processed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

module.exports = router;
