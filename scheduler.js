// Geplante Zusammenfassungen (Digest-Push): prüft jede Minute, ob ein Plan fällig ist, baut aus den
// Badge-Zählern eine Nachricht und schickt sie per notifyUsers (Kategorie null → unabhängig von den
// Kategorie-Schaltern). isDue()/buildSummaryText()/berlinParts() sind reine Funktionen (testbar).
const crypto = require('crypto');
const { computeBadgeCounts } = require('./routes/badges');
const push = require('./push');
const recur = require('./planning-recurrence');

const addDaysISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonthsISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const SERIES_HORIZON_MONTHS = 24;

const VALID_CATS = ['orders', 'absences', 'bulletin', 'notes'];
const CAT_LABELS = { orders: 'Bestellungen', absences: 'Abwesenheiten', bulletin: 'Aushänge', notes: 'Notizen' };

// Berlin-Datum/Uhrzeit/Wochentag (1=Mo … 7=So) aus einem Date.
function berlinParts(now = new Date()) {
  const s = now.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }); // "YYYY-MM-DD HH:MM:SS"
  const wd = now.toLocaleDateString('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }); // Mon..Sun
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { date: s.slice(0, 10), hhmm: s.slice(11, 16), weekday: map[wd] };
}

// Fällig? Rein — ohne Global-Pause (die prüft tick() separat, weil sie den Nutzer braucht).
function isDue(schedule, weekday, hhmm, dateStamp) {
  if (schedule.paused) return false;
  if (schedule.time !== hhmm) return false;
  const days = String(schedule.weekdays || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!days.includes(String(weekday))) return false;
  if (schedule.last_fired === dateStamp) return false; // in dieser Minute bereits gefeuert
  return true;
}

// Nachricht aus den ausgewählten Kategorien + Zählern.
function buildSummaryText(cats, counts) {
  const parts = [];
  for (const c of cats) {
    const n = counts[c] || 0;
    if (n > 0) parts.push(`${n} ${CAT_LABELS[c] || c}`);
  }
  if (parts.length === 0) return 'Es gibt nichts zu tun.';
  const list = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' und ' + parts[parts.length - 1];
  return `Du hast noch ${list} zu bearbeiten.`;
}

// ===== Planungs-Erinnerungen (Push vor einem Termin) =====
const WD_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']; // getUTCDay: 0=So

// Wall-Clock "YYYY-MM-DD HH:MM" um Vorlauf zurückrechnen (UTC-Arithmetik auf der Wanduhr; DST-Sprünge
// von 1 h sind für Erinnerungen unerheblich). Liefert wieder "YYYY-MM-DD HH:MM".
function shiftWall(wallStr, num, unit) {
  const d = new Date(wallStr.replace(' ', 'T') + ':00Z');
  if (unit === 'hour') d.setUTCHours(d.getUTCHours() - num);
  else if (unit === 'day') d.setUTCDate(d.getUTCDate() - num);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() - num * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - num);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
// "YYYY-MM-DD HH:MM" → "Fr 10.07. um 07:00"
function fmtWall(wallStr) {
  const [d, t] = wallStr.split(' ');
  const dt = new Date(d + 'T00:00:00Z');
  const [, mo, da] = d.split('-');
  return `${WD_DE[dt.getUTCDay()]} ${da}.${mo}. um ${t}`;
}

// Betroffene Vorkommen einer Erinnerung als [{occ_key, startWall}] (startWall = frühester Tag + time_from).
// occurrence: genau eines (group_id oder entry_id); series: alle materialisierten Vorkommen.
function reminderOccurrences(db, r) {
  if (r.target_type === 'series') {
    const rows = db.prepare(`SELECT occurrence_date AS occ, MIN(date || ' ' || time_from) AS startwall
      FROM planning_entries WHERE series_id = ? GROUP BY occurrence_date`).all(r.series_id);
    return rows.filter(x => x.startwall).map(x => ({ occ_key: x.occ, startWall: x.startwall.slice(0, 16) }));
  }
  if (r.group_id) {
    const x = db.prepare(`SELECT MIN(date || ' ' || time_from) AS startwall FROM planning_entries WHERE group_id = ?`).get(r.group_id);
    return (x && x.startwall) ? [{ occ_key: 'g:' + r.group_id, startWall: x.startwall.slice(0, 16) }] : [];
  }
  const x = db.prepare(`SELECT (date || ' ' || time_from) AS startwall FROM planning_entries WHERE id = ?`).get(r.entry_id);
  return (x && x.startwall) ? [{ occ_key: 'e:' + r.entry_id, startWall: x.startwall.slice(0, 16) }] : [];
}

// Fällige, noch nicht gesendete Vorkommen eines Nutzers. Leer, wenn „Planung" pausiert ist (dann wird
// NICHTS gesendet UND NICHTS protokolliert → Erinnerungen bleiben erhalten, kommen nach Wieder-an).
function collectDueForUser(db, userId, nowParts) {
  const pref = db.prepare('SELECT planning FROM push_prefs WHERE user_id = ?').get(userId);
  if (pref && pref.planning === 0) return [];
  const nowWall = nowParts.date + ' ' + nowParts.hhmm;
  const reminders = db.prepare('SELECT * FROM planning_reminders WHERE user_id = ?').all(userId);
  const out = [];
  for (const r of reminders) {
    for (const occ of reminderOccurrences(db, r)) {
      const fireWall = shiftWall(occ.startWall, r.lead_num, r.lead_unit);
      if (nowWall < fireWall) continue;        // noch nicht fällig
      if (nowWall >= occ.startWall) continue;  // Termin vorbei
      const done = db.prepare('SELECT 1 FROM planning_reminder_sent WHERE reminder_id = ? AND occ_key = ?').get(r.id, occ.occ_key);
      if (done) continue;
      out.push({ r, occ_key: occ.occ_key, startWall: occ.startWall });
    }
  }
  return out;
}

// Repräsentativer Eintrag des Vorkommens (für Kunde/Beschreibung + Zuweisung).
function occurrenceRepEntry(db, r, occKey) {
  if (r.target_type === 'series') return db.prepare(`SELECT * FROM planning_entries WHERE series_id = ? AND occurrence_date = ? ORDER BY date, time_from LIMIT 1`).get(r.series_id, occKey);
  if (r.group_id) return db.prepare(`SELECT * FROM planning_entries WHERE group_id = ? ORDER BY date, time_from LIMIT 1`).get(r.group_id);
  return db.prepare(`SELECT * FROM planning_entries WHERE id = ?`).get(r.entry_id);
}
function reminderParts(db, r, occKey, startWall) {
  const e = occurrenceRepEntry(db, r, occKey);
  const label = (e && (e.client || e.description)) || 'Termin';
  const names = e ? db.prepare('SELECT u.name FROM planning_assignments pa JOIN users u ON u.id = pa.user_id WHERE pa.planning_id = ?').all(e.id).map(x => x.name) : [];
  const assignedIds = e ? db.prepare('SELECT user_id FROM planning_assignments WHERE planning_id = ?').all(e.id).map(x => x.user_id) : [];
  return { label, names, own: assignedIds.includes(r.user_id), when: fmtWall(startWall) };
}
// Einzel-Push (eine Erinnerung).
function buildReminderPush(db, r, occKey, startWall) {
  const { label, names, own, when } = reminderParts(db, r, occKey, startWall);
  const body = own ? `Am ${when}: ${label}` : `${(names.join(', ') || 'Mitarbeiter')} hat am ${when} einen Termin: ${label}`;
  return { title: '🔔 Erinnerung', body, url: '/planning' };
}
// Zeile fürs Digest-Bündel.
function reminderLine(db, r, occKey, startWall) {
  const { label, names, own, when } = reminderParts(db, r, occKey, startWall);
  return own ? `• ${when} – ${label}` : `• ${when} – ${(names.join(', ') || 'Mitarbeiter')}: ${label}`;
}
// Läuft irgendwann zwischen JETZT und dem Termin ein aktiver Digest (geplante Zusammenfassung)? → eine
// „geplante" Erinnerung dem Digest überlassen. Prüft die Tage von heute bis zum Termintag (Berlin).
function digestRunsBefore(db, userId, nowParts, apptStartWall) {
  const pref = db.prepare('SELECT summaries_paused FROM push_prefs WHERE user_id = ?').get(userId);
  if (pref && pref.summaries_paused === 1) return false;
  let scheds; try { scheds = db.prepare('SELECT * FROM summary_schedules WHERE user_id = ?').all(userId); } catch (_) { return false; }
  const active = scheds.filter(s => !s.paused && String(s.weekdays || '').split(',').map(x => x.trim()).filter(Boolean).length);
  if (!active.length) return false;
  const nowWall = nowParts.date + ' ' + nowParts.hhmm;
  const apptDate = apptStartWall.slice(0, 10);
  let d = nowParts.date, guard = 0;
  while (d <= apptDate && guard++ < 400) {
    const dt = new Date(d + 'T00:00:00Z');
    const wd = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay();
    for (const s of active) {
      const days = String(s.weekdays || '').split(',').map(x => x.trim());
      if (!days.includes(String(wd))) continue;
      const runWall = d + ' ' + s.time;
      if (runWall > nowWall && runWall < apptStartWall) return true;
    }
    dt.setUTCDate(dt.getUTCDate() + 1); d = dt.toISOString().slice(0, 10);
  }
  return false;
}
function markSent(db, reminderId, occKey) {
  db.prepare('INSERT OR IGNORE INTO planning_reminder_sent (reminder_id, occ_key) VALUES (?, ?)').run(reminderId, occKey);
}

// Einzelversand aller fälligen Erinnerungen, die nicht in ein heutiges Digest fallen. now injizierbar.
async function firePlanningReminders(db, now = new Date()) {
  const nowParts = berlinParts(now);
  let userIds;
  try { userIds = db.prepare('SELECT DISTINCT user_id FROM planning_reminders').all().map(r => r.user_id); } catch (_) { return 0; }
  let sent = 0;
  for (const uid of userIds) {
    const due = collectDueForUser(db, uid, nowParts);
    for (const d of due) {
      // „Geplante" Erinnerung (scheduled=1): dem Digest überlassen, solange bis zum Termin noch einer läuft.
      // Sonst (kein passender Digest → Fallback) bzw. exakte Erinnerung (scheduled=0) → jetzt einzeln senden.
      if (d.r.scheduled === 1 && digestRunsBefore(db, uid, nowParts, d.startWall)) continue;
      const payload = buildReminderPush(db, d.r, d.occ_key, d.startWall);
      markSent(db, d.r.id, d.occ_key); // vor Versand → kein Doppelversand bei überlappenden Ticks
      try { await push.notifyUsers(db, [uid], 'planning', payload); }
      catch (e) { console.error('Planungs-Erinnerung fehlgeschlagen:', e && e.message); }
      sent++;
    }
  }
  return sent;
}

// Ein Durchlauf: fällige Pläne feuern. Gibt die gefeuerten Pläne zurück (für Tests). now injizierbar.
async function tick(db, now = new Date()) {
  const { date, hhmm, weekday } = berlinParts(now);
  const dateStamp = date + ' ' + hhmm;
  const fired = [];
  let schedules;
  try { schedules = db.prepare('SELECT * FROM summary_schedules').all(); } catch (_) { return fired; }
  for (const s of schedules) {
    if (!isDue(s, weekday, hhmm, dateStamp)) continue;
    const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(s.user_id);
    if (!user || user.active === 0) continue;
    const pref = db.prepare('SELECT summaries_paused FROM push_prefs WHERE user_id = ?').get(s.user_id);
    if (pref && pref.summaries_paused === 1) continue; // Global-Pause (Urlaub)
    const cats = String(s.cats || '').split(',').map(x => x.trim()).filter(c => VALID_CATS.includes(c));
    let body = buildSummaryText(cats, computeBadgeCounts(db, user));
    // Fällige „geplante" Planungs-Erinnerungen (scheduled=1) dieses Nutzers ins Digest bündeln (nur wenn
    // „Planung" an — die Pause-Regel steckt in collectDueForUser). Exakte (scheduled=0) kommen einzeln.
    let dueReminders = [];
    try { dueReminders = collectDueForUser(db, s.user_id, { date, hhmm, weekday }).filter(d => d.r.scheduled === 1); } catch (_) {}
    if (dueReminders.length) {
      body += '\n\nAnstehende Termine:\n' + dueReminders.map(d => reminderLine(db, d.r, d.occ_key, d.startWall)).join('\n');
      for (const d of dueReminders) markSent(db, d.r.id, d.occ_key);
    }
    // Name als Titel (z. B. „Einkaufen"), sonst ein generischer Titel.
    const title = (s.name && s.name.trim()) ? s.name.trim() : '🔔 Deine Zusammenfassung';
    // last_fired VOR dem Versand setzen → kein Doppelversand bei überlappenden Ticks/Neustart.
    db.prepare('UPDATE summary_schedules SET last_fired = ? WHERE id = ?').run(dateStamp, s.id);
    try {
      await push.notifyUsers(db, [s.user_id], null, { title, body, url: '/' });
    } catch (e) { console.error('Zusammenfassungs-Push fehlgeschlagen:', e && e.message); }
    fired.push({ id: s.id, user_id: s.user_id, title, body });
  }
  // Nach den Digests: fällige Erinnerungen einzeln senden (die, die in kein heutiges Digest fallen).
  try { await firePlanningReminders(db, now); } catch (e) { console.error('firePlanningReminders fehlgeschlagen:', e && e.message); }
  return fired;
}

// Rollierende Materialisierung: verlängert aktive „never"-Serien bis heute + 24 Monate, sobald der
// Horizont weiterrückt. Andere Endarten (count/until) sind bei Erstellung fertig materialisiert.
// Gibt die Anzahl neu angelegter Vorkommen zurück. now injizierbar (Tests).
function extendSeries(db, now = new Date()) {
  const today = berlinParts(now).date;
  const horizon = addMonthsISO(today, SERIES_HORIZON_MONTHS);
  let series;
  try { series = db.prepare("SELECT * FROM planning_series WHERE active = 1 AND end_type = 'never'").all(); } catch (_) { return 0; }
  let added = 0;
  const insEntry = db.prepare(`INSERT INTO planning_entries
    (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAssign = db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)');
  for (const s of series) {
    if (s.materialized_until && s.materialized_until >= horizon) continue; // schon weit genug voraus
    const rule = { freq: s.freq, anchor_date: s.anchor_date, interval_weeks: s.interval_weeks || 1, end_type: 'never' };
    const from = s.materialized_until ? addDaysISO(s.materialized_until, 1) : today;
    const occ = recur.computeOccurrences(rule, { horizon, from });
    let tpl; try { tpl = JSON.parse(s.template || '{}'); } catch (_) { tpl = {}; }
    const tplDays = (tpl.tplDays && tpl.tplDays.length) ? tpl.tplDays : [{ offset: 0, time_from: '07:00', time_to: '15:30', break_minutes: 0 }];
    const assigned = tpl.assigned_user_ids || [];
    const tx = db.transaction(() => {
      for (const occStart of occ) {
        const gid = crypto.randomUUID();
        for (const td of tplDays) {
          const r = insEntry.run(s.created_by, addDaysISO(occStart, td.offset), td.time_from, td.time_to, td.break_minutes || 0,
            tpl.address || '', tpl.client || '', tpl.project_id || null, tpl.project_text || '', tpl.description || '', gid, tpl.color || '#f59e0b', s.series_id, occStart);
          for (const uid of assigned) insAssign.run(r.lastInsertRowid, uid);
        }
        added++;
      }
      db.prepare('UPDATE planning_series SET materialized_until = ? WHERE series_id = ?').run(horizon, s.series_id);
    });
    tx();
  }
  return added;
}

let timer = null;
let lastExtendDate = null;
function start(getDb) {
  if (timer) return;
  const run = () => {
    try { tick(getDb()); } catch (e) { console.error('summary tick fehlgeschlagen:', e && e.message); }
    try { const d = berlinParts().date; if (d !== lastExtendDate) { lastExtendDate = d; extendSeries(getDb()); } } catch (e) { console.error('series extend fehlgeschlagen:', e && e.message); }
  };
  setTimeout(run, 15000);            // kurz nach Boot einmal
  timer = setInterval(run, 60 * 1000); // dann minütlich (Serien-Verlängerung nur 1×/Tag)
}

module.exports = { start, tick, extendSeries, firePlanningReminders, collectDueForUser, shiftWall, fmtWall, isDue, buildSummaryText, berlinParts, VALID_CATS, CAT_LABELS };
