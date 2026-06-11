// Revisionssicherheit (GoBD) + Audit-Log Helfer.
// recordEntryHistory: schreibt ein unveraenderliches Vorher-Abbild eines Zeiteintrags.
// logAudit: protokolliert sicherheits-/betriebsrelevante Ereignisse.

// Zeitstempel "YYYY-MM-DD HH:MM:SS" in Europe/Berlin (beruecksichtigt Sommer-/Winterzeit).
// SQLites strftime('now') liefert UTC — daher erzeugen wir die Zeit explizit in JS,
// konsistent mit dem Rest der App (z.B. cleanupToolHistory in server.js).
function berlinNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
}

// Felder, die im Snapshot eines Eintrags festgehalten werden (Vorher-Zustand).
const ENTRY_SNAPSHOT_FIELDS = [
  'id', 'user_id', 'date', 'time_from', 'time_to', 'break_minutes', 'net_hours',
  'address', 'client', 'project_id', 'project_text', 'description', 'personal_note',
  'has_regie', 'regie_user_id', 'created_at', 'updated_at',
];

// Schreibt ein Vorher-Abbild in entry_history (append-only).
// oldEntry: die komplette Eintragszeile VOR der Aenderung.
// action: 'update' | 'delete'
function recordEntryHistory(db, oldEntry, action, changedBy, reason) {
  if (!oldEntry) return;
  const snap = {};
  for (const f of ENTRY_SNAPSHOT_FIELDS) snap[f] = oldEntry[f];
  try {
    db.prepare(
      'INSERT INTO entry_history (entry_id, action, changed_by, changed_at, reason, snapshot) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(oldEntry.id, action, changedBy || null, berlinNow(), reason || '', JSON.stringify(snap));
  } catch (e) {
    // Audit darf den eigentlichen Vorgang nie blockieren — nur loggen.
    console.error('entry_history konnte nicht geschrieben werden:', e.message);
  }
}

// Protokolliert ein Ereignis in audit_logs.
// opts: { userId, username, action, details, ip }
function logAudit(db, opts) {
  const o = opts || {};
  let details = o.details;
  if (details !== null && details !== undefined && typeof details !== 'string') {
    try { details = JSON.stringify(details); } catch (_) { details = String(details); }
  }
  try {
    db.prepare(
      'INSERT INTO audit_logs (ts, user_id, username, action, details, ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(berlinNow(), o.userId || null, o.username || '', o.action, details || '', o.ip || '');
  } catch (e) {
    console.error('audit_logs konnte nicht geschrieben werden:', e.message);
  }
}

module.exports = { recordEntryHistory, logAudit, ENTRY_SNAPSHOT_FIELDS };
