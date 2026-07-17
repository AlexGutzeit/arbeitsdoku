const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

// Gültige Rollen. 'admin' darf ausschließlich durch Admins vergeben werden (siehe POST/PUT).
const ROLES = ['mitarbeiter', 'buchhalter', 'chef', 'admin'];

// Anzahl AKTIVER Admins außer einem bestimmten Nutzer — für den „letzter Admin"-Schutz (S3):
// der letzte verbleibende Admin darf nicht herabgestuft/ausgestellt werden (sonst 0 Admins → Aussperrung).
function otherActiveAdmins(db, exceptId) {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND COALESCE(active,1) = 1 AND id != ?").get(exceptId).c;
}

// Passwort-Policy (serverseitig erzwungen — Quelle der Wahrheit; das Frontend spiegelt sie nur).
// Gilt beim Anlegen UND Zurücksetzen. Der Login prüft NICHTS davon → Altpasswörter bleiben nutzbar.
function passwordPolicyError(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwort: mindestens 8 Zeichen';
  if (pw.length > 72) return 'Passwort: höchstens 72 Zeichen';        // bcrypt nutzt nur die ersten 72 Bytes
  if (!/[a-z]/.test(pw)) return 'Passwort: mindestens ein Kleinbuchstabe';
  if (!/[A-Z]/.test(pw)) return 'Passwort: mindestens ein Großbuchstabe';
  if (!/[0-9]/.test(pw)) return 'Passwort: mindestens eine Ziffer';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Passwort: mindestens ein Sonderzeichen';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'Passwort darf nicht dem Benutzernamen entsprechen';
  return null;
}

// Felder, die im Audit-Log nachvollziehbar protokolliert werden (Label + Formatter).
// Das Passwort wird BEWUSST nie geloggt.
const USER_AUDIT_FIELDS = [
  ['username', 'Benutzername', v => String(v ?? '')],
  ['name', 'Name', v => String(v ?? '')],
  ['role', 'Rolle', v => String(v ?? '')],
  ['target_hours_per_week', 'Soll-Stunden/Woche', v => String(v ?? '')],
  ['start_overtime', 'Start-Überstunden', v => String(v ?? 0)],
  ['can_bulletin', 'Recht Schwarzes Brett', v => (v ? 'Ja' : 'Nein')],
  ['can_upload', 'Recht Dokumente-Upload', v => (v ? 'Ja' : 'Nein')],
];
// Planungsrecht semantisch als EINE Stufe (statt zwei Boolescher Felder), damit im Audit auf einen Blick
// erkennbar ist, WELCHER Stand gilt — insbesondere „alle → nur sich" (nur die alle-Stufe entzogen).
function planLevel(u) {
  if (u.can_plan_all) return 'alle';
  if (u.can_plan) return 'nur sich';
  return 'keins';
}
// Alle relevanten Felder eines neuen Benutzers als Klartext.
function userAuditCreate(u) {
  const parts = USER_AUDIT_FIELDS.map(([k, label, fmt]) => `${label}: ${fmt(u[k])}`);
  parts.push(`Planungsrecht: ${planLevel(u)}`);
  return parts.join(', ');
}
// Nur die geaenderten Felder als "Feld: alt → neu".
function userAuditDiff(before, after) {
  const changes = [];
  for (const [k, label, fmt] of USER_AUDIT_FIELDS) {
    if (fmt(before[k]) !== fmt(after[k])) changes.push(`${label}: ${fmt(before[k])} → ${fmt(after[k])}`);
  }
  if (planLevel(before) !== planLevel(after)) {
    changes.push(`Planungsrecht: ${planLevel(before)} → ${planLevel(after)}`);
  }
  return changes;
}

// Haengt jedem User seine Anstellungszeitraeume an (kompakt: [{s,e}], e=null = aktuell angestellt).
// Damit kann das Frontend MA aus Perioden-Ansichten ausblenden, in denen sie (noch) nicht angestellt sind.
function attachEmployment(db, users) {
  if (!users.length) return users;
  const ids = users.map(u => u.id);
  const rows = db.prepare(
    `SELECT user_id, start_date, end_date FROM employment_periods WHERE user_id IN (${ids.map(() => '?').join(',')}) ORDER BY start_date ASC`
  ).all(...ids);
  const byUser = {};
  for (const r of rows) (byUser[r.user_id] || (byUser[r.user_id] = [])).push({ s: r.start_date, e: r.end_date });
  for (const u of users) u.employment = byUser[u.id] || [];
  return users;
}

// Einfache Benutzerliste (id + name) für alle authentifizierten User (z.B. Regie-Dropdown).
// Default nur AKTIVE (fuer Zuweisungs-Picker neuer Arbeit); ?all=1 schliesst Ausgestellte ein
// (z.B. fuer Historien-Filter), inkl. active-Flag zum Kennzeichnen.
router.get('/list', authenticate, (req, res) => {
  const db = getDb();
  const all = req.query.all === '1' || req.query.all === 'true';
  const users = all
    ? db.prepare("SELECT id, name, role, active FROM users WHERE role != 'admin' ORDER BY name").all()
    : db.prepare("SELECT id, name, role, active FROM users WHERE role != 'admin' AND active = 1 ORDER BY name").all();
  res.json({ users: attachEmployment(db, users) });
});

// Ausgestellte Mitarbeiter (Papierkorb-Reiter "Mitarbeiter"). Chef+Admin (MA haben keinen Zugriff).
// MUSS vor "/:id" stehen.
router.get('/inactive', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.target_hours_per_week, u.deactivated_at, u.deactivated_by,
           du.name AS deactivated_by_name,
           (SELECT MAX(ep.end_date) FROM employment_periods ep WHERE ep.user_id = u.id) AS employed_until
    FROM users u
    LEFT JOIN users du ON u.deactivated_by = du.id
    WHERE u.active = 0
    ORDER BY u.deactivated_at DESC, u.name
  `).all();
  res.json({ users: rows });
});

// Alle Benutzer abrufen
router.get('/', authenticate, authorize('chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  let users;

  if (req.user.role === 'admin') {
    users = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, active, created_at FROM users ORDER BY name').all();
  } else {
    users = db.prepare("SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, active, created_at FROM users WHERE role != 'admin' ORDER BY name").all();
  }

  res.json({ users: attachEmployment(db, users) });
});

// Einzelnen Benutzer abrufen
router.get('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  let user;

  user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, created_at FROM users WHERE id = ?').get(req.params.id);

  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  res.json({ user });
});

// Benutzer erstellen
router.post('/', authenticate, authorize('chef'), async (req, res) => {
  const { username, password, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri } = req.body;
  // „alle" impliziert immer „sich" (can_plan_all=1 ⇒ can_plan=1).
  let planAll = can_plan_all ? 1 : 0;
  let planSelf = (can_plan || can_plan_all) ? 1 : 0;
  let bulletin = can_bulletin ? 1 : 0;
  let upload = can_upload ? 1 : 0;

  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: 'Benutzername, Passwort, Name und Rolle sind Pflichtfelder' });
  }

  // Nur bekannte Rollen; die Admin-Rolle ausschließlich durch Admins (Nicht-Admins: reduzierte Menge).
  const allowedRoles = req.user.role === 'admin' ? ROLES : ['mitarbeiter', 'buchhalter', 'chef'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }
  // #9: Chef/Admin haben Planung/Schwarzes Brett/Upload per Rolle — Einzelrecht-Flags redundant → 0.
  if (role === 'chef' || role === 'admin') { planAll = 0; planSelf = 0; bulletin = 0; upload = 0; }

  // B5: start_overtime muss eine Zahl sein (negativ erlaubt = Start mit Überstunden-Schuld).
  if (start_overtime !== undefined && start_overtime !== null && !Number.isFinite(Number(start_overtime))) {
    return res.status(400).json({ error: 'Start-Überstunden müssen eine Zahl sein' });
  }

  const pwErr = passwordPolicyError(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  const hMon = hours_mon || 8, hTue = hours_tue || 8, hWed = hours_wed || 8, hThu = hours_thu || 8, hFri = hours_fri || 6;
  const hpw = target_hours_per_week || (hMon + hTue + hWed + hThu + hFri);

  let hash;
  try { hash = await bcrypt.hash(password, 10); } // kooperativ (blockiert den Event-Loop nicht)
  catch (e) { console.error('Hash-Fehler:', e.message); return res.status(500).json({ error: 'Interner Serverfehler' }); }
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(username, hash, name, role, hpw, Number(start_overtime) || 0, planSelf, planAll, bulletin, upload);

  const userId = result.lastInsertRowid;
  // B6: „heute" in Europe/Berlin (wie im Rest der App) statt UTC — sonst nahe Mitternacht 1 Tag daneben.
  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  db.prepare(
    'INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, hpw, hMon, hTue, hWed, hThu, hFri, today);
  // Offener Anstellungszeitraum ab heute (Basis fuer die Soll-Stunden-Anrechnung)
  db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(userId, today);

  const user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, created_at FROM users WHERE id = ?').get(userId);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_create',
    details: `id=${userId} · ${userAuditCreate(user)}`, ip: req.ip });
  res.status(201).json({ user });
});

// Benutzer bearbeiten
router.put('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  // Chef darf Admin-Accounts nicht bearbeiten
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins bearbeitet werden' });
  }

  const { username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload } = req.body;

  // Rollen-Absicherung (serverseitig, nicht nur im Frontend): nur bekannte Rollen zulassen und die
  // Admin-Rolle ausschließlich durch Admins vergeben — sonst könnte ein Chef per direktem API-Call einen
  // Nutzer (oder sich selbst) zu Admin hochstufen. Greift nur bei tatsächlicher Rollen-Änderung.
  if (role !== undefined && role !== user.role) {
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Ungültige Rolle' });
    }
    if (role === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nur Admins dürfen die Admin-Rolle vergeben' });
    }
    // S3: den LETZTEN aktiven Admin nicht herabstufen — sonst gäbe es 0 Admins und niemand käme mehr an die
    // Admin-Funktionen. Bei mehreren Admins ist das Herabstufen erlaubt.
    if (user.role === 'admin' && role !== 'admin' && user.active !== 0 && otherActiveAdmins(db, user.id) === 0) {
      return res.status(400).json({ error: 'Der letzte Admin kann nicht herabgestuft werden — lege zuerst einen weiteren Admin an.' });
    }
  }

  // B5: start_overtime muss eine Zahl sein (negativ erlaubt = Start mit Überstunden-Schuld).
  if (start_overtime !== undefined && start_overtime !== null && !Number.isFinite(Number(start_overtime))) {
    return res.status(400).json({ error: 'Start-Überstunden müssen eine Zahl sein' });
  }

  // Benutzernamen-Eindeutigkeit (wie beim Anlegen): ein umbenannter Nutzer darf keinen bereits vergebenen
  // Namen bekommen — sonst gäbe es zwei Zeilen mit gleichem username und die Anmeldung wäre mehrdeutig.
  if (username && username !== user.username) {
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
    if (clash) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  // Rechte-Stufen normalisieren: jeweils mitgeschicktes Feld übernehmen, sonst Bestand behalten;
  // „alle" impliziert immer „sich".
  let newPlanAll = can_plan_all !== undefined ? (can_plan_all ? 1 : 0) : (user.can_plan_all || 0);
  let newPlanSelf = can_plan !== undefined ? (can_plan ? 1 : 0) : (user.can_plan || 0);
  if (newPlanAll) newPlanSelf = 1;
  let newBulletin = can_bulletin !== undefined ? (can_bulletin ? 1 : 0) : (user.can_bulletin || 0);
  let newUpload = can_upload !== undefined ? (can_upload ? 1 : 0) : (user.can_upload || 0);
  // #9: Chef/Admin haben Planung/Schwarzes Brett/Upload ohnehin per Rolle — die Einzelrecht-Flags sind
  // redundant und werden für sie immer auf 0 gehalten (auch gegen direkte API-Aufrufe).
  const effRole = role || user.role;
  if (effRole === 'chef' || effRole === 'admin') { newPlanAll = 0; newPlanSelf = 0; newBulletin = 0; newUpload = 0; }

  db.prepare(
    'UPDATE users SET username=?, name=?, role=?, target_hours_per_week=?, start_overtime=?, can_plan=?, can_plan_all=?, can_bulletin=?, can_upload=? WHERE id=?'
  ).run(
    username || user.username,
    name || user.name,
    role || user.role,
    target_hours_per_week !== undefined ? target_hours_per_week : user.target_hours_per_week,
    start_overtime !== undefined ? Number(start_overtime) : (user.start_overtime || 0),
    newPlanSelf,
    newPlanAll,
    newBulletin,
    newUpload,
    req.params.id
  );

  const updated = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, created_at FROM users WHERE id = ?').get(req.params.id);
  const _changes = userAuditDiff(user, updated);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_update',
    details: `${updated.username} (id=${req.params.id}): ` + (_changes.length ? _changes.join('; ') : 'keine Änderung'),
    ip: req.ip });
  res.json({ user: updated });
});

// Passwort zurücksetzen
router.post('/:id/reset-password', authenticate, authorize('chef'), async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Passwort kann nur von Admins geändert werden' });
  }
  const { password } = req.body;
  const pwErr = passwordPolicyError(password, user.username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  let hash;
  try { hash = await bcrypt.hash(password, 10); } // kooperativ (blockiert den Event-Loop nicht)
  catch (e) { console.error('Hash-Fehler:', e.message); return res.status(500).json({ error: 'Interner Serverfehler' }); }
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, req.params.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_password_reset',
    details: `Passwort zurueckgesetzt fuer: ${user.username} (id=${req.params.id})`, ip: req.ip });
  res.json({ success: true });
});

// Mitarbeiter AUSSTELLEN (Soft-Delete): kein Login mehr, aber alle Daten bleiben erhalten und
// werden fuer den Anstellungszeitraum weiter angezeigt/berechnet. Schliesst den offenen
// Anstellungszeitraum mit dem Austrittsdatum (Default heute).
router.post('/:id/deactivate', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins ausgestellt werden' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Sich selbst kann man nicht ausstellen' });
  }
  // S3: auch beim Ausstellen den letzten aktiven Admin schützen (falls je jemand einen Admin über den API-Weg
  // ausstellen wollte, der der einzige verbliebene ist).
  if (user.role === 'admin' && otherActiveAdmins(db, user.id) === 0) {
    return res.status(400).json({ error: 'Der letzte Admin kann nicht ausgestellt werden — lege zuerst einen weiteren Admin an.' });
  }
  if (user.active === 0) return res.status(409).json({ error: 'Mitarbeiter ist bereits ausgestellt' });

  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const employedUntil = req.body && req.body.employed_until ? String(req.body.employed_until) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(employedUntil)) {
    return res.status(400).json({ error: 'Ungültiges Austrittsdatum (Format JJJJ-MM-TT)' });
  }
  // Austrittsdatum darf nicht vor dem aktuellen Eintritt liegen
  const open = db.prepare('SELECT id, start_date FROM employment_periods WHERE user_id = ? AND end_date IS NULL ORDER BY start_date DESC LIMIT 1').get(req.params.id);
  if (open && employedUntil < open.start_date) {
    return res.status(400).json({ error: `Austrittsdatum liegt vor dem Eintrittsdatum (${open.start_date})` });
  }

  const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
  db.prepare('UPDATE users SET active = 0, deactivated_at = ?, deactivated_by = ? WHERE id = ?').run(ts, req.user.id, req.params.id);
  if (open) {
    db.prepare('UPDATE employment_periods SET end_date = ? WHERE id = ?').run(employedUntil, open.id);
  } else {
    // Kein offener Zeitraum (Daten-Altlast) -> einen abgeschlossenen Tageszeitraum anlegen
    db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, ?)').run(req.params.id, employedUntil, employedUntil);
  }
  // Push-Abos des ausgestellten Nutzers entfernen (er soll keine Benachrichtigungen mehr bekommen;
  // notifyUsers sperrt zusaetzlich serverseitig). Bei Wiedereinstellung re-abonniert das Geraet beim Login.
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.params.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_deactivate',
    details: `Ausgestellt: ${user.username} (${user.role}, id=${req.params.id}), letzter Arbeitstag ${employedUntil}`, ip: req.ip });
  res.json({ success: true });
});

// Mitarbeiter WIEDEREINSTELLEN: neuer offener Anstellungszeitraum ab Wiedereintrittsdatum
// (Default heute). Die Lueckenzeit dazwischen bleibt mit Soll = 0 bestehen.
router.post('/:id/reactivate', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins wiedereingestellt werden' });
  }
  if (user.active === 1) return res.status(409).json({ error: 'Mitarbeiter ist bereits aktiv' });

  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
  const startDate = req.body && req.body.start_date ? String(req.body.start_date) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'Ungültiges Wiedereintrittsdatum (Format JJJJ-MM-TT)' });
  }
  // Wiedereintritt muss nach dem letzten Austritt liegen (keine ueberlappenden Zeitraeume)
  const lastEnd = db.prepare('SELECT MAX(end_date) AS d FROM employment_periods WHERE user_id = ?').get(req.params.id);
  if (lastEnd && lastEnd.d && startDate <= lastEnd.d) {
    return res.status(400).json({ error: `Wiedereintritt muss nach dem letzten Austritt (${lastEnd.d}) liegen` });
  }

  db.prepare('UPDATE users SET active = 1, deactivated_at = NULL, deactivated_by = NULL WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, NULL)').run(req.params.id, startDate);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_reactivate',
    details: `Wiedereingestellt: ${user.username} (${user.role}, id=${req.params.id}), Eintritt ${startDate}`, ip: req.ip });
  res.json({ success: true });
});

// Benutzer ENDGUELTIG löschen (Hard-Delete inkl. aller Daten per Cascade). Nur Admin und nur,
// wenn der Mitarbeiter zuvor ausgestellt wurde — schuetzt vor versehentlichem Datenverlust.
router.delete('/:id', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Sich selbst kann man nicht löschen' });
  }
  if (user.active !== 0) {
    return res.status(400).json({ error: 'Mitarbeiter muss zuerst ausgestellt werden, bevor er endgültig gelöscht werden kann' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'user_delete',
    details: `Endgueltig geloescht: ${user.username} (${user.role}, id=${req.params.id})`, ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
