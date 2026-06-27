const jwt = require('jsonwebtoken');
const { getDb } = require('../database/init');
const { logAudit } = require('../audit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET ist nicht gesetzt oder zu kurz (min. 32 Zeichen). Server-Start abgebrochen.');
  process.exit(1);
}

// Abgelaufenes Token (24h-Timeout) → automatischer Logout. Einmal pro Nutzer als 'session_expired'
// protokollieren, mit kurzer Sperre (5 Min), damit mehrere Folge-Requests/SSE-Reconnects mit
// demselben abgelaufenen Token das Audit-Log nicht zuspammen.
const _expiredLoggedAt = new Map();
function logSessionExpired(token, ip) {
  try {
    const decoded = jwt.decode(token);
    const userId = decoded && decoded.userId;
    if (!userId) return;
    const now = Date.now();
    if (now - (_expiredLoggedAt.get(userId) || 0) < 5 * 60 * 1000) return;
    _expiredLoggedAt.set(userId, now);
    const db = getDb();
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    logAudit(db, { userId, username: u ? u.username : '', action: 'session_expired', details: 'Token abgelaufen (24h-Timeout)', ip });
  } catch (_) { /* Audit darf den Request nie stoeren */ }
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, can_upload FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    req.user = user;
    next();
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') logSessionExpired(token, req.ip);
    return res.status(401).json({ error: 'Ungültiger Token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Nicht authentifiziert' });
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Keine Berechtigung' });
  };
}

module.exports = { authenticate, authorize, JWT_SECRET };
