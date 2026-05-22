const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../sse');
const { countScheduledDays } = require('./statistics');

// Validierungs-Helper für ISO-Datum (YYYY-MM-DD, kalendarisch gültig)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const COMMENT_MAX = 1000;
function tooLongComment(c) { return typeof c === 'string' && c.length > COMMENT_MAX; }

const router = express.Router();

// Typen die sofort aktiv sind (kein Genehmigungsschritt)
const AUTO_ACTIVE = ['krank', 'feiertag', 'berufsschule', 'innung', 'dienstreise'];
// Typen die Chef-Benachrichtigung brauchen (auch nach Edit)
const NOTIFY_CHEF = ['krank', 'berufsschule', 'innung'];
// Typen die eine Genehmigung brauchen (Vorschlags-Mechanismus bei Manager-Edit von approved)
const APPROVAL_REQUIRED = ['urlaub', 'freizeitausgleich', 'sonderurlaub'];

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
    // Eigene Abwesenheiten + globale Feiertage (gelten fuer alle)
    sql += " AND (user_id = ? OR (type = 'feiertag' AND status = 'active'))";
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
    WHERE (
      (user_id = ? AND status IN ('active','approved'))
      OR (user_id IS NULL AND type = 'feiertag' AND status = 'active')
    )
    AND date_from <= ? AND date_to >= ?
  `).all(targetUid, to, from);

  // Feiertag-Set einmalig laden
  const feierRowsQ = db.prepare(
    "SELECT date_from, date_to FROM absences WHERE type='feiertag' AND status='active' AND date_from <= ? AND date_to >= ?"
  ).all(to, from);
  const feierSet = new Set();
  for (const f of feierRowsQ) {
    const c = new Date(f.date_from + 'T12:00:00'), e = new Date(f.date_to + 'T12:00:00');
    while (c <= e) { feierSet.add(c.toISOString().slice(0, 10)); c.setDate(c.getDate() + 1); }
  }
  const schedRows = db.prepare(
    'SELECT hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from ASC'
  ).all(targetUid);
  const schKeys = [null, 'hours_mon', 'hours_tue', 'hours_wed', 'hours_thu', 'hours_fri', null];

  // Ist dieser Tag laut Schedule ein Arbeitstag? (kein Feiertag-Check hier)
  function hasHours(dateStr) {
    const day = new Date(dateStr + 'T12:00:00').getDay();
    if (day === 0 || day === 6) return false;
    let active = schedRows[0];
    for (const t of schedRows) { if (t.valid_from <= dateStr) active = t; else break; }
    return active ? (active[schKeys[day]] || 0) > 0 : true;
  }

  // Krank-/Berufsschule-/Innung-Tage (Feiertage haben Vorrang)
  const sickSet = new Set();
  for (const row of rows) {
    if (!['krank','berufsschule','innung'].includes(row.type)) continue;
    const ef = row.date_from > from ? row.date_from : from;
    const et = row.date_to   < to   ? row.date_to   : to;
    if (ef > et) continue;
    const c = new Date(ef + 'T12:00:00'), e = new Date(et + 'T12:00:00');
    while (c <= e) {
      const ds = c.toISOString().slice(0, 10);
      if (hasHours(ds) && !feierSet.has(ds)) sickSet.add(ds);
      c.setDate(c.getDate() + 1);
    }
  }

  // Prioritätsbewusstes Zählen: Feiertag > Krank > Urlaub/FZA/Sonderurlaub
  function countForType(ef, et, absType) {
    let n = 0;
    const cur = new Date(ef + 'T12:00:00'), end = new Date(et + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds)) {
        if (absType === 'feiertag') {
          n++;
        } else if (['krank','berufsschule','innung','dienstreise'].includes(absType)) {
          if (!feierSet.has(ds)) n++;
        } else { // urlaub, sonderurlaub, freizeitausgleich
          if (!feierSet.has(ds) && !sickSet.has(ds)) n++;
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
    return n;
  }

  const summary = {};
  const uniqueAbsenceDays = new Set();
  for (const row of rows) {
    const effectiveFrom = row.date_from > from ? row.date_from : from;
    const effectiveTo   = row.date_to   < to   ? row.date_to   : to;
    if (effectiveFrom > effectiveTo) continue;
    const days = countForType(effectiveFrom, effectiveTo, row.type);
    if (days > 0) summary[row.type] = (summary[row.type] || 0) + days;
    const cur = new Date(effectiveFrom + 'T12:00:00');
    const end = new Date(effectiveTo   + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds)) uniqueAbsenceDays.add(ds);
      cur.setDate(cur.getDate() + 1);
    }
  }

  // urlaubTageJahr: approved Urlaub im aktuellen Jahr, Krank und Feiertage abgezogen
  const thisYear = new Date().getFullYear().toString();
  const urlaubRows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND type = 'urlaub' AND status = 'approved'
    AND date_from <= ? AND date_to >= ?
  `).all(targetUid, thisYear + '-12-31', thisYear + '-01-01');

  const yearFeierQ = db.prepare(
    "SELECT date_from, date_to FROM absences WHERE type='feiertag' AND status='active' AND date_from <= ? AND date_to >= ?"
  ).all(thisYear + '-12-31', thisYear + '-01-01');
  const yearFeierSet = new Set();
  for (const f of yearFeierQ) {
    const c = new Date(f.date_from + 'T12:00:00'), e = new Date(f.date_to + 'T12:00:00');
    while (c <= e) { yearFeierSet.add(c.toISOString().slice(0, 10)); c.setDate(c.getDate() + 1); }
  }
  const yearSickQ = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND type IN ('krank','berufsschule','innung') AND status IN ('active','approved')
    AND date_from <= ? AND date_to >= ?
  `).all(targetUid, thisYear + '-12-31', thisYear + '-01-01');
  const yearSickSet = new Set();
  for (const row of yearSickQ) {
    const c = new Date(row.date_from + 'T12:00:00'), e = new Date(row.date_to + 'T12:00:00');
    while (c <= e) {
      const ds = c.toISOString().slice(0, 10);
      if (hasHours(ds) && !yearFeierSet.has(ds)) yearSickSet.add(ds);
      c.setDate(c.getDate() + 1);
    }
  }

  let urlaubTageJahr = 0;
  for (const row of urlaubRows) {
    const effFrom = row.date_from > thisYear + '-01-01' ? row.date_from : thisYear + '-01-01';
    const effTo   = row.date_to   < thisYear + '-12-31' ? row.date_to   : thisYear + '-12-31';
    if (effFrom > effTo) continue;
    const cur = new Date(effFrom + 'T12:00:00'), end = new Date(effTo + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds) && !yearFeierSet.has(ds) && !yearSickSet.has(ds)) urlaubTageJahr++;
      cur.setDate(cur.getDate() + 1);
    }
  }

  res.json({ summary, totalUniqueDays: uniqueAbsenceDays.size, urlaubTageJahr });
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
  const fDate = new Date(from + 'T00:00:00');
  const tDate = new Date(to + 'T00:00:00');
  if (isNaN(fDate) || isNaN(tDate)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat' });
  }
  const diffDays = (tDate - fDate) / (1000 * 60 * 60 * 24);
  if (diffDays < 0 || diffDays > 366) {
    return res.status(400).json({ error: 'Zeitraum zu groß (max. 366 Tage)' });
  }

  const uid = req.user.id;
  let sql, params;

  // Genehmigungspflichtige Typen erscheinen erst nach Genehmigung (approved), nicht schon bei pending
  const APPROVAL_TYPES = "('urlaub','sonderurlaub','freizeitausgleich')";

  if (isManager(req.user)) {
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND (
             (a.status IN ('active','approved'))
             OR (a.status = 'pending' AND a.type NOT IN ${APPROVAL_TYPES})
             OR (a.status = 'pending' AND a.proposed_date_from IS NOT NULL)
           )
           ORDER BY a.date_from`;
    params = [to, from];
  } else {
    // Mitarbeiter: eigene + Feiertage (active)
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND (
             (a.user_id = ? AND (
               a.status IN ('active','approved')
               OR (a.status = 'pending' AND a.type NOT IN ${APPROVAL_TYPES})
               OR (a.status = 'pending' AND a.proposed_date_from IS NOT NULL)
             ))
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
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (date_from > date_to) {
    return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  }
  if (tooLongComment(comment)) {
    return res.status(400).json({ error: `Kommentar zu lang (max. ${COMMENT_MAX} Zeichen)` });
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
    // urlaub/freizeitausgleich/sonderurlaub → pending (MA muss akzeptieren)
    // alle anderen → active (informativ)
    if (['urlaub', 'freizeitausgleich', 'sonderurlaub'].includes(type)) {
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
    INSERT INTO absences (user_id, type, date_from, date_to, status, comment, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
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
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (date_from > date_to) return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  if (tooLongComment(comment)) {
    return res.status(400).json({ error: `Kommentar zu lang (max. ${COMMENT_MAX} Zeichen)` });
  }

  let newStatus = absence.status;
  let notifiedAt = absence.notified_at;
  let newCreatedBy = absence.created_by;

  // Vorschlags-Mechanismus: Manager bearbeitet GENEHMIGTEN Urlaub/FZA/Sonderurlaub
  // ODER bereits pendenden Vorschlag (proposed_date_from gesetzt) → alte Daten schützen
  const useProposalMechanism = manager && !isOwner
    && APPROVAL_REQUIRED.includes(absence.type)
    && (absence.status === 'approved' || (absence.status === 'pending' && absence.proposed_date_from));

  if (isOwner && !manager) {
    // MA bearbeitet eigene Abwesenheit → proposed_* immer löschen
    if (absence.status === 'approved' || absence.status === 'rejected') {
      newStatus = 'pending';
      newCreatedBy = absence.user_id;
    } else if (absence.status === 'active' && NOTIFY_CHEF.includes(absence.type)) {
      notifiedAt = null;
      newCreatedBy = absence.user_id;
    }
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 0,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, absence.id);

  } else if (useProposalMechanism) {
    // Vorschlag: alte Daten in date_from/date_to bleiben, neue in proposed_*
    // Status → pending, MA muss zustimmen
    db.prepare(`
      UPDATE absences SET proposed_date_from = ?, proposed_date_to = ?,
        comment = ?, status = 'pending', ma_needs_ack = 1,
        processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), req.user.id, absence.id);

  } else if (manager && !isOwner) {
    // Direktes Update: Krank/BS/Innung oder pending Urlaub (ohne vorherigen Vorschlag)
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 1,
        processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, req.user.id, absence.id);

  } else {
    // Manager bearbeitet eigene Abwesenheit
    if (manager && absence.created_by && absence.created_by !== absence.user_id) {
      if (absence.status === 'approved' || absence.status === 'rejected') {
        newStatus = 'pending';
      }
    }
    db.prepare(`
      UPDATE absences SET date_from = ?, date_to = ?, comment = ?,
        status = ?, notified_at = ?, created_by = ?,
        proposed_date_from = NULL, proposed_date_to = NULL, ma_needs_ack = 0,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(date_from, date_to, (comment || '').trim(), newStatus, notifiedAt, newCreatedBy, absence.id);
  }

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
  // MA kann pending/active/rejected löschen — nur approved erfordert Manager
  if (isOwner && !isManager(req.user) && absence.status === 'approved') {
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
    UPDATE absences SET status = ?, processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
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
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
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
    UPDATE absences SET status = 'approved', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
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
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge — Chef quittiert Krank/Berufsschule/Innung
router.post('/:id/acknowledge', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), processed_by = ?,
      processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ?').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge-ma — MA quittiert/akzeptiert Manager-Änderung
router.post('/:id/acknowledge-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });
  if (absence.user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });

  if (absence.proposed_date_from) {
    // MA akzeptiert Vorschlag → proposed Daten übernehmen, Status approved
    db.prepare(`
      UPDATE absences SET date_from = proposed_date_from, date_to = proposed_date_to,
        proposed_date_from = NULL, proposed_date_to = NULL,
        status = 'approved', ma_needs_ack = 0, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(absence.id);
  } else {
    // Krank/BS/Innung quittieren — nur ma_needs_ack löschen
    db.prepare(`
      UPDATE absences SET ma_needs_ack = 0, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(absence.id);
  }

  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// POST /api/absences/:id/reject-manager-edit — MA lehnt Manager-Vorschlag ab
router.post('/:id/reject-manager-edit', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ?').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });
  if (absence.user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (!absence.ma_needs_ack) return res.status(400).json({ error: 'Keine ausstehende Manager-Änderung' });

  if (!absence.proposed_date_from) {
    return res.status(400).json({ error: 'Kein Manager-Vorschlag vorhanden — nur Quittieren möglich' });
  }

  // Vorschlag abgelehnt: alte Daten (date_from/to) bleiben, proposed gelöscht
  // Status → pending damit Chef erneut entscheidet; created_by = user_id für Badge
  db.prepare(`
    UPDATE absences SET proposed_date_from = NULL, proposed_date_to = NULL,
      status = 'pending', ma_needs_ack = 0,
      created_by = user_id, processed_by = NULL, processed_at = NULL,
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(absence.id);

  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
