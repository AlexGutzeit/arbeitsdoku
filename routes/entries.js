const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');
const { recordEntryHistory, berlinNow } = require('../audit');
const { pruefeSperre, protokolliereEingriff } = require('../abschluss');

const router = express.Router();

// Validierungs-Helper — Uhrzeit-Pruefung gemeinsam in ../zeit.js
const { istUhrzeit: isValidTime } = require('../zeit');
// Gueltiges ISO-Datum (YYYY-MM-DD, kalendarisch real) — analog zu routes/absences.js
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function isValidBreak(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 600 && Math.floor(n) === n;
}
// Liefert Fehlermeldung, wenn ein String-Feld in req.body laenger ist als sein Limit. null sonst.
function validateLengths(body, limits) {
  for (const [field, max] of Object.entries(limits)) {
    const v = body[field];
    if (typeof v === 'string' && v.length > max) {
      return `Feld '${field}' ist zu lang (max. ${max} Zeichen)`;
    }
  }
  return null;
}
const ENTRY_LIMITS = {
  address: 300, client: 200, project_text: 200, description: 2000, personal_note: 2000
};

// Nettostunden berechnen
function calculateNetHours(timeFrom, timeTo, breakMinutes) {
  const [fh, fm] = timeFrom.split(':').map(Number);
  const [th, tm] = timeTo.split(':').map(Number);
  const totalMinutes = (th * 60 + tm) - (fh * 60 + fm) - (breakMinutes || 0);
  return Math.max(0, Math.round((totalMinutes / 60) * 100) / 100);
}

// Einträge abrufen
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const { date_from, date_to, project_id, search, user_id, regie } = req.query;
  const role = req.user.role;

  let sql = `
    SELECT e.*, u.name as user_name, u.username, p.name as project_name, ru.name as regie_user_name
    FROM entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN projects p ON e.project_id = p.id
    LEFT JOIN users ru ON e.regie_user_id = ru.id
    WHERE 1=1 AND e.deleted_at IS NULL
  `;
  const params = [];

  // Mitarbeiter sehen nur eigene Einträge
  if (role === 'mitarbeiter') {
    sql += ' AND e.user_id = ?';
    params.push(req.user.id);
  } else {
    // Admin/Chef/Buchhalter: Admin-Einträge ausblenden, Admin-User loggen keine eigenen Stunden
    sql += " AND u.role != 'admin'";
    if (user_id) {
      sql += ' AND e.user_id = ?';
      params.push(Number(user_id));
    }
  }

  if (date_from) {
    sql += ' AND e.date >= ?';
    params.push(date_from);
  }
  if (date_to) {
    sql += ' AND e.date <= ?';
    params.push(date_to);
  }
  if (project_id) {
    sql += ' AND e.project_id = ?';
    params.push(Number(project_id));
  }
  if (search) {
    if (typeof search === 'string' && search.length > 100) {
      return res.status(400).json({ error: 'Suchbegriff zu lang (max. 100 Zeichen)' });
    }
    sql += ' AND (e.description LIKE ? OR e.address LIKE ? OR e.client LIKE ? OR e.project_text LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (regie === '1') {
    sql += ' AND e.has_regie > 0';
  } else if (regie === '0') {
    sql += ' AND (e.has_regie = 0 OR e.has_regie IS NULL)';
  }

  sql += ' ORDER BY e.date DESC, e.time_from ASC';

  let entries = db.prepare(sql).all(...params);

  // Persönliche Notizen nur für Mitarbeiter selbst und Admin sichtbar
  if (role !== 'admin') {
    entries = entries.map(e => {
      if (e.user_id !== req.user.id) {
        return { ...e, personal_note: undefined };
      }
      return e;
    });
  }

  res.json({ entries });
});

// Papierkorb-Vollsicht: Chef/Admin sehen alles, Mitarbeiter (und Buchhalter) nur ihre EIGENEN Löschungen.
const canSeeAllTrash = (u) => u.role === 'admin' || u.role === 'chef';

// Gelöschte Einträge (Papierkorb). Chef/Admin: alle; sonst nur selbst gelöschte. MUSS vor GET '/:id' stehen.
router.get('/deleted', authenticate, (req, res) => {
  const db = getDb();
  const ownOnly = !canSeeAllTrash(req.user);
  const rows = db.prepare(`
    SELECT e.*, u.name as user_name, du.name as deleted_by_name, p.name as project_name,
           (SELECT h.reason FROM entry_history h
            WHERE h.entry_id = e.id AND h.action = 'delete'
            ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) as delete_reason
    FROM entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN users du ON e.deleted_by = du.id
    LEFT JOIN projects p ON e.project_id = p.id
    WHERE e.deleted_at IS NOT NULL ${ownOnly ? 'AND e.deleted_by = ?' : ''}
    ORDER BY e.deleted_at DESC
  `).all(...(ownOnly ? [req.user.id] : []));
  res.json({ entries: rows });
});

// Einzelnen Eintrag abrufen
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare(`
    SELECT e.*, u.name as user_name, p.name as project_name
    FROM entries e
    JOIN users u ON e.user_id = u.id
    LEFT JOIN projects p ON e.project_id = p.id
    WHERE e.id = ? AND e.deleted_at IS NULL
  `).get(req.params.id);

  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  // Zugriffskontrolle
  if (req.user.role === 'mitarbeiter' && entry.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  // Persönliche Notizen ausblenden
  if (req.user.role !== 'admin' && entry.user_id !== req.user.id) {
    entry.personal_note = undefined;
  }

  res.json({ entry });
});

// Eintrag erstellen
router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const { date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, personal_note, user_id, has_regie, regie_user_id } = req.body;

  if (!date || !time_from || !time_to) {
    return res.status(400).json({ error: 'Datum, Von und Bis sind Pflichtfelder' });
  }
  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Ungültiges Datum (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  if (!isValidTime(time_from) || !isValidTime(time_to)) {
    return res.status(400).json({ error: 'Ungültiges Zeitformat (erwartet HH:MM, 00:00 bis 23:59)' });
  }
  if (time_from > time_to) {
    return res.status(400).json({ error: 'Bis-Zeit muss nach Von-Zeit liegen' });
  }
  if (break_minutes !== undefined && break_minutes !== null && !isValidBreak(break_minutes)) {
    return res.status(400).json({ error: 'Pause muss eine ganze Zahl zwischen 0 und 600 Minuten sein' });
  }
  const lenErr = validateLengths(req.body, ENTRY_LIMITS);
  if (lenErr) return res.status(400).json({ error: lenErr });

  // Admin erstellt Einträge für andere Benutzer (nicht für sich selbst)
  let targetUserId = req.user.id;
  if (req.user.role === 'admin') {
    if (!user_id) {
      return res.status(400).json({ error: 'Admin muss einen Mitarbeiter auswählen' });
    }
    // B5: user_id muss ein existierender, aktiver Nicht-Admin sein (statt blind zu übernehmen).
    const target = db.prepare("SELECT id, role, COALESCE(active,1) AS active FROM users WHERE id = ?").get(user_id);
    if (!target || target.active === 0 || target.role === 'admin') {
      return res.status(400).json({ error: 'Ungültiger Mitarbeiter' });
    }
    targetUserId = target.id;
  }

  // Abrechnungs-Abschluss: kein Nachtragen in einen bezahlten Zeitraum (Admin nur mit Begruendung)
  const sperre = pruefeSperre(db, [date], req.user, req.body.reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  const net_hours = calculateNetHours(time_from, time_to, break_minutes || 0);

  const result = db.prepare(`
    INSERT INTO entries (user_id, date, time_from, time_to, break_minutes, net_hours, address, client, project_id, project_text, description, personal_note, has_regie, regie_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(targetUserId, date, time_from, time_to, break_minutes || 0, net_hours, address || '', client || '', project_id || null, project_text || '', description || '', personal_note || '', has_regie || 0, has_regie === 1 ? (regie_user_id || targetUserId) : null);

  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid);
  protokolliereEingriff(db, req, sperre, `Zeiteintrag ${date} angelegt`);
  broadcast('entries', req.headers['x-tab-id']);
  res.status(201).json({ entry });
});

// Eintrag bearbeiten
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id);

  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  // Zugriffskontrolle: Admin alle, andere nur eigene
  if (req.user.role !== 'admin' && entry.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  // GoBD: Aenderung eines fremden Eintrags (nur Admin moeglich) erfordert eine Begruendung
  const isForeign = entry.user_id !== req.user.id;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (isForeign && !reason) {
    return res.status(400).json({ error: 'Begründung erforderlich beim Bearbeiten eines fremden Eintrags' });
  }

  const { date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, personal_note, has_regie, regie_user_id } = req.body;

  const newFrom = time_from || entry.time_from;
  const newTo = time_to || entry.time_to;
  if (!isValidTime(newFrom) || !isValidTime(newTo)) {
    return res.status(400).json({ error: 'Ungültiges Zeitformat (erwartet HH:MM, 00:00 bis 23:59)' });
  }
  if (newFrom > newTo) {
    return res.status(400).json({ error: 'Bis-Zeit muss nach Von-Zeit liegen' });
  }
  const newBreak = break_minutes !== undefined ? break_minutes : entry.break_minutes;
  if (!isValidBreak(newBreak)) {
    return res.status(400).json({ error: 'Pause muss eine ganze Zahl zwischen 0 und 600 Minuten sein' });
  }
  const lenErr = validateLengths(req.body, ENTRY_LIMITS);
  if (lenErr) return res.status(400).json({ error: lenErr });
  if (date && !isValidDate(date)) {
    return res.status(400).json({ error: 'Ungültiges Datum (erwartet YYYY-MM-DD, gültiger Kalendertag)' });
  }
  // Abrechnungs-Abschluss: ALTES und NEUES Datum pruefen — sonst liesse sich ein Eintrag aus dem
  // bezahlten Zeitraum herausschieben (oder nachtraeglich hinein).
  const sperre = pruefeSperre(db, [entry.date, date], req.user, reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });

  const net_hours = calculateNetHours(newFrom, newTo, newBreak);

  const newRegie = has_regie !== undefined ? (has_regie || 0) : entry.has_regie;
  const newRegieUser = has_regie !== undefined ? (has_regie === 1 ? (regie_user_id || entry.regie_user_id) : null) : entry.regie_user_id;

  // GoBD: Vorher-Abbild unveraenderlich festhalten, bevor ueberschrieben wird
  recordEntryHistory(db, entry, 'update', req.user.id, reason);

  db.prepare(`
    UPDATE entries SET date=?, time_from=?, time_to=?, break_minutes=?, net_hours=?, address=?, client=?, project_id=?, project_text=?, description=?, personal_note=?, has_regie=?, regie_user_id=?, updated_at=strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id=?
  `).run(
    date || entry.date, newFrom, newTo, newBreak, net_hours,
    address !== undefined ? address : entry.address,
    client !== undefined ? client : entry.client,
    project_id !== undefined ? (project_id || null) : entry.project_id,
    project_text !== undefined ? project_text : entry.project_text,
    description !== undefined ? description : entry.description,
    personal_note !== undefined ? personal_note : entry.personal_note,
    newRegie, newRegieUser,
    req.params.id
  );

  const updated = db.prepare(`
    SELECT e.*, u.name as user_name, p.name as project_name
    FROM entries e JOIN users u ON e.user_id = u.id LEFT JOIN projects p ON e.project_id = p.id
    WHERE e.id = ?
  `).get(req.params.id);

  protokolliereEingriff(db, req, sperre, `Zeiteintrag ${entry.date} geändert`);
  broadcast('entries', req.headers['x-tab-id']);
  res.json({ entry: updated });
});

// Eintrag löschen (Mitarbeiter eigene, Admin alle) — Soft-Delete fuer Revisionssicherheit
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

  if (req.user.role === 'admin' || entry.user_id === req.user.id) {
    // GoBD: Loeschen eines fremden Eintrags (nur Admin) erfordert Begruendung
    const isForeign = entry.user_id !== req.user.id;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (isForeign && !reason) {
      return res.status(400).json({ error: 'Begründung erforderlich beim Löschen eines fremden Eintrags' });
    }
    const sperre = pruefeSperre(db, [entry.date], req.user, reason);
    if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });
    // Vorher-Abbild festhalten, dann Soft-Delete (Zeile bleibt fuer Pruefung erhalten)
    recordEntryHistory(db, entry, 'delete', req.user.id, reason);
    db.prepare("UPDATE entries SET deleted_at=?, deleted_by=? WHERE id=?")
      .run(berlinNow(), req.user.id, req.params.id);
    protokolliereEingriff(db, req, sperre, `Zeiteintrag ${entry.date} gelöscht`);
    broadcast('entries', req.headers['x-tab-id']);
    return res.json({ success: true });
  }

  return res.status(403).json({ error: 'Keine Berechtigung' });
});

// Aenderungsverlauf eines Eintrags (chef + admin) — GoBD-Nachvollziehbarkeit
router.get('/:id/history', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT h.id, h.entry_id, h.action, h.changed_by, h.changed_at, h.reason, h.snapshot,
           u.name as changed_by_name
    FROM entry_history h
    LEFT JOIN users u ON h.changed_by = u.id
    WHERE h.entry_id = ?
    ORDER BY h.changed_at DESC, h.id DESC
  `).all(req.params.id);
  for (const r of rows) {
    try { r.snapshot = JSON.parse(r.snapshot); } catch (_) { r.snapshot = null; }
  }
  res.json({ history: rows });
});

// Gelöschten Eintrag wiederherstellen. Chef/Admin: jeden; Mitarbeiter: nur selbst gelöschte.
// Wird als History-Eintrag protokolliert.
router.post('/:id/restore', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Gelöschter Eintrag nicht gefunden' });
  if (!canSeeAllTrash(req.user) && entry.deleted_by !== req.user.id) {
    return res.status(403).json({ error: 'Nur selbst gelöschte Einträge können wiederhergestellt werden' });
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  // Wiederherstellen holt einen geloeschten Eintrag ZURUECK in den Zeitraum — dieselbe Wirkung
  // auf die Zahlen wie ein neuer Eintrag, also dieselbe Sperre.
  const sperre = pruefeSperre(db, [entry.date], req.user, reason);
  if (sperre && sperre.fehler) return res.status(403).json({ error: sperre.fehler });
  // Vorher-Abbild (geloeschter Zustand) festhalten, dann wiederherstellen
  recordEntryHistory(db, entry, 'restore', req.user.id, reason);
  db.prepare('UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(req.params.id);
  protokolliereEingriff(db, req, sperre, `Zeiteintrag ${entry.date} wiederhergestellt`);
  broadcast('entries', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
