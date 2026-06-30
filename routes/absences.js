const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');
const push = require('../push');
const { computeAbsenceSummary, countUrlaubDaysInYear } = require('./absence-days');
const { recordAbsenceHistory, berlinNow } = require('../audit');

// Datumsbereich „TT.MM.–TT.MM." (bzw. ein einzelnes Datum, wenn von==bis) für Push-Texte.
function fmtRange(from, to) {
  const f = (d) => String(d).split('-').reverse().join('.');
  return from === to ? f(from) : `${f(from)}–${f(to)}`;
}

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
const AUTO_ACTIVE = ['krank', 'feiertag', 'berufsschule', 'innung'];
// Typen die Chef-Benachrichtigung brauchen (auch nach Edit)
const NOTIFY_CHEF = ['krank', 'berufsschule', 'innung'];
// Typen die eine Genehmigung brauchen (Vorschlags-Mechanismus bei Manager-Edit von approved)
const APPROVAL_REQUIRED = ['urlaub', 'freizeitausgleich', 'sonderurlaub'];

// Konflikt-Gruppen: zwei Abwesenheiten derselben Gruppe duerfen sich pro Tag NICHT
// ueberschneiden (Doppelbuchung). Stufenuebergreifend (z.B. Krank ueber Urlaub) bleibt
// erlaubt — das ist das gewollte Verdraengungs-Feature der Tageszaehlung.
const CONFLICT_GROUPS = [
  ['urlaub', 'freizeitausgleich', 'sonderurlaub'],
  ['berufsschule', 'innung'],
  ['krank'],
];
const TYPE_LABELS = {
  krank: 'Krank', urlaub: 'Urlaub', freizeitausgleich: 'Freizeitausgleich',
  sonderurlaub: 'Sonderurlaub', feiertag: 'Feiertag', berufsschule: 'Berufsschule', innung: 'Innung',
};
function conflictGroup(type) {
  return CONFLICT_GROUPS.find(g => g.includes(type)) || null;
}
// Liefert einen kollidierenden Datensatz derselben Gruppe (oder null). excludeId beim Bearbeiten.
function sameTierConflict(db, uid, type, from, to, excludeId) {
  const group = conflictGroup(type);
  if (!group || uid == null) return null; // feiertag (global) oder unbekannt: kein Gruppen-Check
  const ph = group.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, type, date_from, date_to FROM absences
    WHERE user_id = ? AND deleted_at IS NULL
      AND status IN ('pending','active','approved')
      AND type IN (${ph})
      AND date_from <= ? AND date_to >= ?
      AND id != ?
    ORDER BY date_from LIMIT 1
  `).get(uid, ...group, to, from, excludeId || -1);
}
function conflictMessage(type, conflict) {
  const g = conflictGroup(type).map(t => TYPE_LABELS[t]).join('/');
  const fmt = (d) => d.split('-').reverse().join('.');
  return `Überschneidung mit bestehender Abwesenheit „${TYPE_LABELS[conflict.type] || conflict.type}" `
    + `(${fmt(conflict.date_from)}–${fmt(conflict.date_to)}). Pro Tag ist nur eine Abwesenheit aus ${g} möglich.`;
}

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

  let sql = 'SELECT * FROM absences WHERE 1=1 AND deleted_at IS NULL';
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

  // Prioritätsbewusste Zählung (Feiertag > Krank > Urlaub/FZA) — gemeinsame Quelle mit der PDF
  const { summary, totalUniqueDays } = computeAbsenceSummary(db, targetUid, from, to);
  const thisYear = new Date().getFullYear();
  const urlaubTageJahr = countUrlaubDaysInYear(db, targetUid, thisYear);

  res.json({ summary, totalUniqueDays, urlaubTageJahr });
});

// GET /api/absences/pending — offene Anträge für Manager-Ansicht (Posteingang)
router.get('/pending', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const absences = db.prepare(`
    SELECT * FROM absences
    WHERE deleted_at IS NULL AND (
      status = 'pending'
      OR (status = 'active' AND type IN ('krank','berufsschule','innung') AND notified_at IS NULL)
    )
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

  // Alle Abwesenheiten sehen: Manager immer; Mitarbeiter mit „alle"-Planungsrecht (can_plan_all) NUR im
  // Planungskontext (damit sie vernünftig fremd-planen können). Die echte Autorisierung ist can_plan_all —
  // scope ist nur ein Kontext-Hinweis (Dashboard/Statistik nutzen ihn bewusst nicht). Self-Planer
  // (can_plan ohne can_plan_all) sehen weiterhin nur die eigenen Abwesenheiten.
  const canSeeAll = isManager(req.user) || (req.user.can_plan_all && req.query.scope === 'planning');

  if (canSeeAll) {
    // Optionaler user_id-Filter (eine ID oder kommasepariert) — globale Feiertage (user_id IS NULL)
    // bleiben immer enthalten. Ohne Filter: alle (z.B. Dashboard/Planung).
    const idList = String(req.query.user_id || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0);
    const userFilter = idList.length
      ? ` AND (a.user_id IN (${idList.map(() => '?').join(',')}) OR a.user_id IS NULL)` : '';
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND a.deleted_at IS NULL
           AND (
             (a.status IN ('active','approved'))
             OR (a.status = 'pending' AND a.type NOT IN ${APPROVAL_TYPES})
             OR (a.status = 'pending' AND a.proposed_date_from IS NOT NULL)
           )${userFilter}
           ORDER BY a.date_from`;
    params = [to, from, ...idList];
  } else {
    // Mitarbeiter: eigene + Feiertage (active)
    sql = `SELECT a.*, u.name as user_name FROM absences a
           LEFT JOIN users u ON a.user_id = u.id
           WHERE a.date_from <= ? AND a.date_to >= ?
           AND a.deleted_at IS NULL
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

  const rows = db.prepare(sql).all(...params);
  // Datenschutz: Nicht-Manager (z. B. Planer) sehen bei FREMDEN Abwesenheiten keinen Kommentar
  // (möglicher sensibler Grund). Eigener Kommentar bleibt sichtbar.
  if (!isManager(req.user)) {
    for (const r of rows) if (r.user_id && r.user_id !== uid) r.comment = '';
  }
  res.json({ absences: rows });
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

  const validTypes = ['krank','urlaub','freizeitausgleich','sonderurlaub','feiertag','berufsschule','innung'];
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

  // Doppelbuchung innerhalb derselben Stufe verhindern (z.B. Urlaub + FZA am selben Tag)
  const conflict = sameTierConflict(db, uid, type, date_from, date_to, null);
  if (conflict) {
    return res.status(400).json({ error: conflictMessage(type, conflict) });
  }

  const result = db.prepare(`
    INSERT INTO absences (user_id, type, date_from, date_to, status, comment, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `).run(uid, type, date_from, date_to, status, (comment || '').trim(), created_by);

  const absence = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(result.lastInsertRowid), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.status(201).json({ absence });

  // Push analog Abwesenheits-Badge:
  const label = TYPE_LABELS[type] || type;
  const range = fmtRange(date_from, date_to);
  if (type !== 'feiertag') {
    if (created_by !== uid && status === 'pending' && APPROVAL_REQUIRED.includes(type)) {
      // Manager hat für einen MA eingetragen → der MA muss bestätigen.
      push.notifyUsers(db, [uid], 'absences', {
        title: `${label} eingetragen`, body: `Bitte bestätigen: ${range}`, url: '/#/absences',
      }, req.user.id);
    } else if (status === 'pending' && APPROVAL_REQUIRED.includes(type)) {
      // Selbstantrag → alle Manager.
      push.notifyUsers(db, push.managerIds(db, req.user.id), 'absences', {
        title: `Neuer Antrag: ${label}`, body: `${absence.user_name}: ${range}`, url: '/#/absences',
      }, req.user.id);
    } else if (status === 'active' && NOTIFY_CHEF.includes(type)) {
      // Krank/Berufsschule/Innung gemeldet → alle Manager.
      push.notifyUsers(db, push.managerIds(db, req.user.id), 'absences', {
        title: `${label} gemeldet`, body: `${absence.user_name}: ${range}`, url: '/#/absences',
      }, req.user.id);
    }
  }
});

// PUT /api/absences/:id — Abwesenheit bearbeiten
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  const manager = isManager(req.user);
  if (!isOwner && !manager) return res.status(403).json({ error: 'Keine Berechtigung' });

  // GoBD: Bearbeiten einer fremden Abwesenheit (Manager) erfordert eine Begruendung
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!isOwner && !reason) {
    return res.status(400).json({ error: 'Begründung erforderlich beim Bearbeiten einer fremden Abwesenheit' });
  }

  const { date_from, date_to, comment } = req.body;
  if (!date_from || !date_to) return res.status(400).json({ error: 'Datum von und bis erforderlich' });
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return res.status(400).json({ error: 'Ungültiges Datumsformat (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (date_from > date_to) return res.status(400).json({ error: 'Datum von muss vor Datum bis liegen' });
  if (tooLongComment(comment)) {
    return res.status(400).json({ error: `Kommentar zu lang (max. ${COMMENT_MAX} Zeichen)` });
  }

  // Doppelbuchung innerhalb derselben Stufe verhindern (sich selbst ausgenommen)
  const conflict = sameTierConflict(db, absence.user_id, absence.type, date_from, date_to, absence.id);
  if (conflict) {
    return res.status(400).json({ error: conflictMessage(absence.type, conflict) });
  }

  // GoBD: Vorher-Abbild festhalten, bevor irgendein UPDATE-Zweig die Daten ueberschreibt
  recordAbsenceHistory(db, absence, 'update', req.user.id, reason);

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

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });

  // Manager hat eine fremde Abwesenheit bearbeitet → MA muss bestätigen (ma_needs_ack gesetzt).
  if (updated.ma_needs_ack === 1 && updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    // Bei Vorschlag zeigt proposed_* die neuen Daten, sonst date_from/to.
    const fromD = updated.proposed_date_from || updated.date_from;
    const toD = updated.proposed_date_to || updated.date_to;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: 'Abwesenheit bearbeitet', body: `Bitte bestätigen: ${label} ${fmtRange(fromD, toD)}`, url: '/#/absences',
    }, req.user.id);
  }
});

// DELETE /api/absences/:id
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const isOwner = absence.user_id === req.user.id;
  if (!isOwner && !isManager(req.user)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  // MA kann pending/active/rejected löschen — nur approved erfordert Manager
  if (isOwner && !isManager(req.user) && absence.status === 'approved') {
    return res.status(403).json({ error: 'Genehmigte Abwesenheiten können nur vom Vorgesetzten gelöscht werden' });
  }

  // GoBD: Loeschen einer fremden Abwesenheit (Manager) erfordert Begruendung
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!isOwner && !reason) {
    return res.status(400).json({ error: 'Begründung erforderlich beim Löschen einer fremden Abwesenheit' });
  }

  // Vorher-Abbild festhalten, dann Soft-Delete (Zeile bleibt fuer Pruefung erhalten)
  recordAbsenceHistory(db, absence, 'delete', req.user.id, reason);
  db.prepare("UPDATE absences SET deleted_at = ?, deleted_by = ? WHERE id = ?")
    .run(berlinNow(), req.user.id, absence.id);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Aenderungsverlauf einer Abwesenheit (chef + admin) — GoBD-Nachvollziehbarkeit
router.get('/:id/history', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT h.id, h.absence_id, h.action, h.changed_by, h.changed_at, h.reason, h.snapshot,
           u.name as changed_by_name
    FROM absence_history h
    LEFT JOIN users u ON h.changed_by = u.id
    WHERE h.absence_id = ?
    ORDER BY h.changed_at DESC, h.id DESC
  `).all(req.params.id);
  for (const r of rows) {
    try { r.snapshot = JSON.parse(r.snapshot); } catch (_) { r.snapshot = null; }
  }
  res.json({ history: rows });
});

// Papierkorb-Vollsicht: Chef/Admin sehen alles, Mitarbeiter (und Buchhalter) nur ihre EIGENEN Löschungen.
const canSeeAllTrash = (u) => u.role === 'admin' || u.role === 'chef';

// Gelöschte Abwesenheiten (Papierkorb). Chef/Admin: alle; sonst nur selbst gelöschte.
router.get('/deleted/list', authenticate, (req, res) => {
  const db = getDb();
  const ownOnly = !canSeeAllTrash(req.user);
  const rows = db.prepare(`
    SELECT a.*, u.name as user_name, du.name as deleted_by_name,
           (SELECT h.reason FROM absence_history h
            WHERE h.absence_id = a.id AND h.action = 'delete'
            ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) as delete_reason
    FROM absences a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN users du ON a.deleted_by = du.id
    WHERE a.deleted_at IS NOT NULL ${ownOnly ? 'AND a.deleted_by = ?' : ''}
    ORDER BY a.deleted_at DESC
  `).all(...(ownOnly ? [req.user.id] : []));
  res.json({ absences: rows });
});

// Gelöschte Abwesenheit wiederherstellen — NUR Admin (bewusste Ausnahme). Für Chef/Mitarbeiter/Buchhalter
// ist Restore gesperrt, weil er den Antrag als bereits „genehmigt" zurückbrächte und die Genehmigung
// umginge (problematisch, wenn der Zeitraum inzwischen verplant wurde) — die nutzen „Neu beantragen".
// Der gelöschte Datensatz bleibt ohnehin für die Revisionssicherheit (GoBD) im Papierkorb erhalten.
router.post('/:id/restore', authenticate, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Abwesenheiten können nur vom Admin wiederhergestellt werden – bitte neu beantragen.' });
  }
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Gelöschte Abwesenheit nicht gefunden' });

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  recordAbsenceHistory(db, absence, 'restore', req.user.id, reason);
  db.prepare('UPDATE absences SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(req.params.id);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ success: true });
});

// POST /api/absences/:id/approve — genehmigen
router.post('/:id/approve', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  const newStatus = AUTO_ACTIVE.includes(absence.type) ? 'active' : 'approved';

  db.prepare(`
    UPDATE absences SET status = ?, processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(newStatus, req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });

  // Antrag genehmigt → der Mitarbeiter.
  if (updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: `${label} genehmigt`, body: fmtRange(updated.date_from, updated.date_to), url: '/#/absences',
    }, req.user.id);
  }
});

// POST /api/absences/:id/reject — ablehnen (Manager)
router.post('/:id/reject', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET status = 'rejected', processed_by = ?, processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });

  // Antrag abgelehnt → der Mitarbeiter.
  if (updated.user_id && updated.user_id !== req.user.id) {
    const label = TYPE_LABELS[updated.type] || updated.type;
    push.notifyUsers(db, [updated.user_id], 'absences', {
      title: `${label} abgelehnt`, body: fmtRange(updated.date_from, updated.date_to), url: '/#/absences',
    }, req.user.id);
  }
});

// POST /api/absences/:id/accept — MA akzeptiert Manager-eingetragenen Urlaub/FZA
router.post('/:id/accept', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/reject-ma — MA lehnt Manager-eingetragenen Urlaub/FZA ab
router.post('/:id/reject-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge — Chef quittiert Krank/Berufsschule/Innung
router.post('/:id/acknowledge', authenticate, (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });

  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!absence) return res.status(404).json({ error: 'Abwesenheit nicht gefunden' });

  db.prepare(`
    UPDATE absences SET notified_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), processed_by = ?,
      processed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(req.user.id, absence.id);

  const updated = withUserName(db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(absence.id), db);
  broadcast('absences', req.headers['x-tab-id']);
  res.json({ absence: updated });
});

// POST /api/absences/:id/acknowledge-ma — MA quittiert/akzeptiert Manager-Änderung
router.post('/:id/acknowledge-ma', authenticate, (req, res) => {
  const db = getDb();
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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
  const absence = db.prepare('SELECT * FROM absences WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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
// Fuer Tests
module.exports.sameTierConflict = sameTierConflict;
module.exports.conflictGroup = conflictGroup;
