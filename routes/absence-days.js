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

// Liste der effektiven Urlaubs-Arbeitstage (ISO-Daten) eines Kalenderjahres für einen Status
// ('approved' | 'pending'). Krank/Berufsschule/Innung + Feiertage verdrängen Urlaub (gleiche
// Priorität wie überall), Wochenenden/Nicht-Arbeitstage zählen nie.
function urlaubDaysInYear(db, userId, year, status) {
  const yStr = String(year);
  const from = yStr + '-01-01', to = yStr + '-12-31';

  const urlaubRows = db.prepare(`
    SELECT date_from, date_to FROM absences
    WHERE user_id = ? AND type = 'urlaub' AND status = ?
    AND date_from <= ? AND date_to >= ? AND deleted_at IS NULL
  `).all(userId, status, to, from);

  const hasHours = buildScheduleCheck(db, userId);
  const holidaySet = buildHolidaySet(db, from, to);
  // Urlaub wird von Krank UND Berufsschule/Innung verdrängt (nur genehmigte/aktive verdrängen)
  const displaceSet = buildDaySet(db, userId, ['krank', 'berufsschule', 'innung'], from, to, hasHours, holidaySet);

  const days = [];
  for (const row of urlaubRows) {
    const ef = row.date_from > from ? row.date_from : from;
    const et = row.date_to < to ? row.date_to : to;
    if (ef > et) continue;
    const cur = new Date(ef + 'T12:00:00'), end = new Date(et + 'T12:00:00');
    while (cur <= end) {
      const ds = cur.toISOString().slice(0, 10);
      if (hasHours(ds) && !holidaySet.has(ds) && !displaceSet.has(ds)) days.push(ds);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return days;
}

// Genommene Urlaubstage (approved) in einem Kalenderjahr — Krank & Feiertage abgezogen.
function countUrlaubDaysInYear(db, userId, year) {
  return urlaubDaysInYear(db, userId, year, 'approved').length;
}

// Genehmigten Urlaub eines Jahres am Stichtag `nowStr` aufteilen:
// genommen = Datum ≤ heute (Vergangenheit), geplant = Datum > heute (Zukunft).
function urlaubSplitInYear(db, userId, year, nowStr) {
  const days = urlaubDaysInYear(db, userId, year, 'approved');
  let genommen = 0, geplant = 0;
  for (const ds of days) { if (ds <= nowStr) genommen++; else geplant++; }
  return { genommen, geplant };
}

// Offen beantragte (pending) Urlaubstage eines Jahres.
function countUrlaubPendingInYear(db, userId, year) {
  return urlaubDaysInYear(db, userId, year, 'pending').length;
}

const rnd2 = v => Math.round(v * 100) / 100;

// Für ein Jahr geltende Anspruchszeile (jüngstes valid_from ≤ Jahresende) → { days, carryover_mode,
// carryover_until }. Keine Zeile ≤ Jahr (oder Tabelle fehlt) ⇒ Anspruch 0, Modus 'yearend'.
function entitlementFor(db, userId, year) {
  const cutoff = String(year) + '-12-31';
  let row = null;
  try {
    row = db.prepare(
      `SELECT days, carryover_mode, carryover_until FROM vacation_entitlements
       WHERE user_id = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1`
    ).get(userId, cutoff);
  } catch (_) { row = null; }
  if (!row) return { days: 0, carryover_mode: 'yearend', carryover_until: null };
  return {
    days: row.days || 0,
    carryover_mode: row.carryover_mode || 'yearend',
    carryover_until: row.carryover_until || null,
  };
}

// Jahr des ersten Anspruch-Eintrags (Start der Übertrag-Rekurrenz) oder null.
function firstEntitlementYear(db, userId) {
  try {
    const r = db.prepare('SELECT MIN(valid_from) AS d FROM vacation_entitlements WHERE user_id = ?').get(userId);
    if (r && r.d) return parseInt(String(r.d).slice(0, 4), 10);
  } catch (_) {}
  return null;
}

// Vollständiges Urlaubskonto für ein Jahr am Stichtag `now` (Date oder ISO-String; Default heute).
// Übertrag läuft als Jahres-Rekurrenz ab dem ersten Anspruch-Jahr; der Verfallsmodus der FÜR EIN
// JAHR geltenden Zeile bestimmt, was in das Folgejahr getragen wird (yearend=0, never=Rest,
// date=Rest bis zum Stichtag im Folgejahr, danach verfallen). Vergangene Jahre bleiben unberührt.
function vacationAccount(db, userId, year, now) {
  const nowStr = now instanceof Date
    ? now.toISOString().slice(0, 10)
    : (typeof now === 'string' && now ? now.slice(0, 10) : new Date().toISOString().slice(0, 10));

  const { genommen, geplant } = urlaubSplitInYear(db, userId, year, nowStr);
  const anspruch = entitlementFor(db, userId, year).days;

  // Start-Resturlaub = einmaliger Übertrag ins erste erfasste Anspruchsjahr (carry_in(startYear)).
  let startCarry = 0;
  try { const r = db.prepare('SELECT vacation_start_carry FROM users WHERE id = ?').get(userId); startCarry = (r && r.vacation_start_carry) || 0; } catch (_) {}

  let uebertrag = 0;
  const startYear = firstEntitlementYear(db, userId);
  if (startYear != null && year >= startYear) {
    let carry = startCarry; // carry_in(startYear)
    for (let y = startYear; y < year; y++) {
      const ent = entitlementFor(db, userId, y);
      const split = urlaubSplitInYear(db, userId, y, nowStr);
      const leftover = ent.days + carry - split.genommen - split.geplant;
      if (ent.carryover_mode === 'never') {
        carry = leftover;
      } else if (ent.carryover_mode === 'date' && ent.carryover_until) {
        const expiry = String(y + 1) + '-' + ent.carryover_until; // 'MM-DD'
        carry = nowStr > expiry ? 0 : leftover;
      } else {
        carry = 0; // 'yearend' (Standard)
      }
    }
    uebertrag = carry; // carry_in(year); bei year==startYear = startCarry
  }

  const verfuegbar = anspruch + uebertrag;
  return {
    anspruch: rnd2(anspruch),
    uebertrag: rnd2(uebertrag),
    verfuegbar: rnd2(verfuegbar),
    genommen: rnd2(genommen),
    geplant: rnd2(geplant),
    nochZuPlanen: rnd2(verfuegbar - genommen - geplant),
    rest: rnd2(verfuegbar - genommen),
  };
}

module.exports = {
  computeAbsenceSummary,
  countUrlaubDaysInYear,
  urlaubDaysInYear,
  urlaubSplitInYear,
  countUrlaubPendingInYear,
  entitlementFor,
  firstEntitlementYear,
  vacationAccount,
  buildScheduleCheck,
  buildHolidaySet,
  buildDaySet,
  countTypeDays,
};
