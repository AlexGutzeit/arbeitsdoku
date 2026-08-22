const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database/init');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { passwordPolicyError } = require('./users');

const router = express.Router();

// Fester Dummy-Hash (Cost 10, wie die echten Hashes), um die Antwortzeit bei unbekanntem
// Benutzer an den bcrypt-Vergleich anzugleichen → keine User-Enumeration über Timing.
// hashSync hier bewusst: laeuft EINMAL beim Serverstart (nicht pro Anfrage), blockiert also nichts.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Login. async + bcrypt.compare (kooperativ): die rechenintensive Passwortpruefung blockiert den
// Event-Loop nicht mehr — der Server bleibt unter vielen gleichzeitigen Logins ansprechbar.
router.post('/login', loginLimiter, async (req, res) => {
 try {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH); // Timing angleichen (Antwortzeit wie bei echtem User)
    logAudit(db, { username, action: 'login_failed', details: 'Benutzer unbekannt', ip: req.ip });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  if (!(await bcrypt.compare(password, user.password_hash))) {
    logAudit(db, { userId: user.id, username, action: 'login_failed', details: 'Falsches Passwort', ip: req.ip });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  // Ausgestellte Mitarbeiter koennen sich nicht mehr anmelden (Daten bleiben erhalten).
  if (user.active === 0) {
    logAudit(db, { userId: user.id, username, action: 'login_failed', details: 'Account ausgestellt', ip: req.ip });
    return res.status(403).json({ error: 'Dieser Account ist ausgestellt. Bitte wende dich an die Verwaltung.' });
  }

  logAudit(db, { userId: user.id, username: user.username, action: 'login_success', ip: req.ip });
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      target_hours_per_week: user.target_hours_per_week,
      start_overtime: user.start_overtime || 0,
      can_plan: !!user.can_plan,
      can_plan_all: !!user.can_plan_all,
      can_bulletin: !!user.can_bulletin,
      can_upload: !!user.can_upload,
      work_start: user.work_start || null,  // leer = Firmenwert aus den Einstellungen
      birth_date: user.birth_date || null   // leer = Alter unbekannt -> strengerer Jugendschutz
    }
  });
 } catch (e) {
  console.error('Login-Fehler:', e.message);
  return res.status(500).json({ error: 'Interner Serverfehler' });
 }
});

// Aktueller Benutzer
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// Eigenes Passwort aendern. Bis hierher konnte das NIEMAND selbst — nur Chef/Admin konnten es
// fuer andere zuruecksetzen (routes/users.js). Ein Mitarbeiter, dessen Passwort jemand mitgelesen
// hat, war darauf angewiesen, dass ein Vorgesetzter Zeit hat.
//
// Das aktuelle Passwort ist Pflicht: Sonst koennte jemand an einem unbeaufsichtigten, noch
// angemeldeten Geraet das Passwort aendern und sich den Zugang dauerhaft sichern.
router.put('/password', authenticate, async (req, res) => {
  try {
    const { aktuell, neu } = req.body || {};
    if (!aktuell || !neu) return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });

    const db = getDb();
    const reihe = db.prepare('SELECT password_hash, username FROM users WHERE id = ?').get(req.user.id);
    if (!reihe) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    if (!(await bcrypt.compare(aktuell, reihe.password_hash))) {
      logAudit(db, { userId: req.user.id, username: reihe.username, action: 'password_self_change_failed',
        details: 'Aktuelles Passwort falsch', ip: req.ip });
      return res.status(401).json({ error: 'Das aktuelle Passwort stimmt nicht' });
    }

    // Dieselbe Regel wie beim Anlegen und beim Zuruecksetzen — eine Quelle der Wahrheit.
    const verstoss = passwordPolicyError(neu, reihe.username);
    if (verstoss) return res.status(400).json({ error: verstoss });
    if (neu === aktuell) return res.status(400).json({ error: 'Das neue Passwort muss sich vom bisherigen unterscheiden' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(neu, 10), req.user.id);
    logAudit(db, { userId: req.user.id, username: reihe.username, action: 'password_self_change', ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    console.error('Passwort aendern fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Abmelden. Bei stateless JWT gibt es serverseitig nichts „abzumelden" — dieser Endpunkt dient
// nur dem Audit-Log. Best effort: der „Abmelden"-Button ruft ihn auf; ein blosses Schliessen des
// Tabs erreicht den Server nicht (der automatische Logout bei abgelaufenem Token wird separat als
// 'session_expired' protokolliert).
router.post('/logout', authenticate, (req, res) => {
  logAudit(getDb(), { userId: req.user.id, username: req.user.username, action: 'logout', details: 'manuell', ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
