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
function materializeSeries(db, createdBy, rule, template, assignedUserIds, occurrences, materializedUntil) {
  const seriesId = crypto.randomUUID();
  const insEntry = db.prepare(`INSERT INTO planning_entries
    (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAssign = db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)');
  for (const occStart of occurrences) {
    const groupId = crypto.randomUUID(); // jede Wiederholung ist eine Gruppe (auch eintägig)
    for (const td of template.tplDays) {
      const date = addDaysISO(occStart, td.offset);
      const r = insEntry.run(createdBy, date, td.time_from, td.time_to, td.break_minutes,
        template.address, template.client, template.project_id, template.project_text, template.description,
        groupId, template.color, seriesId, occStart);
      for (const uid of assignedUserIds) insAssign.run(r.lastInsertRowid, uid);
    }
  }
  db.prepare(`INSERT INTO planning_series
    (series_id, created_by, freq, anchor_date, interval_weeks, end_type, end_count, end_until, template, materialized_until, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    seriesId, createdBy, rule.freq, rule.anchor_date, rule.interval_weeks, rule.end_type,
    rule.end_count || null, rule.end_until || null,
    JSON.stringify({ tplDays: template.tplDays, assigned_user_ids: assignedUserIds, address: template.address, client: template.client, project_id: template.project_id, project_text: template.project_text, description: template.description, color: template.color }),
    materializedUntil);
  return seriesId;
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
    // Alte Einträge der Gruppe löschen (CASCADE löscht auch assignments)
    db.prepare('DELETE FROM planning_entries WHERE group_id = ?').run(groupId);

    // Entscheide ob weiterhin Gruppe oder Einzeleintrag
    const newGroupId = days.length > 1 ? groupId : null;

    const ids = [];
    for (const day of days) {
      if (!day.date || !day.time_from || !day.time_to) continue;
      const result = db.prepare(`
        INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, day.date, day.time_from, day.time_to, day.break_minutes || 0, address || '', client || '', project_id || null, project_text || '', description || '', newGroupId, color || '#f59e0b');

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
          INSERT INTO planning_entries (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          originalCreatedAt
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
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

// Serie beenden: künftige Vorkommen (ab heute) entfernen, Vergangenes bleibt.
router.post('/series/:seriesId/stop', authenticate, canPlan, (req, res) => {
  const db = getDb();
  const series = loadSeriesOr(req, res, db);
  if (!series) return;
  const today = todayISO();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM planning_entries WHERE series_id = ? AND occurrence_date >= ?').run(series.series_id, today);
    db.prepare("UPDATE planning_series SET active=0, end_type='until', end_until=?, materialized_until=? WHERE series_id=?")
      .run(addDaysISO(today, -1), addDaysISO(today, -1), series.series_id);
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
  broadcast('planning', req.headers['x-tab-id']);
  res.json({ success: true });
});

module.exports = router;
