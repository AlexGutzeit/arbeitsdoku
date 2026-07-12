const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { broadcast } = require('../sse');
const recur = require('../planning-recurrence');

const router = express.Router();

// ——— Serientermine (Wiederholungen) ———
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonthsISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const diffDays = (aISO, bISO) => Math.round((new Date(bISO + 'T00:00:00Z') - new Date(aISO + 'T00:00:00Z')) / 86400000);

// Wiederholungs-Eingaben prüfen/normalisieren; null bei ungültig.
function validRecurrence(r) {
  if (!r || !recur.FREQS.includes(r.freq)) return null;
  const end_type = ['never', 'count', 'until'].includes(r.end_type) ? r.end_type : 'never';
  const out = { freq: r.freq, interval_weeks: Math.max(1, Number(r.interval_weeks) || 1), end_type };
  if (end_type === 'count') out.end_count = Math.min(500, Math.max(1, Number(r.end_count) || 1));
  if (end_type === 'until') { if (!/^\d{4}-\d{2}-\d{2}$/.test(r.end_until || '')) return null; out.end_until = r.end_until; }
  return out;
}

// Aus dem Body (days[] oder Einzeltag) die Serien-Vorlage bauen: Anker = frühester Tag, Tage als Offsets.
function buildTemplate(body) {
  const list = Array.isArray(body.days) && body.days.length
    ? body.days
    : [{ date: body.date, time_from: body.time_from, time_to: body.time_to, break_minutes: body.break_minutes }];
  const valid = list.filter(d => d.date && d.time_from && d.time_to).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!valid.length) return null;
  const anchor = valid[0].date;
  return {
    anchor,
    tplDays: valid.map(d => ({ offset: diffDays(anchor, d.date), time_from: d.time_from, time_to: d.time_to, break_minutes: d.break_minutes || 0 })),
    address: body.address || '', client: body.client || '', project_id: body.project_id || null,
    project_text: body.project_text || '', description: body.description || '', color: body.color || '#f59e0b',
  };
}

// Erzeugt für jede Wiederplanung echte Tageszeilen (eigene group_id je Vorkommen) + Zuweisungen + Serien-Regel.
// Muss innerhalb einer Transaktion laufen. Liefert die series_id.
function materializeSeries(db, createdBy, rule, template, assignedUserIds, occurrences, materializedUntil, lineageId) {
  const seriesId = crypto.randomUUID();
  const lineage = lineageId || seriesId; // eigenständige Serie → Herkunft = sie selbst; Umtakten erbt die alte
  const insEntry = db.prepare(`INSERT INTO planning_entries
    (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date, lineage_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAssign = db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)');
  for (const occStart of occurrences) {
    const groupId = crypto.randomUUID(); // jede Wiederholung ist eine Gruppe (auch eintägig)
    for (const td of template.tplDays) {
      const date = addDaysISO(occStart, td.offset);
      const r = insEntry.run(createdBy, date, td.time_from, td.time_to, td.break_minutes,
        template.address, template.client, template.project_id, template.project_text, template.description,
        groupId, template.color, seriesId, occStart, lineage);
      for (const uid of assignedUserIds) insAssign.run(r.lastInsertRowid, uid);
    }
  }
  db.prepare(`INSERT INTO planning_series
    (series_id, created_by, freq, anchor_date, interval_weeks, end_type, end_count, end_until, template, materialized_until, active, lineage_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
    seriesId, createdBy, rule.freq, rule.anchor_date, rule.interval_weeks, rule.end_type,
    rule.end_count || null, rule.end_until || null,
    JSON.stringify({ tplDays: template.tplDays, assigned_user_ids: assignedUserIds, address: template.address, client: template.client, project_id: template.project_id, project_text: template.project_text, description: template.description, color: template.color }),
    materializedUntil, lineage);
  return seriesId;
}

// Legt aus Regel + Vorlage (buildTemplate-Ergebnis) + Zuweisung eine Serie an (Vorkommen ab optional fromDate).
// lineageId: beim Umtakten die Herkunft der Ursprungs-Serie mitgeben (sonst neue Herkunft).
// Liefert { series_id, count }. Muss innerhalb einer Transaktion laufen.
function createSeriesFrom(db, createdBy, rule, tmpl, assigned, fromDate, lineageId) {
  const horizon = rule.end_type === 'never' ? addMonthsISO(todayISO(), 24) : null;
  const opts = {};
  if (fromDate) opts.from = fromDate;
  if (horizon) opts.horizon = horizon;
  const starts = recur.computeOccurrences(rule, opts);
  if (!starts.length) return { series_id: null, count: 0 };
  const templateObj = { tplDays: tmpl.tplDays, assigned_user_ids: assigned, address: tmpl.address, client: tmpl.client, project_id: tmpl.project_id, project_text: tmpl.project_text, description: tmpl.description, color: tmpl.color };
  const sid = materializeSeries(db, createdBy, rule, templateObj, assigned, starts, horizon || starts[starts.length - 1], lineageId);
  return { series_id: sid, count: starts.length };
}

// Alle Planungen abrufen (für alle User sichtbar)
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const { date_from, date_to, project_id } = req.query;

  let sql = `
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (date_from) { sql += ' AND pe.date >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND pe.date <= ?'; params.push(date_to); }
  if (project_id) { sql += ' AND pe.project_id = ?'; params.push(Number(project_id)); }

  sql += ' ORDER BY pe.date ASC, pe.time_from ASC';

  const entries = db.prepare(sql).all(...params);

  // Zugewiesene User für jeden Eintrag laden
  const result = entries.map(e => {
    const assigned = db.prepare(`
      SELECT pa.user_id, u.name as user_name
      FROM planning_assignments pa
      JOIN users u ON pa.user_id = u.id
      WHERE pa.planning_id = ?
    `).all(e.id);
    return { ...e, assigned_users: assigned };
  });

  res.json({ entries: result });
});

// Alle Einträge einer Gruppe laden (MUSS vor /:id stehen!)
router.get('/group/:groupId', authenticate, (req, res) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.group_id = ?
    ORDER BY pe.date ASC
  `).all(req.params.groupId);

  if (!entries.length) return res.status(404).json({ error: 'Gruppe nicht gefunden' });

  // Assigned users vom ersten Eintrag (sind für alle gleich)
  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa
    JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(entries[0].id);

  res.json({ entries, assigned_users: assigned });
});

// Einzelne Planung abrufen
// ——— Planungs-Erinnerungen (Push vor einem Termin) ———
// Bewusst NUR authenticate (kein canPlan): auch Mitarbeiter ohne Planungsrecht dürfen sich an ihre
// eigenen Termine erinnern lassen. Empfänger = wer sie setzt. MUSS vor '/:id' stehen (sonst fängt
// '/:id' den Pfad „reminders" ab).
const LEAD_UNITS = ['day', 'week', 'month'];
const REMIND_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validLead(num, unit) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  if (!LEAD_UNITS.includes(unit)) return null;
  return { num: n, unit };
}
function assignedIdsOfSeries(db, seriesId) {
  return db.prepare(`SELECT DISTINCT pa.user_id FROM planning_assignments pa
    JOIN planning_entries pe ON pe.id = pa.planning_id WHERE pe.series_id = ?`).all(seriesId).map(r => r.user_id);
}
function assignedIdsOfEntry2(db, entryId) {
  return db.prepare('SELECT user_id FROM planning_assignments WHERE planning_id = ?').all(entryId).map(r => r.user_id);
}
// Darf der Nutzer für dieses Ziel eine Erinnerung setzen? canPlanAll → jede Planung; sonst nur, wenn
// er selbst zugewiesen ist. Prüft außerdem, dass das Ziel überhaupt existiert. Occurrence-Ziel wird per
// group_id (Mehrtag/Serie) ODER entry_id (Einzeltag ohne Gruppe) adressiert.
function reminderTargetAllowed(db, user, t) {
  let exists, ids;
  if (t.target_type === 'series') {
    exists = !!db.prepare('SELECT 1 FROM planning_entries WHERE series_id = ? LIMIT 1').get(t.series_id);
    ids = () => assignedIdsOfSeries(db, t.series_id);
  } else if (t.group_id) {
    exists = !!db.prepare('SELECT 1 FROM planning_entries WHERE group_id = ? LIMIT 1').get(t.group_id);
    ids = () => assignedIdsOfGroup(db, t.group_id);
  } else {
    exists = !!db.prepare('SELECT 1 FROM planning_entries WHERE id = ?').get(t.entry_id);
    ids = () => assignedIdsOfEntry2(db, t.entry_id);
  }
  if (!exists) return false;
  if (canPlanAll(user)) return true;
  return ids().includes(user.id);
}
const reminderOut = (r) => ({ id: r.id, reminder_group: r.reminder_group, group_id: r.group_id, entry_id: r.entry_id, series_id: r.series_id, occurrence_date: r.occurrence_date || null, lead_num: r.lead_num, lead_unit: r.lead_unit, remind_time: r.remind_time || null });
// Vorkommen einer Serie als [{od (occurrence_date), gid (group_id)}]. Optional erst ab fromDate.
function seriesOccurrences(db, seriesId, fromDate) {
  const rows = fromDate
    ? db.prepare(`SELECT occurrence_date AS od, MIN(group_id) AS gid FROM planning_entries WHERE series_id = ? AND occurrence_date >= ? GROUP BY occurrence_date`).all(seriesId, fromDate)
    : db.prepare(`SELECT occurrence_date AS od, MIN(group_id) AS gid FROM planning_entries WHERE series_id = ? GROUP BY occurrence_date`).all(seriesId);
  return rows.filter(x => x.gid);
}
// Materialisiert eine logische Erinnerung als eine Zeile JE Vorkommen (verbunden über reminder_group).
// occs: [{gid?, eid?, od?}]. Doppelte (gleicher Vorlauf/Uhrzeit auf demselben Vorkommen) werden übersprungen.
function materializeReminder(db, userId, occs, seriesId, lead, remind_time) {
  const rgroup = crypto.randomUUID();
  const ins = db.prepare(`INSERT INTO planning_reminders (user_id, reminder_group, group_id, entry_id, series_id, occurrence_date, lead_num, lead_unit, remind_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const dupq = db.prepare(`SELECT id FROM planning_reminders WHERE user_id = ?
    AND COALESCE(group_id,'') = COALESCE(?, '') AND COALESCE(entry_id,0) = COALESCE(?, 0)
    AND lead_num = ? AND lead_unit = ? AND COALESCE(remind_time,'') = COALESCE(?, '')`);
  let created = 0;
  for (const o of occs) {
    const gid = o.gid || null, eid = o.eid || null;
    if (dupq.get(userId, gid, eid, lead.num, lead.unit, remind_time)) continue;
    ins.run(userId, rgroup, gid, eid, seriesId || null, o.od || null, lead.num, lead.unit, remind_time);
    created++;
  }
  return { rgroup, created };
}

// Alle eigenen Erinnerungen (für die 🔔-Anzeige in der Planung). '/reminders/mine' matcht vor '/reminders'.
router.get('/reminders/mine', authenticate, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM planning_reminders WHERE user_id = ?').all(req.user.id);
  res.json({ reminders: rows.map(reminderOut) });
});

// Eigene Erinnerungen auf EINEM Vorkommen lesen (group_id ODER entry_id) — pro-Vorkommen gespeichert.
router.get('/reminders', authenticate, (req, res) => {
  const db = getDb();
  const groupId = req.query.group_id || null;
  const entryId = req.query.entry_id ? Number(req.query.entry_id) : null;
  if (!groupId && !entryId) return res.status(400).json({ error: 'group_id oder entry_id nötig' });
  const rows = db.prepare(`SELECT * FROM planning_reminders WHERE user_id = ?
    AND ((group_id IS NOT NULL AND group_id = ?) OR (entry_id IS NOT NULL AND entry_id = ?))
    ORDER BY lead_unit, lead_num, id`).all(req.user.id, groupId, entryId);
  res.json({ reminders: rows.map(reminderOut) });
});

// Erinnerung anlegen. Serie: scope nur-dieser (occurrence) / dieser+folgende (following) / alle (all)
// → materialisiert pro betroffenem Vorkommen eine Zeile. Nicht-Serie: genau ein Vorkommen.
router.post('/reminders', authenticate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const lead = validLead(b.lead_num, b.lead_unit);
  if (!lead) return res.status(400).json({ error: 'Ungültiger Vorlauf' });
  let remind_time = null;
  if (b.remind_time) { if (!REMIND_TIME_RE.test(b.remind_time)) return res.status(400).json({ error: 'Ungültige Uhrzeit' }); remind_time = b.remind_time; }

  const isSeries = !!b.series_id;
  const t = isSeries ? { target_type: 'series', series_id: b.series_id }
    : b.group_id ? { target_type: 'occurrence', group_id: b.group_id }
      : { target_type: 'occurrence', entry_id: b.entry_id ? Number(b.entry_id) : null };
  if (!t.series_id && !t.group_id && !t.entry_id) return res.status(400).json({ error: 'Ziel nötig (series_id/group_id/entry_id)' });
  if (!reminderTargetAllowed(db, req.user, t)) return res.status(403).json({ error: 'Keine Berechtigung für diesen Termin' });

  let occs;
  if (isSeries) {
    const scope = ['occurrence', 'following', 'all'].includes(b.scope) ? b.scope : 'all';
    if (scope === 'occurrence') {
      if (!b.group_id) return res.status(400).json({ error: 'group_id des Vorkommens nötig' });
      occs = [{ gid: b.group_id, od: b.occurrence_date || null }];
    } else {
      occs = seriesOccurrences(db, b.series_id, scope === 'following' ? (b.occurrence_date || null) : null);
    }
  } else if (b.group_id) {
    occs = [{ gid: b.group_id, od: null }];
  } else {
    occs = [{ eid: Number(b.entry_id), od: null }];
  }
  if (!occs.length) return res.status(400).json({ error: 'Keine passenden Vorkommen' });

  let result;
  const tx = db.transaction(() => { result = materializeReminder(db, req.user.id, occs, isSeries ? b.series_id : null, lead, remind_time); });
  tx();
  res.status(201).json({ success: true, created: result.created, reminder_group: result.rgroup });
});

// Verwaiste Erinnerungen entfernen (Termin/Gruppe existiert nicht mehr). Nach Planungs-Löschungen aufrufen.
function pruneOrphanReminders(db) {
  try {
    db.prepare(`DELETE FROM planning_reminders WHERE
      (group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM planning_entries pe WHERE pe.group_id = planning_reminders.group_id))
      OR (entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM planning_entries pe WHERE pe.id = planning_reminders.entry_id))`).run();
  } catch (_) {}
}

// Ist eine Serie auf höchstens EIN Vorkommen geschrumpft, ist sie keine Wiederholung mehr → Serien-
// Verknüpfung lösen (kein 🔁, wird als Einzelplanung behandelt) und Regel entfernen. Bei einem
// Einzeltag-Vorkommen wird auch die group_id gelöst und die Erinnerung von group_id → entry_id umgehängt.
function detachEndedSeries(db, seriesId) {
  try {
    const occ = db.prepare('SELECT DISTINCT occurrence_date FROM planning_entries WHERE series_id = ?').all(seriesId).map(r => r.occurrence_date);
    if (occ.length > 1) return; // noch mehrere Vorkommen → bleibt Serie
    if (occ.length === 1) {
      const rows = db.prepare('SELECT * FROM planning_entries WHERE series_id = ?').all(seriesId);
      if (rows.length === 1) {
        // Einzeltag → echte Einzelplanung: group_id/Serie lösen, Erinnerung von group_id auf entry_id umhängen.
        const e = rows[0];
        if (e.group_id) db.prepare('UPDATE planning_reminders SET group_id = NULL, entry_id = ?, series_id = NULL, occurrence_date = NULL WHERE group_id = ?').run(e.id, e.group_id);
        db.prepare('UPDATE planning_entries SET series_id = NULL, occurrence_date = NULL, group_id = NULL, lineage_id = NULL WHERE id = ?').run(e.id);
      } else {
        // Mehrtägiges Vorkommen bleibt Gruppe; nur die Serien-Verknüpfung lösen (Einträge + Erinnerungen).
        const gids = db.prepare('SELECT DISTINCT group_id FROM planning_entries WHERE series_id = ? AND group_id IS NOT NULL').all(seriesId).map(r => r.group_id);
        for (const g of gids) db.prepare('UPDATE planning_reminders SET series_id = NULL, occurrence_date = NULL WHERE group_id = ?').run(g);
        db.prepare('UPDATE planning_entries SET series_id = NULL, occurrence_date = NULL, lineage_id = NULL WHERE series_id = ?').run(seriesId);
      }
    }
    db.prepare('DELETE FROM planning_series WHERE series_id = ?').run(seriesId);
  } catch (_) {}
}

// Erinnerung ändern (Vorlauf/Uhrzeit) mit Scope. Serie: occurrence/following/all über reminder_group.
router.put('/reminders/:id', authenticate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM planning_reminders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Erinnerung nicht gefunden' });
  const lead = validLead(b.lead_num, b.lead_unit);
  if (!lead) return res.status(400).json({ error: 'Ungültiger Vorlauf' });
  let remind_time = null;
  if (b.remind_time) { if (!REMIND_TIME_RE.test(b.remind_time)) return res.status(400).json({ error: 'Ungültige Uhrzeit' }); remind_time = b.remind_time; }
  const scope = ['occurrence', 'following', 'all'].includes(b.scope) ? b.scope : 'occurrence';
  let ids;
  if (row.series_id && scope === 'following') ids = db.prepare('SELECT id FROM planning_reminders WHERE user_id = ? AND reminder_group = ? AND occurrence_date >= ?').all(req.user.id, row.reminder_group, row.occurrence_date).map(x => x.id);
  else if (row.series_id && scope === 'all') ids = db.prepare('SELECT id FROM planning_reminders WHERE user_id = ? AND reminder_group = ?').all(req.user.id, row.reminder_group).map(x => x.id);
  else ids = [row.id];
  const upd = db.prepare('UPDATE planning_reminders SET lead_num = ?, lead_unit = ?, remind_time = ? WHERE id = ?');
  const clr = db.prepare('DELETE FROM planning_reminder_sent WHERE reminder_id = ?');
  const tx = db.transaction(() => { for (const id of ids) { upd.run(lead.num, lead.unit, remind_time, id); clr.run(id); } });
  tx();
  res.json({ success: true, updated: ids.length });
});

// Erinnerung löschen mit Scope. Serie: occurrence (nur dieses Vorkommen = Ausnahme/Loch) / following / all.
router.delete('/reminders/:id', authenticate, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM planning_reminders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Erinnerung nicht gefunden' });
  const scope = ['occurrence', 'following', 'all'].includes(req.query.scope) ? req.query.scope : 'occurrence';
  let n;
  if (row.series_id && scope === 'following') n = db.prepare('DELETE FROM planning_reminders WHERE user_id = ? AND reminder_group = ? AND occurrence_date >= ?').run(req.user.id, row.reminder_group, row.occurrence_date).changes;
  else if (row.series_id && scope === 'all') n = db.prepare('DELETE FROM planning_reminders WHERE user_id = ? AND reminder_group = ?').run(req.user.id, row.reminder_group).changes;
  else n = db.prepare('DELETE FROM planning_reminders WHERE id = ?').run(row.id).changes;
  res.json({ success: true, deleted: n });
});

router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const entry = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe
    JOIN users u ON pe.created_by = u.id
    LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.id = ?
  `).get(req.params.id);

  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa
    JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(entry.id);

  res.json({ entry: { ...entry, assigned_users: assigned } });
});

// Planungsrecht prüfen: Chef/Admin immer, andere wenn can_plan gesetzt (mind. „sich selbst planen")
function canPlan(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'chef' || req.user.can_plan) return next();
  return res.status(403).json({ error: 'Keine Berechtigung für Planung' });
}

// „alle planen" — Chef/Admin immer, sonst can_plan_all. Wer das NICHT hat (Self-Planer), darf nur
// sich selbst verplanen und nur Einträge anfassen, in denen er selbst zugewiesen ist.
function canPlanAll(user) {
  return user.role === 'admin' || user.role === 'chef' || !!user.can_plan_all;
}
function assignedIdsOfEntry(db, planningId) {
  return db.prepare('SELECT user_id FROM planning_assignments WHERE planning_id = ?').all(planningId).map(r => r.user_id);
}
function assignedIdsOfGroup(db, groupId) {
  return db.prepare(`SELECT DISTINCT pa.user_id FROM planning_assignments pa
    JOIN planning_entries pe ON pe.id = pa.planning_id WHERE pe.group_id = ?`).all(groupId).map(r => r.user_id);
}
// Legt aus dem Request-Body (klassisch einzeln ODER days[]) Einträge an, ausschließlich dem Self-Planer
// zugewiesen. Gibt { ids, groupId } zurück. Muss innerhalb einer Transaktion laufen.
function insertSelfEntries(db, body, sid) {
  const { days, address, client, project_id, project_text, description, color } = body;
  const list = Array.isArray(days) && days.length
    ? days
    : [{ date: body.date, time_from: body.time_from, time_to: body.time_to, break_minutes: body.break_minutes }];
  const valid = list.filter(d => d.date && d.time_from && d.time_to);
  const groupId = valid.length > 1 ? crypto.randomUUID() : null;
  const ids = [];
  for (const day of valid) {
    const result = db.prepare(`
      INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sid, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', groupId, color || '#f59e0b');
    const pid = result.lastInsertRowid;
    db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(pid, sid);
    ids.push(pid);
  }
  return { ids, groupId };
}
// „Aufteilen": Self-Planer aus den Original-Einträgen ausklinken (nur seine Zuweisung) und eine neue,
// ausschließlich ihm gehörende Planung aus dem Request anlegen. Die anderen Zugewiesenen bleiben unberührt.
function splitOffSelf(db, req, res, sid, originalEntryIds) {
  const tx = db.transaction(() => {
    for (const pid of originalEntryIds) {
      db.prepare('DELETE FROM planning_assignments WHERE planning_id = ? AND user_id = ?').run(pid, sid);
    }
    return insertSelfEntries(db, req.body, sid);
  });
  const { ids, groupId } = tx();
  broadcast('planning', req.headers['x-tab-id']);
  return res.json({ success: true, split: true, count: ids.length, group_id: groupId });
}

// Planung erstellen (einzeln oder Gruppe)
router.post('/', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const { days, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  // Self-Planer (ohne „alle"-Recht) darf ausschließlich sich selbst verplanen.
  if (!canPlanAll(req.user)) {
    const ids = (assigned_user_ids || []).map(Number);
    if (ids.length !== 1 || ids[0] !== req.user.id) {
      return res.status(403).json({ error: 'Du darfst nur dich selbst verplanen' });
    }
  }

  // Serientermin (Wiederholung)? — vor allen Einzel-/Gruppen-Pfaden prüfen (funktioniert mit date ODER days[]).
  if (req.body.recurrence) {
    if (!assigned_user_ids || !assigned_user_ids.length) {
      return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
    }
    const rv = validRecurrence(req.body.recurrence);
    if (!rv) return res.status(400).json({ error: 'Ungültige Wiederholungs-Angaben' });
    const template = buildTemplate(req.body);
    if (!template) return res.status(400).json({ error: 'Mindestens ein gültiger Tag ist erforderlich' });
    const rule = { ...rv, anchor_date: template.anchor };
    const horizon = rule.end_type === 'never' ? addMonthsISO(todayISO(), 24) : null;
    const occurrences = recur.computeOccurrences(rule, horizon ? { horizon } : {});
    if (!occurrences.length) return res.status(400).json({ error: 'Die Serie ergibt keine Termine' });
    const spanDays = Math.max(...template.tplDays.map(d => d.offset));
    const overlap = occurrences.length > 1 && diffDays(occurrences[0], occurrences[1]) <= spanDays;
    const materializedUntil = horizon || occurrences[occurrences.length - 1];
    const tx = db.transaction(() => materializeSeries(db, req.user.id, rule, template, assigned_user_ids, occurrences, materializedUntil));
    const seriesId = tx();
    broadcast('planning', req.headers['x-tab-id']);
    return res.status(201).json({ success: true, series: true, series_id: seriesId, count: occurrences.length, days_per_occurrence: template.tplDays.length, overlap });
  }

  // Rückwärtskompatibel: einzelner Eintrag (altes Format)
  if (req.body.date) {
    const { date, time_from, time_to, break_minutes } = req.body;
    if (!date || !time_from || !time_to) {
      return res.status(400).json({ error: 'Datum, Von und Bis sind Pflichtfelder' });
    }
    if (!assigned_user_ids || !assigned_user_ids.length) {
      return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
    }

    const insert = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, date, time_from, time_to, break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', color || '#f59e0b');

      const planningId = result.lastInsertRowid;
      for (const userId of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, userId);
      }
      return planningId;
    });

    const planningId = insert();
    const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(planningId);
    const assigned = db.prepare(`
      SELECT pa.user_id, u.name as user_name
      FROM planning_assignments pa JOIN users u ON pa.user_id = u.id
      WHERE pa.planning_id = ?
    `).all(planningId);

    broadcast('planning', req.headers['x-tab-id']);
    return res.status(201).json({ entry: { ...entry, assigned_users: assigned } });
  }

  // Neues Format: Mehrfach-Einträge mit days[]
  if (!days || !days.length) {
    return res.status(400).json({ error: 'Mindestens ein Tag ist erforderlich' });
  }
  if (!assigned_user_ids || !assigned_user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  }

  const groupId = days.length > 1 ? crypto.randomUUID() : null;

  const insert = db.transaction(() => {
    const ids = [];
    for (const day of days) {
      if (!day.date || !day.time_from || !day.time_to) continue;
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', groupId, color || '#f59e0b');

      const planningId = result.lastInsertRowid;
      for (const userId of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, userId);
      }
      ids.push(planningId);
    }
    return ids;
  });

  const ids = insert();
  broadcast('planning', req.headers['x-tab-id']);
  res.status(201).json({ success: true, count: ids.length, group_id: groupId });
});

// Gruppe aktualisieren (alle Tage ersetzen) — MUSS vor /:id stehen!
router.put('/group/:groupId', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const { days, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  if (!days || !days.length) {
    return res.status(400).json({ error: 'Mindestens ein Tag ist erforderlich' });
  }

  const groupId = req.params.groupId;

  // Self-Planer: nur eigene (ihm zugewiesene) Gruppen; bei geteilten Gruppen wird aufgeteilt.
  if (!canPlanAll(req.user)) {
    const sid = req.user.id;
    const current = assignedIdsOfGroup(db, groupId);
    if (!current.length) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
    if (!current.includes(sid)) return res.status(403).json({ error: 'Das ist nicht deine Planung' });
    const newIds = (assigned_user_ids || []).map(Number);
    if (newIds.length !== 1 || newIds[0] !== sid) {
      return res.status(403).json({ error: 'Du darfst nur dich selbst verplanen' });
    }
    if (current.some(id => id !== sid)) {
      // geteilt → Aufteilen: self aus allen Tageseinträgen der Gruppe ausklinken + neue eigene Gruppe
      const entryIds = db.prepare('SELECT id FROM planning_entries WHERE group_id = ?').all(groupId).map(r => r.id);
      return splitOffSelf(db, req, res, sid, entryIds);
    }
    // nur ihm zugewiesen → normale Ersetzung unten (assigned_user_ids ist bereits [sid])
  }

  if (!assigned_user_ids || !assigned_user_ids.length) {
    return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  }

  const update = db.transaction(() => {
    // Serien-Verknüpfung der Gruppe merken (bleibt beim Bearbeiten einer Occurrence erhalten)
    const link = db.prepare('SELECT series_id, occurrence_date FROM planning_entries WHERE group_id = ? LIMIT 1').get(groupId) || {};
    // Alte Einträge der Gruppe löschen (CASCADE löscht auch assignments)
    db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(groupId);

    // Entscheide ob weiterhin Gruppe oder Einzeleintrag
    const newGroupId = days.length > 1 ? groupId : null;

    const ids = [];
    for (const day of days) {
      if (!day.date || !day.time_from || !day.time_to) continue;
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', newGroupId, color || '#f59e0b', link.series_id || null, link.occurrence_date || null);

      const planningId = result.lastInsertRowid;
      for (const uid of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, uid);
      }
      ids.push(planningId);
    }
    return ids;
  });

  const ids = update();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true, count: ids.length, group_id: days.length > 1 ? groupId : null });
});

// Planung bearbeiten (einzeln)
router.put('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  const { days, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, assigned_user_ids, color } = req.body;

  // Self-Planer: nur Einträge, in denen er selbst zugewiesen ist; bei geteilten Einträgen wird aufgeteilt.
  if (!canPlanAll(req.user)) {
    const sid = req.user.id;
    const current = entry.group_id ? assignedIdsOfGroup(db, entry.group_id) : assignedIdsOfEntry(db, entry.id);
    if (!current.includes(sid)) return res.status(403).json({ error: 'Das ist nicht deine Planung' });
    const newIds = (assigned_user_ids || []).map(Number);
    if (assigned_user_ids !== undefined && (newIds.length !== 1 || newIds[0] !== sid)) {
      return res.status(403).json({ error: 'Du darfst nur dich selbst verplanen' });
    }
    if (current.some(id => id !== sid)) {
      // geteilt → Aufteilen: self aus DIESEM Eintrag ausklinken + neuen eigenen Eintrag aus dem Request
      return splitOffSelf(db, req, res, sid, [entry.id]);
    }
    // nur ihm zugewiesen → in place ändern (das Gate oben stellt sicher: assigned_user_ids ist [sid] oder leer)
  }

  // Neuer Pfad: days[] mit > 1 Tag → Single in Gruppe umwandeln
  if (Array.isArray(days) && days.length > 1) {
    if (!assigned_user_ids || !assigned_user_ids.length) {
      return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
    }

    const newGroupId = entry.group_id || crypto.randomUUID();
    const originalCreatedBy = entry.created_by;
    const originalCreatedAt = entry.created_at;

    const convert = db.transaction(() => {
      db.prepare('DELETE FROM planning_entries WHERE id = ?').run(req.params.id);
      const ids = [];
      for (const day of days) {
        if (!day.date || !day.time_from || !day.time_to) continue;
        const result = db.prepare(`
          INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, created_at, series_id, occurrence_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          originalCreatedBy,
          day.date, day.time_from, day.time_to, day.break_minutes || 0,
          address !== undefined ? address : entry.address,
          client !== undefined ? client : entry.client,
          project_id !== undefined ? (project_id || null) : entry.project_id,
          project_text !== undefined ? project_text : entry.project_text,
          description !== undefined ? description : entry.description,
          newGroupId,
          color !== undefined ? color : (entry.color || '#f59e0b'),
          originalCreatedAt,
          entry.series_id || null, entry.occurrence_date || null
        );
        const planningId = result.lastInsertRowid;
        for (const uid of assigned_user_ids) {
          db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(planningId, uid);
        }
        ids.push(planningId);
      }
      return ids;
    });

    const ids = convert();
    broadcast('planning', req.headers['x-tab-id']);
    return res.json({ success: true, count: ids.length, group_id: newGroupId });
  }

  // Falls days[] mit genau einem Tag: Werte aus days[0] ziehen (sonst klassisches Format)
  const useDay = Array.isArray(days) && days.length === 1 ? days[0] : null;
  const newDate = useDay ? useDay.date : date;
  const newFrom = useDay ? useDay.time_from : time_from;
  const newTo = useDay ? useDay.time_to : time_to;
  const newBreak = useDay ? useDay.break_minutes : break_minutes;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE planning_entries SET date=?, time_from=?, time_to=?, break_minutes=?, address=?, client=?, project_id=?, project_text=?, description=?, color=?, updated_at=strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id=?
    `).run(
      newDate || entry.date, newFrom || entry.time_from, newTo || entry.time_to,
      newBreak !== undefined ? newBreak : entry.break_minutes,
      address !== undefined ? address : entry.address,
      client !== undefined ? client : entry.client,
      project_id !== undefined ? (project_id || null) : entry.project_id,
      project_text !== undefined ? project_text : entry.project_text,
      description !== undefined ? description : entry.description,
      color !== undefined ? color : (entry.color || '#f59e0b'),
      req.params.id
    );

    if (assigned_user_ids && assigned_user_ids.length) {
      db.prepare('DELETE FROM planning_assignments WHERE planning_id = ?').run(req.params.id);
      for (const userId of assigned_user_ids) {
        db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(req.params.id, userId);
      }
    }
  });

  update();

  const updated = db.prepare(`
    SELECT pe.*, u.name as created_by_name, p.name as project_name
    FROM planning_entries pe JOIN users u ON pe.created_by = u.id LEFT JOIN projects p ON pe.project_id = p.id
    WHERE pe.id = ?
  `).get(req.params.id);
  const assigned = db.prepare(`
    SELECT pa.user_id, u.name as user_name
    FROM planning_assignments pa JOIN users u ON pa.user_id = u.id
    WHERE pa.planning_id = ?
  `).all(req.params.id);

  broadcast('planning', req.headers['x-tab-id']);
  res.json({ entry: { ...updated, assigned_users: assigned } });
});

// ——— Serien-Operationen (Löschen mit Umfang + „Serie beenden") — MÜSSEN vor /:id stehen ———
// Rechte: Manager immer; Selbstplaner nur seine eigene Serie (created_by). Manager-Serien mit Fremd-
// zuweisung kann ein Selbstplaner nicht als Ganzes ändern (er kann einzelne Vorkommen ausklinken).
function loadSeriesOr(req, res, db) {
  const series = db.prepare('SELECT * FROM planning_series WHERE series_id = ?').get(req.params.seriesId);
  if (!series) { res.status(404).json({ error: 'Serie nicht gefunden' }); return null; }
  if (!canPlanAll(req.user) && series.created_by !== req.user.id) { res.status(403).json({ error: 'Das ist nicht deine Serie' }); return null; }
  return series;
}

// Vorschau der nächsten Wiederholungstermine (für das Formular) — nutzt dieselbe Engine (kein Duplikat).
router.post('/series/preview', authenticate, canPlan, (req, res) => {
  const rv = validRecurrence(req.body.recurrence);
  const anchor = req.body.anchor_date;
  if (!rv || !/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) return res.status(400).json({ error: 'Ungültige Angaben' });
  const rule = { ...rv, anchor_date: anchor };
  const horizon = rule.end_type === 'never' ? addMonthsISO(todayISO(), 24) : null;
  const occ = recur.computeOccurrences(rule, horizon ? { horizon } : {});
  const spanDays = Math.max(0, Number(req.body.span_days) || 0);
  const overlap = occ.length > 1 && diffDays(occ[0], occ[1]) <= spanDays;
  res.json({ occurrences: occ.slice(0, 6), total: occ.length, bounded: rule.end_type !== 'never', overlap, label: recur.freqLabel(rule.freq, anchor) });
});

// Serien-Regel + lesbares Label + kommende Termine (für die Anzeige der Taktung im Bearbeiten-Formular)
router.get('/series/:seriesId', authenticate, (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT series_id, freq, anchor_date, interval_weeks, end_type, end_count, end_until, active FROM planning_series WHERE series_id = ?').get(req.params.seriesId);
  if (!s) return res.status(404).json({ error: 'Serie nicht gefunden' });
  const today = todayISO();
  const upcoming = db.prepare('SELECT DISTINCT occurrence_date FROM planning_entries WHERE series_id = ? AND occurrence_date >= ? ORDER BY occurrence_date LIMIT 8').all(s.series_id, today).map(r => r.occurrence_date);
  const totalUpcoming = db.prepare('SELECT COUNT(DISTINCT occurrence_date) AS n FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').get(s.series_id, today).n;
  res.json({ series: s, label: recur.freqLabel(s.freq, s.anchor_date), upcoming, totalUpcoming });
});

// Serie löschen mit Umfang: scope = 'occurrence' | 'following' | 'series'
router.delete('/series/:seriesId', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const scope = req.body && req.body.scope || 'series';
  const occ = req.body && req.body.occurrence_date;

  const tx = db.transaction(() => {
    if (scope === 'occurrence') {
      if (!occ) return { error: 'occurrence_date fehlt' };
      db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date = ?').run(series.series_id, occ);
    } else if (scope === 'following') {
      if (!occ) return { error: 'occurrence_date fehlt' };
      db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, occ);
      if (occ <= series.anchor_date) {
        db.prepare('DELETE FROM planning_series WHERE series_id = ?').run(series.series_id); // nichts bleibt übrig
      } else {
        db.prepare("UPDATE planning_series SET end_type='until', end_until=?, materialized_until=?, active=0 WHERE series_id=?")
          .run(addDaysISO(occ, -1), addDaysISO(occ, -1), series.series_id);
      }
    } else { // ganze Serie
      db.prepare('DELETE FROM planning_entries WHERE series_id = ?').run(series.series_id);
      db.prepare('DELETE FROM planning_series WHERE series_id = ?').run(series.series_id);
    }
    return { ok: true };
  });
  const r = tx();
  if (r.error) return res.status(400).json({ error: r.error });
  pruneOrphanReminders(db);
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Serie bearbeiten mit Umfang: scope = 'occurrence' | 'following' | 'series'.
// Ändert gemeinsame Felder (+ optional einheitliche Zeit + Zuweisung) auf den Zielzeilen; bei
// following/series wird auch das Template aktualisiert (für die rollierende Verlängerung).
router.put('/series/:seriesId', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const scope = req.body.scope || 'series';
  const occ = req.body.occurrence_date;
  const b = req.body;

  // Tages-STRUKTUR geändert (Tag entfernt/hinzugefügt/verschoben)? Bei following/series die betroffenen
  // Vorkommen mit dem neuen Tagesmuster NEU materialisieren (Feld-/Zeit-Updates laufen unten wie bisher).
  let tpl0; try { tpl0 = JSON.parse(series.template || '{}'); } catch (_) { tpl0 = {}; }
  const days = Array.isArray(b.days) ? b.days.filter(d => d.date && d.time_from && d.time_to) : null;
  let newTplDays = null;
  if (days && days.length) {
    const sorted = [...days].sort((a, x) => a.date < x.date ? -1 : 1);
    const base = sorted[0].date;
    newTplDays = sorted.map(d => ({ offset: diffDays(base, d.date), time_from: d.time_from, time_to: d.time_to, break_minutes: d.break_minutes || 0 }));
  }
  const offStr = (arr) => (arr || []).map(d => d.offset).join(',');
  if ((scope === 'following' || scope === 'series') && newTplDays && offStr(newTplDays) !== offStr(tpl0.tplDays)) {
    if (scope === 'following' && !occ) return res.status(400).json({ error: 'occurrence_date fehlt' });
    const fromDate = scope === 'following' ? occ : todayISO();
    const fld = (k, def) => (b[k] !== undefined ? b[k] : (tpl0[k] !== undefined ? tpl0[k] : def));
    const tplNew = {
      tplDays: newTplDays,
      assigned_user_ids: Array.isArray(b.assigned_user_ids) ? b.assigned_user_ids : (tpl0.assigned_user_ids || []),
      address: fld('address', ''), client: fld('client', ''),
      project_id: b.project_id !== undefined ? (b.project_id || null) : (tpl0.project_id || null),
      project_text: fld('project_text', ''), description: fld('description', ''), color: fld('color', '#f59e0b'),
    };
    const rule = { freq: series.freq, anchor_date: series.anchor_date, interval_weeks: series.interval_weeks || 1, end_type: series.end_type, end_count: series.end_count, end_until: series.end_until };
    const horizon = series.end_type === 'never' ? addMonthsISO(todayISO(), 24) : null;
    const starts = recur.computeOccurrences(rule, { from: fromDate, ...(horizon ? { horizon } : {}) });
    const insE = db.prepare(`INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insA = db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)');
    const txr = db.transaction(() => {
      db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, fromDate);
      for (const start of starts) {
        const gid = crypto.randomUUID();
        for (const td of tplNew.tplDays) {
          const r = insE.run(series.created_by, addDaysISO(start, td.offset), td.time_from, td.time_to, td.break_minutes,
            tplNew.address, tplNew.client, tplNew.project_id, tplNew.project_text, tplNew.description, gid, tplNew.color, series.series_id, start);
          for (const uid of tplNew.assigned_user_ids) insA.run(r.lastInsertRowid, uid);
        }
      }
      db.prepare('UPDATE planning_series SET template = ? WHERE series_id = ?').run(JSON.stringify(tplNew), series.series_id);
    });
    txr();
    broadcast('planning', req.headers['x-tab-id']);
    return res.json({ success: true, rematerialized: starts.length, days_per_occurrence: newTplDays.length });
  }

  let where = 'series_id = ?'; const wp = [series.series_id];
  if (scope === 'occurrence' || scope === 'following') {
    if (!occ) return res.status(400).json({ error: 'occurrence_date fehlt' });
    where += scope === 'occurrence' ? ' AND occurrence_date = ?' : ' AND occurrence_date >= ?';
    wp.push(occ);
  }

  const setCols = [], setVals = [];
  const maybe = (col, val) => { if (val !== undefined) { setCols.push(col + ' = ?'); setVals.push(val); } };
  maybe('address', b.address); maybe('client', b.client);
  if (b.project_id !== undefined) { setCols.push('project_id = ?'); setVals.push(b.project_id || null); }
  maybe('project_text', b.project_text); maybe('description', b.description); maybe('color', b.color);
  maybe('time_from', b.time_from); maybe('time_to', b.time_to); maybe('break_minutes', b.break_minutes);

  const tx = db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM planning_entries WHERE ${where}`).all(...wp).map(r => r.id);
    if (setCols.length) db.prepare(`UPDATE planning_entries SET ${setCols.join(', ')} WHERE ${where}`).run(...setVals, ...wp);
    if (Array.isArray(b.assigned_user_ids)) {
      for (const pid of ids) {
        db.prepare('DELETE FROM planning_assignments WHERE planning_id = ?').run(pid);
        for (const uid of b.assigned_user_ids) db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)').run(pid, uid);
      }
    }
    if (scope !== 'occurrence') { // Template für künftige (Scheduler-)Vorkommen mitziehen
      let tpl; try { tpl = JSON.parse(series.template || '{}'); } catch (_) { tpl = {}; }
      ['address', 'client', 'project_text', 'description', 'color'].forEach(k => { if (b[k] !== undefined) tpl[k] = b[k]; });
      if (b.project_id !== undefined) tpl.project_id = b.project_id || null;
      if (Array.isArray(b.assigned_user_ids)) tpl.assigned_user_ids = b.assigned_user_ids;
      if (b.time_from !== undefined && Array.isArray(tpl.tplDays)) {
        tpl.tplDays = tpl.tplDays.map(d => ({ ...d, time_from: b.time_from, time_to: b.time_to !== undefined ? b.time_to : d.time_to, break_minutes: b.break_minutes !== undefined ? b.break_minutes : d.break_minutes }));
      }
      db.prepare('UPDATE planning_series SET template = ? WHERE series_id = ?').run(JSON.stringify(tpl), series.series_id);
    }
    return ids.length;
  });
  const updated = tx();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true, updated });
});

// Normale Planung → Serie machen: Original (Einzel/Gruppe) löschen, Serie ab deren Datum materialisieren.
router.post('/to-series', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const rv = validRecurrence(req.body.recurrence);
  if (!rv) return res.status(400).json({ error: 'Ungültige Wiederholungs-Angaben' });
  const template = buildTemplate(req.body);
  if (!template) return res.status(400).json({ error: 'Mindestens ein gültiger Tag ist erforderlich' });
  const assigned = Array.isArray(req.body.assigned_user_ids) ? req.body.assigned_user_ids.map(Number) : [];
  if (!assigned.length) return res.status(400).json({ error: 'Mindestens ein Mitarbeiter muss zugewiesen werden' });
  if (!canPlanAll(req.user) && (assigned.length !== 1 || assigned[0] !== req.user.id)) return res.status(403).json({ error: 'Du darfst nur dich selbst verplanen' });
  const rule = { ...rv, anchor_date: template.anchor };
  const spanDays = Math.max(...template.tplDays.map(d => d.offset));
  // Wie sollen bestehende Erinnerungen der Einzel-/Gruppenplanung auf die neue Serie übertragen werden?
  const remScope = ['occurrence', 'following', 'all'].includes(req.body.reminder_scope) ? req.body.reminder_scope : 'all';
  const tx = db.transaction(() => {
    // Bestehende Erinnerungen (aller Nutzer) vor dem Löschen sichern.
    let oldRem = [];
    if (req.body.group_id) oldRem = db.prepare('SELECT * FROM planning_reminders WHERE group_id = ?').all(req.body.group_id);
    else if (req.body.entry_id) oldRem = db.prepare('SELECT * FROM planning_reminders WHERE entry_id = ?').all(Number(req.body.entry_id));
    if (req.body.group_id) db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(req.body.group_id);
    else if (req.body.entry_id) db.prepare('DELETE FROM planning_entries WHERE id = ?').run(Number(req.body.entry_id));
    const res2 = createSeriesFrom(db, req.user.id, rule, template, assigned, null);
    // Erinnerungen auf die neue Serie umhängen (pro-Vorkommen, Scope wie gewählt). „following" == „all",
    // da die Einzelplanung zum ersten Vorkommen wird.
    if (res2.series_id && oldRem.length) {
      const allOccs = seriesOccurrences(db, res2.series_id, null);
      const firstOcc = allOccs[0];
      for (const rem of oldRem) {
        const lead = { num: rem.lead_num, unit: rem.lead_unit };
        const occs = remScope === 'occurrence'
          ? (firstOcc ? [{ gid: firstOcc.gid, od: firstOcc.od }] : [])
          : allOccs.map(o => ({ gid: o.gid, od: o.od }));
        if (occs.length) materializeReminder(db, rem.user_id, occs, res2.series_id, lead, rem.remind_time || null);
      }
      const ids = oldRem.map(x => x.id);
      db.prepare(`DELETE FROM planning_reminders WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    return res2;
  });
  const r = tx();
  if (!r.series_id) return res.status(400).json({ error: 'Die Serie ergibt keine Termine' });
  broadcast('planning', req.headers['x-tab-id']);
  const occ = null;
  res.status(201).json({ success: true, series: true, series_id: r.series_id, count: r.count, days_per_occurrence: template.tplDays.length, overlap: false });
});

// Serie UMTAKTEN (Split): scope 'following' (ab occurrence_date) | 'series' (ab heute). Ohne recurrence →
// nur beenden (ab occurrence_date, Vergangenes bleibt). Alte Serie endet vor der Grenze, neue beginnt dort.
router.post('/series/:seriesId/retakt', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const scope = req.body.scope === 'series' ? 'series' : 'following';
  const occ = req.body.occurrence_date;
  if (!occ) return res.status(400).json({ error: 'occurrence_date fehlt' });
  const boundary = scope === 'series' ? todayISO() : occ;
  const rv = req.body.recurrence ? validRecurrence(req.body.recurrence) : null;
  const template = buildTemplate(req.body);
  const assigned = Array.isArray(req.body.assigned_user_ids) ? req.body.assigned_user_ids.map(Number) : (() => { try { return (JSON.parse(series.template || '{}').assigned_user_ids) || []; } catch (_) { return []; } })();

  const tx = db.transaction(() => {
    // „Bis Ende" laufende Erinnerungen der alten Serie merken (am letzten Vorkommen) → auf die neue Serie
    // mitnehmen. „nur dieser"-Ausnahmen (nicht bis zum Ende) wandern bewusst nicht mit.
    let endRems = [];
    try {
      const oldLast = (db.prepare('SELECT MAX(occurrence_date) AS m FROM planning_entries WHERE series_id = ?').get(series.series_id) || {}).m || null;
      if (oldLast) endRems = db.prepare('SELECT * FROM planning_reminders WHERE series_id = ? AND occurrence_date = ?').all(series.series_id, oldLast);
    } catch (_) {}
    // Verwaiste Erinnerungen der zu löschenden Vorkommen entfernen.
    try { db.prepare('DELETE FROM planning_reminders WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, boundary); } catch (_) {}
    db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, boundary);
    if (boundary <= series.anchor_date) {
      db.prepare('DELETE FROM planning_series WHERE series_id = ?').run(series.series_id);
    } else {
      db.prepare("UPDATE planning_series SET active=0, end_type='until', end_until=?, materialized_until=? WHERE series_id=?").run(addDaysISO(boundary, -1), addDaysISO(boundary, -1), series.series_id);
    }
    if (!rv || !template) return { ended: true };
    const rule = { ...rv, anchor_date: template.anchor }; // Anker = geöffnetes Vorkommen (Taktung leitet sich daraus ab)
    const r2 = createSeriesFrom(db, series.created_by, rule, template, assigned, boundary, series.lineage_id || series.series_id);
    // Dauerhafte Erinnerungen auf die neue (umgetaktete) Serie übertragen — pro Vorkommen.
    if (r2.series_id && endRems.length) {
      try {
        const newOccs = seriesOccurrences(db, r2.series_id, null).map(o => ({ gid: o.gid, od: o.od }));
        for (const rem of endRems) materializeReminder(db, rem.user_id, newOccs, r2.series_id, { num: rem.lead_num, unit: rem.lead_unit }, rem.remind_time || null);
      } catch (_) {}
    }
    return r2;
  });
  const r = tx();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true, ...r });
});

// Serie beenden. Ohne body: künftige ab heute entfernen (Vergangenes bleibt). Mit { after: <occurrence_date> }:
// „ab hier keine Wiederholung mehr" — diese Occurrence + Vergangenes bleiben, alle SPÄTEREN werden entfernt.
router.post('/series/:seriesId/stop', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const after = req.body && req.body.after;
  const today = todayISO();
  const tx = db.transaction(() => {
    if (after) {
      db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date > ?').run(series.series_id, after);
      db.prepare("UPDATE planning_series SET active=0, end_type='until', end_until=?, materialized_until=? WHERE series_id=?")
        .run(after, after, series.series_id);
    } else {
      db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, today);
      db.prepare("UPDATE planning_series SET active=0, end_type='until', end_until=?, materialized_until=? WHERE series_id=?")
        .run(addDaysISO(today, -1), addDaysISO(today, -1), series.series_id);
    }
    pruneOrphanReminders(db);
    detachEndedSeries(db, series.series_id); // auf 1 Vorkommen geschrumpft → echte Einzelplanung (kein 🔁)
  });
  tx();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// #11: Aus einer Serie genau EIN Vorkommen als Einzelplanung behalten, den Rest (davor UND danach) löschen.
router.post('/series/:seriesId/keep-single', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const occ = req.body && req.body.occurrence_date;
  if (!occ) return res.status(400).json({ error: 'occurrence_date fehlt' });
  // Herkunft (lineage) des geöffneten Vorkommens → erfasst auch umgetaktete Folge-Serien (z. B. Woche→Monat).
  const lineage = (db.prepare('SELECT lineage_id FROM planning_entries WHERE series_id = ? AND occurrence_date = ? LIMIT 1').get(series.series_id, occ) || {}).lineage_id
    || series.lineage_id || series.series_id;
  const tx = db.transaction(() => {
    // ALLE Vorkommen derselben Herkunft löschen — außer dem einen, das behalten wird.
    db.prepare('DELETE FROM planning_entries WHERE lineage_id = ? AND NOT (series_id = ? AND occurrence_date = ?)').run(lineage, series.series_id, occ);
    db.prepare('DELETE FROM planning_series WHERE lineage_id = ?').run(lineage); // alle Regeln der Herkunft weg
    pruneOrphanReminders(db);                     // Erinnerungen der gelöschten Vorkommen weg
    detachEndedSeries(db, series.series_id);       // das eine verbleibende Vorkommen wird Einzelplanung
  });
  tx();
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Gruppe löschen — MUSS vor /:id stehen!
router.delete('/group/:groupId', authenticate, canPlan, (req, res) => {
  const db = getDb();

  // Self-Planer: nur eigene Gruppen; bei geteilten Gruppen nur die eigene Zuweisung entfernen (ausklinken).
  if (!canPlanAll(req.user)) {
    const sid = req.user.id;
    const current = assignedIdsOfGroup(db, req.params.groupId);
    if (!current.length) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
    if (!current.includes(sid)) return res.status(403).json({ error: 'Das ist nicht deine Planung' });
    if (current.some(id => id !== sid)) {
      const entryIds = db.prepare('SELECT id FROM planning_entries WHERE group_id = ?').all(req.params.groupId).map(r => r.id);
      for (const pid of entryIds) {
        db.prepare('DELETE FROM planning_assignments WHERE planning_id = ? AND user_id = ?').run(pid, sid);
      }
      broadcast('planning', req.headers['x-tab-id']);
      return res.json({ success: true, unclinch: true });
    }
    // nur ihm zugewiesen → ganze Gruppe löschen (unten)
  }

  const result = db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(req.params.groupId);
  if (result.changes === 0) return res.status(404).json({ error: 'Gruppe nicht gefunden' });
  pruneOrphanReminders(db);
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Planung löschen (einzeln oder Gruppe)
router.delete('/:id', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM planning_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Planung nicht gefunden' });

  // Self-Planer: nur Einträge, in denen er zugewiesen ist; bei geteilten nur die eigene Zuweisung entfernen.
  if (!canPlanAll(req.user)) {
    const sid = req.user.id;
    const entryIds = entry.group_id
      ? db.prepare('SELECT id FROM planning_entries WHERE group_id = ?').all(entry.group_id).map(r => r.id)
      : [entry.id];
    const current = entry.group_id ? assignedIdsOfGroup(db, entry.group_id) : assignedIdsOfEntry(db, entry.id);
    if (!current.includes(sid)) return res.status(403).json({ error: 'Das ist nicht deine Planung' });
    if (current.some(id => id !== sid)) {
      for (const pid of entryIds) {
        db.prepare('DELETE FROM planning_assignments WHERE planning_id = ? AND user_id = ?').run(pid, sid);
      }
      broadcast('planning', req.headers['x-tab-id']);
      return res.json({ success: true, unclinch: true });
    }
    // nur ihm zugewiesen → Eintrag/Gruppe löschen (unten)
  }

  // Wenn Gruppeneintrag: gesamte Gruppe löschen
  if (entry.group_id) {
    db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(entry.group_id);
  } else {
    db.prepare('DELETE FROM planning_entries WHERE id = ?').run(req.params.id);
  }
  pruneOrphanReminders(db);
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
