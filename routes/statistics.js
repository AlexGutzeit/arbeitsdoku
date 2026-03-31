const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Arbeitstage zwischen zwei Daten zählen
function countWeekdays(from, to) {
  let count = 0;
  const s = new Date(from + 'T12:00:00');
  const e = new Date(to + 'T12:00:00');
  const c = new Date(s);
  while (c <= e) {
    const day = c.getDay();
    if (day !== 0 && day !== 6) count++;
    c.setDate(c.getDate() + 1);
  }
  return count;
}

// Soll-Stunden für einen Zeitraum berechnen (berücksichtigt Änderungen)
function calcTargetHours(db, userId, from, to) {
  const targets = db.prepare(
    'SELECT hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from ASC'
  ).all(userId);

  const dayKeys = [null, 'hours_mon', 'hours_tue', 'hours_wed', 'hours_thu', 'hours_fri', null]; // 0=So, 6=Sa

  if (targets.length === 0) return countWeekdays(from, to) * 8;

  let total = 0;
  const startDate = new Date(from + 'T12:00:00');
  const endDate = new Date(to + 'T12:00:00');

  const cur = new Date(startDate);
  while (cur <= endDate) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) {
      const dateStr = fmtDate(cur);
      let active = targets[0];
      for (const t of targets) {
        if (t.valid_from <= dateStr) active = t;
        else break;
      }
      total += active[dayKeys[day]] || 0;
    }
    cur.setDate(cur.getDate() + 1);
  }

  return Math.round(total * 100) / 100;
}

// Frühestes valid_from aus user_target_hours ermitteln
function getEarliestTargetDate(db, userId) {
  const row = db.prepare('SELECT MIN(valid_from) as earliest FROM user_target_hours WHERE user_id = ?').get(userId);
  return row?.earliest || null;
}

// Tatsächliche Arbeitszeit: überlappende Einträge nicht doppelt zählen
function calcActualHours(entries) {
  const groups = {};
  for (const e of entries) {
    const key = `${e.user_id}_${e.date}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  let total = 0;
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    const intervals = group.map(e => {
      const [fh, fm] = e.time_from.split(':').map(Number);
      const [th, tm] = e.time_to.split(':').map(Number);
      return { from: fh * 60 + fm, to: th * 60 + tm, breakMin: e.break_minutes || 0 };
    }).filter(i => i.to > i.from).sort((a, b) => a.from - b.from);
    if (!intervals.length) continue;
    const merged = [{ from: intervals[0].from, to: intervals[0].to }];
    let totalBreak = intervals[0].breakMin;
    for (let i = 1; i < intervals.length; i++) {
      const cur = intervals[i];
      const last = merged[merged.length - 1];
      totalBreak += cur.breakMin;
      if (cur.from <= last.to) {
        last.to = Math.max(last.to, cur.to);
      } else {
        merged.push({ from: cur.from, to: cur.to });
      }
    }
    const bruttoMin = merged.reduce((s, i) => s + (i.to - i.from), 0);
    const netMin = Math.max(0, bruttoMin - totalBreak);
    total += netMin / 60;
  }
  return Math.round(total * 100) / 100;
}

// Effektiven Startzeitpunkt für einen User ermitteln (max von range.from und frühestem Soll-Stunden-Datum)
function clampFrom(from, earliest) {
  if (!earliest) return from;
  const e = earliest.slice(0, 10);
  return e > from ? e : from;
}

// Statistik-Daten abrufen
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const { user_ids, period, date } = req.query;
  const role = req.user.role;

  let targetUserIds = [];
  if (role === 'mitarbeiter') {
    targetUserIds = [req.user.id];
  } else {
    if (user_ids) {
      targetUserIds = user_ids.split(',').map(Number);
    } else {
      const allUsers = db.prepare("SELECT id FROM users WHERE role != 'admin'").all();
      targetUserIds = allUsers.map(u => u.id);
    }
  }

  const refDate = date ? new Date(date + 'T12:00:00') : new Date();
  let ranges = [];

  if (period === 'day') {
    const d = fmtDate(refDate);
    ranges = [{ from: d, to: d, label: formatDE(d) }];
  } else if (period === 'week') {
    const wr = getWeekRange(refDate);
    ranges = [{ ...wr, label: `KW ${getISOWeek(refDate)} | ${formatDE(wr.from)} - ${formatDE(wr.to)}` }];
  } else if (period === 'month') {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last = new Date(y, m + 1, 0);
    const to = fmtDate(last);
    const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    ranges = [{ from, to, label: `${monthNames[m]} ${y}` }];
  } else if (period === 'year') {
    const y = refDate.getFullYear();
    ranges = [{ from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` }];
  } else {
    // Gesamt: ab erstem Eintrag
    const first = db.prepare(
      'SELECT MIN(date) as min_date FROM entries WHERE user_id IN (' + targetUserIds.map(() => '?').join(',') + ')'
    ).get(...targetUserIds);
    const from = first?.min_date || fmtDate(refDate);
    const to = fmtDate(refDate);
    ranges = [{ from, to, label: 'Gesamt' }];
  }

  // Zeitverlauf
  let timeline = [];
  const mainRange = ranges[0];

  if (period === 'year') {
    const y = refDate.getFullYear();
    const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    for (let m = 0; m < 12; m++) {
      const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = new Date(y, m + 1, 0);
      const to = fmtDate(last);
      timeline.push({ from, to, label: monthNames[m] });
    }
  } else if (period === 'month') {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      timeline.push({ from: ds, to: ds, label: String(d) });
    }
  } else if (period === 'week') {
    const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const start = new Date(mainRange.from + 'T12:00:00');
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const ds = fmtDate(d);
      timeline.push({ from: ds, to: ds, label: dayNames[i] });
    }
  } else if (period === 'total') {
    const startD = new Date(mainRange.from + 'T12:00:00');
    const endD = new Date(mainRange.to + 'T12:00:00');
    const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    while (cur <= endD) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const from = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = new Date(y, m + 1, 0);
      const to = fmtDate(last);
      timeline.push({ from, to, label: `${monthNames[m]} ${String(y).slice(2)}` });
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  // Daten berechnen
  const userStats = [];
  for (const uid of targetUserIds) {
    const user = db.prepare('SELECT id, name, role, start_overtime FROM users WHERE id = ?').get(uid);
    if (!user) continue;

    const startOvertime = user.start_overtime || 0;
    const earliest = getEarliestTargetDate(db, uid);
    const userFrom = clampFrom(mainRange.from, earliest);

    // Liegt der gesamte Zeitraum vor der User-Erstellung? → alles 0
    if (userFrom > mainRange.to) {
      userStats.push({
        user_id: uid, user_name: user.name, role: user.role,
        ist: 0, soll: 0, ueber: 0, start_overtime: startOvertime,
        ueber_gesamt: startOvertime, projects: [],
        timeline: timeline.map(t => ({ label: t.label, ist: 0, soll: 0 })),
      });
      continue;
    }

    // Ist/Soll für den gewählten Zeitraum
    const entries = db.prepare(
      'SELECT date, time_from, time_to, break_minutes, net_hours, user_id, project_id, project_text FROM entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'
    ).all(uid, userFrom, mainRange.to);

    const ist = calcActualHours(entries);
    const soll = calcTargetHours(db, uid, userFrom, mainRange.to);
    const ueber = ist - soll;

    // Kumulierte Überstunden: vom allerersten Tag bis Ende des gewählten Zeitraums
    let ueberGesamt = startOvertime;
    if (earliest) {
      const allEntries = db.prepare(
        'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'
      ).all(uid, earliest, mainRange.to);
      const gesamtIst = calcActualHours(allEntries);
      const gesamtSoll = calcTargetHours(db, uid, earliest, mainRange.to);
      ueberGesamt = startOvertime + gesamtIst - gesamtSoll;
    }

    // Projekt-Aufschlüsselung
    const projectMap = {};
    for (const e of entries) {
      const key = e.project_id ? `p_${e.project_id}` : (e.project_text || 'Sonstige');
      if (!projectMap[key]) {
        let name = 'Sonstige';
        if (e.project_id) {
          const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(e.project_id);
          name = p ? p.name : `Projekt ${e.project_id}`;
        } else if (e.project_text) {
          name = e.project_text;
        }
        projectMap[key] = { name, hours: 0, project_id: e.project_id };
      }
      projectMap[key].hours += e.net_hours;
    }

    // Timeline-Daten — Zeitraum pro Bucket auf User-Erstellung clampen
    const timelineData = timeline.map(t => {
      const tFrom = clampFrom(t.from, earliest);
      if (tFrom > t.to) return { label: t.label, ist: 0, soll: 0 };
      const tEntriesRows = db.prepare(
        'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ?'
      ).all(uid, tFrom, t.to);
      const tIst = calcActualHours(tEntriesRows);
      const tSoll = calcTargetHours(db, uid, tFrom, t.to);
      return { label: t.label, ist: Math.round(tIst * 100) / 100, soll: Math.round(tSoll * 100) / 100 };
    });

    userStats.push({
      user_id: uid,
      user_name: user.name,
      role: user.role,
      ist: Math.round(ist * 100) / 100,
      soll: Math.round(soll * 100) / 100,
      ueber: Math.round(ueber * 100) / 100,
      start_overtime: startOvertime,
      ueber_gesamt: Math.round(ueberGesamt * 100) / 100,
      projects: Object.values(projectMap).sort((a, b) => b.hours - a.hours),
      timeline: timelineData,
    });
  }

  const combined = {
    ist: Math.round(userStats.reduce((s, u) => s + u.ist, 0) * 100) / 100,
    soll: Math.round(userStats.reduce((s, u) => s + u.soll, 0) * 100) / 100,
    ueber: Math.round(userStats.reduce((s, u) => s + u.ueber, 0) * 100) / 100,
    start_overtime: Math.round(userStats.reduce((s, u) => s + u.start_overtime, 0) * 100) / 100,
    ueber_gesamt: Math.round(userStats.reduce((s, u) => s + u.ueber_gesamt, 0) * 100) / 100,
  };

  const combinedTimeline = timeline.map((t, i) => ({
    label: t.label,
    ist: Math.round(userStats.reduce((s, u) => s + u.timeline[i].ist, 0) * 100) / 100,
    soll: Math.round(userStats.reduce((s, u) => s + u.timeline[i].soll, 0) * 100) / 100,
  }));

  res.json({
    range: mainRange,
    period: period || 'total',
    users: userStats,
    combined,
    combinedTimeline,
  });
});

// Kumulierte Überstunden: start_overtime + alle Differenzen vom ersten Arbeitstag bis heute
router.get('/overtime', authenticate, (req, res) => {
  const db = getDb();
  const uid = req.user.role === 'mitarbeiter' ? req.user.id : (req.query.user_id ? Number(req.query.user_id) : req.user.id);
  if (req.user.role === 'mitarbeiter' && uid !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const user = db.prepare('SELECT id, start_overtime FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden' });

  const startOvertime = user.start_overtime || 0;
  const earliest = getEarliestTargetDate(db, uid);
  if (!earliest) return res.json({ overtime: startOvertime });

  const dateTo = req.query.date_to || fmtDate(new Date());
  const entries = db.prepare(
    'SELECT date, time_from, time_to, break_minutes, net_hours, user_id FROM entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'
  ).all(uid, earliest, dateTo);

  const ist = calcActualHours(entries);
  const soll = calcTargetHours(db, uid, earliest, dateTo);
  const overtime = Math.round((startOvertime + ist - soll) * 100) / 100;
  res.json({ overtime });
});

// Soll-Stunden für einen Zeitraum berechnen
router.get('/target-hours', authenticate, (req, res) => {
  const db = getDb();
  const { user_id, date_from, date_to } = req.query;
  const uid = req.user.role === 'mitarbeiter' ? req.user.id : (user_id ? Number(user_id) : req.user.id);
  if (req.user.role === 'mitarbeiter' && uid !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  if (!date_from || !date_to) {
    return res.status(400).json({ error: 'date_from und date_to sind Pflichtfelder' });
  }
  const from = clampFrom(date_from, getEarliestTargetDate(db, uid));
  const hours = from > date_to ? 0 : calcTargetHours(db, uid, from, date_to);
  res.json({ target_hours: hours });
});

// Soll-Stunden-Historie für einen User
router.get('/targets/:userId', authenticate, (req, res) => {
  const db = getDb();
  if (req.user.role === 'mitarbeiter' && req.user.id !== Number(req.params.userId)) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const targets = db.prepare(
    'SELECT id, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC'
  ).all(req.params.userId);
  res.json({ targets });
});

// Soll-Stunden-Eintrag hinzufügen
router.post('/targets/:userId', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'chef') {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const db = getDb();
  const { hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from } = req.body;
  if (!valid_from) {
    return res.status(400).json({ error: 'Gültig-ab-Datum ist Pflichtfeld' });
  }

  const hpw = (hours_mon || 0) + (hours_tue || 0) + (hours_wed || 0) + (hours_thu || 0) + (hours_fri || 0);

  db.prepare('INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    Number(req.params.userId), hpw, hours_mon || 0, hours_tue || 0, hours_wed || 0, hours_thu || 0, hours_fri || 0, valid_from
  );

  const latest = db.prepare(
    'SELECT id FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC LIMIT 1'
  ).get(req.params.userId);
  db.prepare('UPDATE users SET target_hours_per_week = ? WHERE id = ?').run(hpw, req.params.userId);

  const targets = db.prepare(
    'SELECT id, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC'
  ).all(req.params.userId);
  res.json({ targets });
});

// Soll-Stunden-Eintrag bearbeiten
router.put('/targets/:userId/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'chef') {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const db = getDb();
  const { hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from } = req.body;
  if (!valid_from) {
    return res.status(400).json({ error: 'Gültig-ab-Datum ist Pflichtfeld' });
  }

  const hpw = (hours_mon || 0) + (hours_tue || 0) + (hours_wed || 0) + (hours_thu || 0) + (hours_fri || 0);

  db.prepare('UPDATE user_target_hours SET hours_per_week = ?, hours_mon = ?, hours_tue = ?, hours_wed = ?, hours_thu = ?, hours_fri = ?, valid_from = ? WHERE id = ? AND user_id = ?').run(
    hpw, hours_mon || 0, hours_tue || 0, hours_wed || 0, hours_thu || 0, hours_fri || 0, valid_from, req.params.id, req.params.userId
  );

  // Aktuellsten Wert in users aktualisieren
  const latest = db.prepare(
    'SELECT hours_per_week FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC LIMIT 1'
  ).get(req.params.userId);
  if (latest) {
    db.prepare('UPDATE users SET target_hours_per_week = ? WHERE id = ?').run(latest.hours_per_week, req.params.userId);
  }

  const targets = db.prepare(
    'SELECT id, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC'
  ).all(req.params.userId);
  res.json({ targets });
});

// Soll-Stunden-Eintrag löschen
router.delete('/targets/:userId/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'chef') {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM user_target_hours WHERE user_id = ?').get(req.params.userId);
  if (count.c <= 1) {
    return res.status(400).json({ error: 'Mindestens ein Soll-Stunden-Eintrag muss bestehen bleiben' });
  }
  db.prepare('DELETE FROM user_target_hours WHERE id = ? AND user_id = ?').run(req.params.id, req.params.userId);

  const latest = db.prepare(
    'SELECT hours_per_week FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC LIMIT 1'
  ).get(req.params.userId);
  if (latest) {
    db.prepare('UPDATE users SET target_hours_per_week = ? WHERE id = ?').run(latest.hours_per_week, req.params.userId);
  }

  const targets = db.prepare(
    'SELECT id, hours_per_week, valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from DESC'
  ).all(req.params.userId);
  res.json({ targets });
});

// Hilfsfunktionen
function formatDE(d) {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

function getWeekRange(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { from: fmtDate(mon), to: fmtDate(sun) };
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

module.exports = router;
module.exports.calcTargetHours = calcTargetHours;
module.exports.calcActualHours = calcActualHours;
module.exports.fmtDate = fmtDate;
module.exports.getEarliestTargetDate = getEarliestTargetDate;
module.exports.clampFrom = clampFrom;
