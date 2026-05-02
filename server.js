require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { initDatabase, saveToFile } = require('./database/init');
const { JWT_SECRET } = require('./middleware/auth');
const { addClient, removeClient } = require('./sse');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Kein Cache für statische Dateien (Entwicklung)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API-Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/statistics', require('./routes/statistics'));
app.use('/api/planning', require('./routes/planning'));
app.use('/api/bulletin', require('./routes/bulletin'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/badges', require('./routes/badges'));

// SSE – Echtzeit-Updates für alle verbundenen Clients
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, JWT_SECRET); } catch (_) { return res.status(401).end(); }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  addClient(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); } }, 30000);
  req.on('close', () => { clearInterval(hb); removeClient(res); });
});

// SPA-Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fehlerbehandlung
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

// Server starten (async wegen sql.js)
function cleanupToolHistory() {
  try {
    const { getDb } = require('./database/init');
    const db = getDb();
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const cutoffStr = cutoff.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');
    const result = db.prepare('DELETE FROM tool_checkouts WHERE returned_at IS NOT NULL AND returned_at < ?').run(cutoffStr);
    if (result.changes > 0) console.log(`Werkzeug-Historie: ${result.changes} alte Einträge bereinigt.`);
  } catch (e) {}
}

async function start() {
  await initDatabase();
  cleanupToolHistory();
  setInterval(cleanupToolHistory, 24 * 60 * 60 * 1000); // täglich
  app.listen(PORT, () => {
    console.log(`Arbeitsdoku-Server läuft auf http://localhost:${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nServer wird beendet...');
  saveToFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveToFile();
  process.exit(0);
});

start().catch(err => {
  console.error('Fehler beim Starten:', err);
  process.exit(1);
});
