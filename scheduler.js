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

module.exports = { start, tick, extendSeries, isDue, buildSummaryText, berlinParts, VALID_CATS, CAT_LABELS };
