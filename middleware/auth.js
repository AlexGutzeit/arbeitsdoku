const jwt = require('jsonwebtoken');
const { getDb } = require('../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'arbeitsdoku-geheim-aendern-in-produktion';

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden' });
    req.user = user;
    next();
  } catch (err) {
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
