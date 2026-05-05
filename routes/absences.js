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
  if (absence.created_by) {
    const cb = db.prepare('SELECT name FROM users WHERE id = ?').get(absence.created_by);
    absence.created_by_name = cb ? cb.name : 'Unbekannt';
  }
  return absence;
}

// Hilfsfunktion: Arbeitstage (Mo-Fr) zählen, begrenzt auf from/to
function countWorkdays(dateFrom, dateTo) {
  let count = 0;
  const start = new Date(dateFrom + 'T12:00:00');
  const end = new Date(dateTo + 'T12:00:00');
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Arbeitstage im Schnittbereich zweier Zeiträume
function countWorkdaysIntersect(aFrom, aTo, bFrom, bTo) {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  return countWorkdays(from, to);
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

// GET /api/absences/summary — Abwesenheitsübersicht für Zeitraum
router.get('/summary', authenticate, (req, res) => {
  const db = getDb();
  const { from, to, user_id } = req.query;

  if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });

  let targetUid;
  if (req.user.role === 'mitarbeiter') {
    targetUid = req.user.id;
  } else if (user_id) {
    if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
    targetUid = Number(user_id);
  } else {
    // Manager ohne user_id: eigene Zusammenfassung
    targetUid = req.user.id;
  }

  const rows = db.prepare(`
    SELECT type, date_from, date_to FROM absences
    WHERE user_id = ? AND status IN ('active','approved')
    AND date_from <= ? AND date_to >= ?
  `).all(targetUid, to, from);

  const summary = {};
  for (const row of rows) {
    const days = countWorkdaysIntersect(row.date_from, row.date_to, from, to);
    if (days > 0) {
      summary[row.type] = (summary[row.type] || 0) + days;
    }
  }

  // Urlaubstage approved im aktuellen Kalenderjahr
  const thisYear = new Date().getFullYear().toString();
  const urlaubRows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND type = 'urlaub' AND status = 'approved'
    AND date_from <= ? AND date_to >= ?
  `).all(targetUid, thisYear + '-12-31', thisYear + '-01-01');

  let urlaubTageJahr = 0;
  for (const row of urlaubRows) {
    urlaubTageJahr += countWorkdaysIntersect(row.date_from, row.date_to, thisYear + '-01-01', thisYear + '-12-31');
  }

  res.json({ summary, urlaubTageJahr });
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
  const { type, date_from, date_to, comment, target_user_id } = req.body;

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

  let uid, status, created_by;

  if (type === 'feiertag') {
    uid = null;
    status = initialStatus(type);
    created_by = req.user.id;
  } else if (target_user_id && Number(target_user_id) !== req.user.id) {
    // Manager trägt für anderen MA ein
    if (!isManager(req.user)) {
      return res.status(403).json({ error: 'Keine Berechtigung für Fremdeintrag' });
    }
    uid = Number(target_user_id);
    created_by = req.user.id;
    // urlaub/freizeitausgleich → pending (MA muss akzeptieren)
    // alle anderen → active (informativ)
    if (['urlaub', 'freizeitausgleich'].includes(type)) {
      status = 'pending';
    } else {
      status = 'active';
    }
  } else {
    // Normaler Eigeneintrag
    uid = req.user.id;
    created_by = req.user.id;
    status = initialStatus(type);
  }

  const result = db.prepare(`
    INSERT INTO absences (user_id, type, date_from, date_to, status, comment, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uid, type, date_from, date_to, status, (comment || '').trim(), created_by);

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
  } else if (manager && absence.created_by && absence.created_by !== absence.user_id) {
    // Manager bearbeitet eigenen Eintrag (für MA) → MA muss erneut akzeptieren
    if (absence.status === 'approved' || absence.status === 'rejected') {
      newStatus = 'pending';
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

// POST /api/absences/:id/reject — ablehnen (Manager)
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

// POST /api/absences/:id/accept — MA akzeptiert Manager-eingetragenen Urlaub/FZA
router.post('/:id/accept', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  // Nur wenn: eigener Eintrag, von Manager eingetragen, noch pending
  if (absence.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  if (!absence.created_by || absence.created_by === absence.user_id) {
    return res.status(403).json({ error: 'Nur Manager-Einträge können akzeptiert werden' });
  }
  if (absence.status !== 'pending') {
    return res.status(400).json({ error: 'Nur pending Einträge können akzeptiert werden' });
  }

  db.prepare(`
    UPDATE absences SET status = 'approved', processed_by = ?, processed_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/reject-ma — MA lehnt Manager-eingetragenen Urlaub/FZA ab
router.post('/:id/reject-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  // Nur wenn: eigener Eintrag, von Manager eingetragen, noch pending
  if (absence.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  if (!absence.created_by || absence.created_by === absence.user_id) {
    return res.status(403).json({ error: 'Nur Manager-Einträge können abgelehnt werden' });
  }
  if (absence.status !== 'pending') {
    return res.status(400).json({ error: 'Nur pending Einträge können abgelehnt werden' });
  }

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
