require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { initDatabase, saveToFile } = require('./database/init');
const { JWT_SECRET } = require('./middleware/auth');
const { addClient, removeClient, getClientCount } = require('./sse');
const { authenticate, authorize } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Vertraue dem ersten Proxy in der Kette (Caddy) — req.ip kommt dann aus X-Forwarded-For
app.set('trust proxy', 1);

// --- Sicherheits-Header (eng auf diese App zugeschnitten) ---
// CSP (Content-Security-Policy): sagt dem Browser, woher Inhalte kommen duerfen.
//  - script-src 'self'  : nur App-eigene Skript-Dateien, KEINE eingebetteten <script> (die
//    Service-Worker-Registrierung liegt ausgelagert in /js/sw-register.js) → eingeschleuste
//    Fremd-Skripte werden vom Browser nicht ausgefuehrt (zweite Mauer gegen XSS).
//  - style-src 'self' 'unsafe-inline' : die App nutzt viele inline style="..."-Attribute und den
//    Branding-<style>-Block; inline Styles sind risikoarm und bleiben erlaubt.
//  - img/font/connect/manifest/worker-src 'self' : alles nur von der eigenen Herkunft, inkl.
//    fetch + SSE (Echtzeit). Externe Wetter-APIs ruft der Server, nicht der Browser → 'self' genuegt.
//  - frame-ancestors 'none' (+ X-Frame-Options DENY) : die App darf nicht in eine fremde Seite
//    eingebettet werden (Schutz gegen „Clickjacking").
//  - object-src 'none', base-uri/form-action 'self' : weitere Haertung.
// HSTS (HTTPS-Erzwingung) uebernimmt bewusst der vorgeschaltete Caddy-Proxy.
const CSP_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Dynamische Branding-Routes (manifest.json + index.html mit Settings-Tokens)
// MUSS vor express.static stehen, sonst gewinnt die statische Datei
const brandingRouter = require('./routes/branding');
app.use('/', brandingRouter);

// Kein Cache für statische Dateien (Entwicklung)
// index: false verhindert, dass express.static automatisch index.html ausliefert
// (die branding-Route uebernimmt das mit Token-Replacements)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  index: false,
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
app.use('/api/absences', require('./routes/absences'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/push', require('./routes/push'));

// Kurzlebiges SSE-Ticket: normaler (authentifizierter) Aufruf per Authorization-Header liefert ein
// nur 60 Sekunden gueltiges Token. Der Client haengt DIESES an die SSE-URL — nicht mehr den langen
// Login-Token. Selbst falls die URL in einem Proxy-Log landet, ist das Ticket Sekunden spaeter wertlos.
app.get('/api/events/ticket', authenticate, (req, res) => {
  const ticket = jwt.sign({ userId: req.user.id, sse: true }, JWT_SECRET, { expiresIn: '60s' });
  res.json({ ticket });
});

// SSE – Echtzeit-Updates für alle verbundenen Clients
app.get('/api/events', (req, res) => {
  // Bevorzugt das kurzlebige Ticket; der lange Login-Token bleibt als Fallback gueltig (z.B. fuer
  // einen alten, noch offenen Tab vor dem Reload) — die Verifikation ist fuer beide identisch.
  const token = req.query.ticket || req.query.token;
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
  // Force-Reconnect nach 1h verhindert lange-laufende Phantom-Verbindungen
  const maxLife = setTimeout(() => { try { res.end(); } catch (_) {} }, 60 * 60 * 1000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(hb);
    clearTimeout(maxLife);
    removeClient(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

// Debug-Endpoint: Anzahl offener SSE-Connections (nur Admin)
app.get('/api/debug/sse', authenticate, authorize('admin'), (req, res) => {
  res.json({ clients: getClientCount() });
});

// Healthcheck (ohne Auth) — fuer Monitoring/Uptime-Checks. 200 wenn DB erreichbar, sonst 503.
app.get('/health', (req, res) => {
  try {
    const { getDb } = require('./database/init');
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db: true });
  } catch (e) {
    res.status(503).json({ status: 'error', db: false });
  }
});

// SPA-Fallback (gerenderte index.html mit Branding-Tokens)
app.get('*', (req, res) => brandingRouter.renderIndex(req, res));

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
