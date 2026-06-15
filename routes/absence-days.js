// Gemeinsame, prioritätsbewusste Zählung von Abwesenheitstagen.
//
// EINE Quelle der Wahrheit für /api/absences/summary UND die PDF-Erzeugung, damit beide
// Code-Pfade nie wieder auseinanderdriften (genau das war die Ursache des Bugs, bei dem
// die PDF Urlaub/FZA überzählte, wenn sich Krank damit überschnitt).
//
// Priorität: Feiertag > Krank/Berufsschule/Innung > Urlaub/FZA/Sonderurlaub.
// Schedule-bewusst: nur Tage mit Soll-Stunden > 0; Wochenenden zählen nie.
// Ohne hinterlegte Soll-Stunden gilt jeder Werktag als Arbeitstag (Verhalten wie zuvor).

// hasHours(dateStr): ist dieser Tag laut Schedule ein Arbeitstag? (kein Feiertag-Check)
function buildScheduleCheck(db, userId) {
  const schedRows = db.prepare(
    'SELECT hours_mon,hours_tue,hours_wed,hours_thu,hours_fri,valid_from FROM user_target_hours WHERE user_id = ? ORDER BY valid_from ASC'
  ).all(userId);
  const schKeys = [null, 'hours_mon', 'hours_tue', 'hours_wed', 'hours_thu', 'hours_fri', null];
  return function hasHours(dateStr) {
    const day = new Date(dateStr + 'T12:00:00').getDay();
    if (day === 0 || day === 6) return false;
    let active = schedRows[0];
    for (const t of schedRows) { if (t.valid_from <= dateStr) active = t; else break; }
    return active ? (active[schKeys[day]] || 0) > 0 : true;
  };
}

// Set aller Feiertags-Tage, die [from,to] überschneiden.
function buildHolidaySet(db, from, to) {
  const rows = db.prepare(
    "SELECT date_from, date_to FROM absences WHERE type='feiertag' AND status='active' AND date_from <= ? AND date_to >= ? AND deleted_at IS NULL"
  ).all(to, from);
  const set = new Set();
  for (const f of rows) {
    const c = new Date(f.date_from + 'T12:00:00'), e = new Date(f.date_to + 'T12:00:00');
    while (c <= e) { set.add(c.toISOString().slice(0, 10)); c.setDate(c.getDate() + 1); }
  }
  return set;
}

// Set der Tage (Soll>0, keine Feiertage) im Zeitraum, an denen eine Abwesenheit der
// angegebenen Typen liegt. Dient als Verdrängungs-Set für niedriger priorisierte Typen.
function buildDaySet(db, userId, types, from, to, hasHours, holidaySet) {
  const placeholders = types.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND status IN ('active','approved')
      AND type IN (${placeholders})
      AND date_from <= ? AND date_to >= ? AND deleted_at IS NULL
  `).all(userId, ...types, to, from);
  const set = new Set();
  for (const row of rows) {
    const ef = row.date_from > from ? row.date_from : from;
    const et = row.date_to < to ? row.date_to : to;
    if (ef > et) continue;
    const c = new Date(ef + 'T12:00:00'), e = new Date(et + 'T12:00:00');
    while (c <= e) {
      const ds = c.toISOString().slice(0, 10);
      if (hasHours(ds) && !holidaySet.has(ds)) set.add(ds);
      c.setDate(c.getDate() + 1);
    }
  }
  return set;
}

// Effektive Tage einer einzelnen (auf [ef,et] geklemmten) Abwesenheit unter Priorität:
// Feiertag > Krank > Berufsschule/Innung > Urlaub/FZA/Sonderurlaub.
function countTypeDays(absType, ef, et, hasHours, holidaySet, krankSet, schoolSet) {
  let n = 0;
  const cur = new Date(ef + 'T12:00:00'), end = new Date(et + 'T12:00:00');
  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    if (hasHours(ds)) {
      if (absType === 'feiertag') {
        n++;
      } else if (absType === 'krank') {
        if (!holidaySet.has(ds)) n++;
      } else if (absType === 'berufsschule' || absType === 'innung') {
        if (!holidaySet.has(ds) && !krankSet.has(ds)) n++; // Krank verdrängt Schule/Innung
      } else { // urlaub, sonderurlaub, freizeitausgleich
        if (!holidaySet.has(ds) && !krankSet.has(ds) && !schoolSet.has(ds)) n++;
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

// Übersicht für [from,to]: { summary: { <typ>: <tage> }, totalUniqueDays }
// - summary: pro Typ die effektiven (prioritätsbereinigten) Tage
// - totalUniqueDays: Anzahl eindeutiger Abwesenheitstage (Überschneidungen einmal gezählt)
function computeAbsenceSummary(db, userId, from, to) {
  const rows = db.prepare(`
    SELECT type, date_from, date_to FROM absences
    WHERE (
      (user_id = ? AND status IN ('active','approved'))
      OR (user_id IS NULL AND type = 'feiertag' AND status = 'active')
    )
    AND date_from <= ? AND date_to >= ? AND deleted_at IS NULL
  `).all(userId, to, from);

  const hasHours = buildScheduleCheck(db, userId);
  const holidaySet = buildHolidaySet(db, from, to);
  const krankSet = buildDaySet(db, userId, ['krank'], from, to, hasHours, holidaySet);
  const schoolSet = buildDaySet(db, userId, ['berufsschule', 'innung'], from, to, hasHours, holidaySet);

  const summary = {};
  const uniqueAbsenceDays = new Set();
  for (const row of rows) {
    const ef = row.date_from > from ? row.date_from : from;
    const et = row.date_to < to ? row.date_to : to;
    if (ef > et) continue;
    const days = countTypeDays(row.type, ef, et, hasHours, holidaySet, krankSet, schoolSet);
    if (days > 0) summary[row.type] = (summary[row.type] || 0) + days;
    const cur = new Date(ef + 'T12:00:00'), end = new Date(et + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds)) uniqueAbsenceDays.add(ds);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return { summary, totalUniqueDays: uniqueAbsenceDays.size };
}

// Genommene Urlaubstage (approved) in einem Kalenderjahr — Krank & Feiertage abgezogen.
function countUrlaubDaysInYear(db, userId, year) {
  const yStr = String(year);
  const from = yStr + '-01-01', to = yStr + '-12-31';

  const urlaubRows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND type = 'urlaub' AND status = 'approved'
    AND date_from <= ? AND date_to >= ? AND deleted_at IS NULL
  `).all(userId, to, from);

  const hasHours = buildScheduleCheck(db, userId);
  const holidaySet = buildHolidaySet(db, from, to);
  // Urlaub wird von Krank UND Berufsschule/Innung verdrängt
  const displaceSet = buildDaySet(db, userId, ['krank', 'berufsschule', 'innung'], from, to, hasHours, holidaySet);

  let count = 0;
  for (const row of urlaubRows) {
    const ef = row.date_from > from ? row.date_from : from;
    const et = row.date_to < to ? row.date_to : to;
    if (ef > et) continue;
    const cur = new Date(ef + 'T12:00:00'), end = new Date(et + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds) && !holidaySet.has(ds) && !displaceSet.has(ds)) count++;
      cur.setDate(cur.getDate() + 1);
    }
  }
  return count;
}

module.exports = {
  computeAbsenceSummary,
  countUrlaubDaysInYear,
  buildScheduleCheck,
  buildHolidaySet,
  buildDaySet,
  countTypeDays,
};
