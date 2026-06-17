const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database/init');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

// Fester Dummy-Hash (Cost 10, wie die echten Hashes), um die Antwortzeit bei unbekanntem
// Benutzer an den bcrypt-Vergleich anzugleichen → keine User-Enumeration über Timing.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Login
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    bcrypt.compareSync(password, DUMMY_HASH); // Timing angleichen (Antwortzeit wie bei echtem User)
    logAudit(db, { username, action: 'login_failed', details: 'Benutzer unbekannt', ip: req.ip });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
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
      can_bulletin: !!user.can_bulletin,
      can_upload: !!user.can_upload
    }
  });
});

// Aktueller Benutzer
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
