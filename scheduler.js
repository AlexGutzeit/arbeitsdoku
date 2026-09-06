// Geplante Zusammenfassungen (Digest-Push): prüft jede Minute, ob ein Plan fällig ist, baut aus den
// Badge-Zählern eine Nachricht und schickt sie per notifyUsers (Kategorie null → unabhängig von den
// Kategorie-Schaltern). isDue()/buildSummaryText()/berlinParts() sind reine Funktionen (testbar).
const crypto = require('crypto');
const { computeBadgeCounts } = require('./routes/badges');
const push = require('./push');
const recur = require('./planning-recurrence');
const { ausstellenVollziehen } = require('./ausstellen');
const { berlinJetzt, berlinWochentag } = require('./zeit');

// Standard-Tagesspanne aus den Firmen-Einstellungen (Arbeitsbeginn + Arbeitszeit + Pause).
// Gleiche Rueckfallwerte wie im Frontend und in routes/settings.js: 07:00 / 8 h / 30 min.
function standardTagVorgabe(db) {
  const lies = (k) => { try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value; } catch (_) { return undefined; } };
  const beginn = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(lies('work_start_default') || '')) ? lies('work_start_default') : '07:00';
  const std = Number(String(lies('work_hours_per_day') ?? '').replace(',', '.'));
  const pause = parseInt(lies('break_minutes_default'), 10);
  const stunden = (std > 0 && std <= 24) ? std : 8;
  const pauseMin = (Number.isFinite(pause) && pause >= 0 && pause <= 480) ? pause : 30;
  const [h, m2] = beginn.split(':').map(Number);
  const ende = h * 60 + m2 + Math.round(stunden * 60) + pauseMin;
  const g = ((ende % 1440) + 1440) % 1440;
  const bis = String(Math.floor(g / 60)).padStart(2, '0') + ':' + String(g % 60).padStart(2, '0');
  return { time_from: beginn, time_to: bis, break_minutes: pauseMin };
}

const addDaysISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonthsISO = (isoStr, n) => { const d = new Date(isoStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const SERIES_HORIZON_MONTHS = 24;

const VALID_CATS = ['orders', 'absences', 'bulletin', 'notes'];
const CAT_LABELS = { orders: 'Bestellungen', absences: 'Abwesenheiten', bulletin: 'Aushänge', notes: 'Notizen' };

// Berlin-Datum/Uhrzeit/Wochentag (1=Mo … 7=So) aus einem Date.
function berlinParts(now = new Date()) {
  const s = berlinJetzt(now).replace(' ', 'T');   // wie zuvor: 'YYYY-MM-DDTHH:MM:SS'
  return { date: s.slice(0, 10), hhmm: s.slice(11, 16), weekday: berlinWochentag(now) };
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

// Datum "YYYY-MM-DD" um Vorlauf (Tage/Wochen/Monate) zurückrechnen. Liefert wieder "YYYY-MM-DD".
function shiftDate(dateStr, num, unit) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (unit === 'day') d.setUTCDate(d.getUTCDate() - num);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() - num * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - num);
  return d.toISOString().slice(0, 10);
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
  // Pro-Vorkommen-Modell: jede Zeile adressiert genau EIN Vorkommen (group_id für Serie/Mehrtag,
  // entry_id für Einzeltag). Keine Serien-Expansion mehr.
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
      // Feuerzeitpunkt = (Termindatum − Vorlauf) am gewählten Uhrzeit-Feld. remind_time leer → Beginn-Uhrzeit.
      const apptDate = occ.startWall.slice(0, 10);
      const apptTime = occ.startWall.slice(11, 16);
      const fireDate = shiftDate(apptDate, r.lead_num, r.lead_unit);
      const fireWall = fireDate + ' ' + (r.remind_time || apptTime);
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
  // '/#/planning', NICHT '/planning': Die App ist eine Hash-Anwendung. Ohne die Raute liefert
  // der Server nur die Startseite aus, und die Erinnerung landete auf „Willkommen" statt beim
  // Termin (Alex, 27.08.2026). Alle anderen Meldungen machen es seit jeher richtig.
  return { title: '🔔 Erinnerung', body, url: '/#/planning' };
}
function markSent(db, reminderId, occKey) {
  db.prepare('INSERT OR IGNORE INTO planning_reminder_sent (reminder_id, occ_key) VALUES (?, ?)').run(reminderId, occKey);
}

// Einzelversand aller fälligen Planungs-Erinnerungen. now injizierbar.
async function firePlanningReminders(db, now = new Date()) {
  const nowParts = berlinParts(now);
  let userIds;
  try { userIds = db.prepare('SELECT DISTINCT user_id FROM planning_reminders').all().map(r => r.user_id); } catch (_) { return 0; }
  let sent = 0;
  for (const uid of userIds) {
    const due = collectDueForUser(db, uid, nowParts);
    for (const d of due) {
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
    // can_order MUSS mit: computeBadgeCounts entscheidet daran, ob Bestellungen mitzaehlen.
    // Ohne die Spalte stuende in der Zusammenfassung eines Rechteinhabers dauerhaft „0".
    const user = db.prepare('SELECT id, role, active, can_order FROM users WHERE id = ?').get(s.user_id);
    if (!user || user.active === 0) continue;
    const pref = db.prepare('SELECT summaries_paused FROM push_prefs WHERE user_id = ?').get(s.user_id);
    if (pref && pref.summaries_paused === 1) continue; // Global-Pause (Urlaub)
    const cats = String(s.cats || '').split(',').map(x => x.trim()).filter(c => VALID_CATS.includes(c));
    const body = buildSummaryText(cats, computeBadgeCounts(db, user));
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
    (created_by, date, time_from, time_to, break_minutes, address, client, project_id, project_text, description, group_id, color, series_id, occurrence_date, lineage_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAssign = db.prepare('INSERT INTO planning_assignments (planning_id, user_id) VALUES (?, ?)');
  // Erinnerungen, die „bis zum Ende" laufen (Zeile am bisher letzten Vorkommen), auf neue Vorkommen mitziehen.
  let insRem = null;
  try { insRem = db.prepare(`INSERT INTO planning_reminders (user_id, reminder_group, group_id, entry_id, series_id, occurrence_date, lead_num, lead_unit, remind_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`); } catch (_) {}
  for (const s of series) {
    if (s.materialized_until && s.materialized_until >= horizon) continue; // schon weit genug voraus
    const rule = { freq: s.freq, anchor_date: s.anchor_date, interval_weeks: s.interval_weeks || 1, end_type: 'never' };
    const from = s.materialized_until ? addDaysISO(s.materialized_until, 1) : today;
    const occ = recur.computeOccurrences(rule, { horizon, from });
    let tpl; try { tpl = JSON.parse(s.template || '{}'); } catch (_) { tpl = {}; }
    // Notnagel fuer alte Serien ohne gespeicherte Tagesstruktur: die Firmenvorgaben aus den
    // Einstellungen statt fest 07:00-15:30 (sonst haette eine Umstellung hier keine Wirkung).
    const tplDays = (tpl.tplDays && tpl.tplDays.length) ? tpl.tplDays : [{ offset: 0, ...standardTagVorgabe(db) }];
    const assigned = tpl.assigned_user_ids || [];
    const tx = db.transaction(() => {
      // Bisheriges letztes Vorkommen merken (für die Erinnerungs-Mitführung).
      let prevLast = null;
      try { prevLast = (db.prepare('SELECT MAX(occurrence_date) AS m FROM planning_entries WHERE series_id = ?').get(s.series_id) || {}).m || null; } catch (_) {}
      const newGroups = [];
      for (const occStart of occ) {
        const gid = crypto.randomUUID();
        newGroups.push({ occ: occStart, gid });
        for (const td of tplDays) {
          const r = insEntry.run(s.created_by, addDaysISO(occStart, td.offset), td.time_from, td.time_to, td.break_minutes || 0,
            tpl.address || '', tpl.client || '', tpl.project_id || null, tpl.project_text || '', tpl.description || '', gid, tpl.color || '#f59e0b', s.series_id, occStart, s.lineage_id || s.series_id);
          for (const uid of assigned) insAssign.run(r.lastInsertRowid, uid);
        }
        added++;
      }
      db.prepare('UPDATE planning_series SET materialized_until = ? WHERE series_id = ?').run(horizon, s.series_id);
      // Erinnerungen mitziehen: jede logische Erinnerung (reminder_group je Nutzer), die eine Zeile am
      // bisher letzten Vorkommen hat, gilt als „offen bis Ende" → auf die neuen Vorkommen kopieren
      // (Wert = der des letzten Vorkommens, deckt vorherige „ab hier"-Änderungen korrekt ab).
      if (insRem && prevLast && newGroups.length) {
        try {
          const endRems = db.prepare('SELECT * FROM planning_reminders WHERE series_id = ? AND occurrence_date = ?').all(s.series_id, prevLast);
          for (const rem of endRems) {
            for (const ng of newGroups) {
              insRem.run(rem.user_id, rem.reminder_group, ng.gid, null, s.series_id, ng.occ, rem.lead_num, rem.lead_unit, rem.remind_time);
            }
          }
        } catch (_) { /* planning_reminders evtl. nicht vorhanden (alte DB) → ignorieren */ }
      }
    });
    tx();
  }
  return added;
}

let timer = null;
let lastExtendDate = null;
let lastAustrittDate = null;
/**
 * Vorgemerkte Austritte vollziehen — einmal am Tag.
 *
 * Wer ein zukuenftiges Austrittsdatum bekommt, behaelt seinen Zugang bis zum letzten Arbeitstag
 * (routes/users.js). Hier wird das Konto danach wirklich geschlossen: dieselbe Aufraeumarbeit wie
 * beim sofortigen Ausstellen, aus derselben Funktion (ausstellen.js).
 *
 * `end_date < heute`, NICHT `end_date == gestern`: Lief der Server ueber den Stichtag nicht, holt
 * der naechste Start es nach. Ein Konto, das ueber seinen Austrittstag hinaus offen bleibt, waere
 * ein echtes Sicherheitsproblem — Versaeumtes muss aufholbar sein.
 *
 * `deactivated_by` wird der, der VORGEMERKT hat: Der Vollzug ist seine Entscheidung, nur
 * zeitversetzt. Steht im Protokoll niemand, faellt es auf den Vormerkenden aus dem Audit-Log
 * zurueck; findet sich auch der nicht, bleibt es leer statt falsch.
 */
function austritteVollziehen(db, heute) {
  const tag = heute || berlinParts().date;
  let faellig;
  try {
    faellig = db.prepare(
      `SELECT u.id, u.username, e.end_date
         FROM users u
         JOIN employment_periods e ON e.id = (
           SELECT id FROM employment_periods WHERE user_id = u.id ORDER BY start_date DESC LIMIT 1)
        WHERE COALESCE(u.active, 1) = 1 AND e.end_date IS NOT NULL AND e.end_date < ?`
    ).all(tag);
  } catch (_) { return []; }          // sehr alte Datenbank ohne employment_periods

  const vollzogen = [];
  for (const f of faellig) {
    // Wer hat vorgemerkt? Der letzte passende Protokolleintrag. Nur fuer `deactivated_by` und den
    // Protokolltext — ist er nicht auffindbar, wird trotzdem vollzogen.
    let wer = { id: null, username: 'Zeitplaner', ip: null };
    try {
      const eintrag = db.prepare(
        `SELECT user_id, username FROM audit_logs
          WHERE action = 'user_austritt_vorgemerkt' AND details LIKE ?
          ORDER BY id DESC LIMIT 1`
      ).get('%id=' + f.id + '%');
      if (eintrag) wer = { id: eintrag.user_id, username: eintrag.username, ip: null };
    } catch (_) { /* kein Protokoll -> Zeitplaner */ }

    ausstellenVollziehen(db, f.id, f.end_date, wer, ` (am ${f.end_date} vorgemerkt, heute vollzogen)`);
    vollzogen.push({ id: f.id, username: f.username, end_date: f.end_date });
  }
  if (vollzogen.length) {
    console.log('[austritt] vollzogen: ' + vollzogen.map(v => `${v.username} (bis ${v.end_date})`).join(', '));
  }
  return vollzogen;
}

function start(getDb) {
  if (timer) return;
  const run = () => {
    try { tick(getDb()); } catch (e) { console.error('summary tick fehlgeschlagen:', e && e.message); }
    try { const d = berlinParts().date; if (d !== lastExtendDate) { lastExtendDate = d; extendSeries(getDb()); } } catch (e) { console.error('series extend fehlgeschlagen:', e && e.message); }
    // Eigener Tagesmerker: Faellt die Serien-Verlaengerung mit einem Fehler aus, darf der Austritt
    // trotzdem vollzogen werden — ein offen bleibendes Konto ist das groessere Problem.
    try { const d = berlinParts().date; if (d !== lastAustrittDate) { lastAustrittDate = d; austritteVollziehen(getDb()); } } catch (e) { console.error('austritte vollziehen fehlgeschlagen:', e && e.message); }
  };
  setTimeout(run, 15000);            // kurz nach Boot einmal
  timer = setInterval(run, 60 * 1000); // dann minütlich (Serien-Verlängerung nur 1×/Tag)
}

module.exports = { start, tick, extendSeries, austritteVollziehen, firePlanningReminders, collectDueForUser, shiftDate, fmtWall, isDue, buildSummaryText, buildReminderPush, berlinParts, VALID_CATS, CAT_LABELS };
