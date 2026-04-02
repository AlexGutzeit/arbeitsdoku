const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Einfache Benutzerliste (id + name) für alle authentifizierten User (z.B. Regie-Dropdown)
router.get('/list', authenticate, (req, res) => {
  const db = getDb();
  const users = db.prepare("SELECT id, name, role FROM users WHERE role != 'admin' ORDER BY name").all();
  res.json({ users });
});

// Alle Benutzer abrufen
router.get('/', authenticate, authorize('chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  let users;

  if (req.user.role === 'admin') {
    // Admin sieht alle Benutzer inkl. Passwörter
    users = db.prepare('SELECT id, username, password_plain, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users ORDER BY name').all();
  } else if (req.user.role === 'chef') {
    // Chef sieht alle außer Admins, mit Passwörtern
    users = db.prepare("SELECT id, username, password_plain, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE role != 'admin' ORDER BY name").all();
  } else {
    // Buchhalter sieht alle außer Admins, ohne Passwörter
    users = db.prepare("SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE role != 'admin' ORDER BY name").all();
  }

  res.json({ users });
});

// Einzelnen Benutzer abrufen
router.get('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  let user;

  if (req.user.role === 'admin' || req.user.role === 'chef') {
    user = db.prepare('SELECT id, username, password_plain, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE id = ?').get(req.params.id);
  } else {
    user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE id = ?').get(req.params.id);
  }

  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  res.json({ user });
});

// Benutzer erstellen
router.post('/', authenticate, authorize('chef'), (req, res) => {
  const { username, password, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri } = req.body;

  if (!username || !password || !name || !role) {
    return res.status(400).json({ error: 'Benutzername, Passwort, Name und Rolle sind Pflichtfelder' });
  }

  const validRoles = ['mitarbeiter', 'buchhalter', 'chef'];
  if (req.user.role !== 'admin') {
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Ungültige Rolle' });
    }
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  const hMon = hours_mon || 8, hTue = hours_tue || 8, hWed = hours_wed || 8, hThu = hours_thu || 8, hFri = hours_fri || 6;
  const hpw = target_hours_per_week || (hMon + hTue + hWed + hThu + hFri);

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, password_plain, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(username, hash, password, name, role, hpw, start_overtime || 0, can_plan ? 1 : 0, can_bulletin ? 1 : 0);

  const userId = result.lastInsertRowid;
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO user_target_hours (user_id, hours_per_week, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, hpw, hMon, hTue, hWed, hThu, hFri, today);

  const user = db.prepare('SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE id = ?').get(userId);
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

  const { username, password, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin } = req.body;

  // Passwort ändern
  let hash = user.password_hash;
  let plain = user.password_plain;
  if (password) {
    hash = bcrypt.hashSync(password, 10);
    plain = password;
  }

  db.prepare(
    'UPDATE users SET username=?, password_hash=?, password_plain=?, name=?, role=?, target_hours_per_week=?, start_overtime=?, can_plan=?, can_bulletin=? WHERE id=?'
  ).run(
    username || user.username,
    hash,
    plain,
    name || user.name,
    role || user.role,
    target_hours_per_week !== undefined ? target_hours_per_week : user.target_hours_per_week,
    start_overtime !== undefined ? start_overtime : (user.start_overtime || 0),
    can_plan !== undefined ? (can_plan ? 1 : 0) : (user.can_plan || 0),
    can_bulletin !== undefined ? (can_bulletin ? 1 : 0) : (user.can_bulletin || 0),
    req.params.id
  );

  const updated = db.prepare('SELECT id, username, password_plain, name, role, target_hours_per_week, start_overtime, can_plan, can_bulletin, created_at FROM users WHERE id = ?').get(req.params.id);
  res.json({ user: updated });
});

// Benutzer löschen
router.delete('/:id', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

  if (user.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Accounts können nur von Admins gelöscht werden' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
