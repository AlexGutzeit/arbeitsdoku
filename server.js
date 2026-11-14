// ZEITZONE — muss VOR allem anderen stehen, sonst haben bereits geladene Module eine andere.
//
// Die App rechnet an vielen Stellen in Ortszeit (Arbeitstage, Monatsgrenzen, „heute"), teils
// ausdruecklich mit `timeZone: 'Europe/Berlin'`, teils ueber die Zeitzone des Prozesses. Solange
// der Server auf Europe/Berlin steht, ist beides gleich — genau das ist aber eine unausgesprochene
// Abhaengigkeit von der Serverkonfiguration. Auf einem Server, der wie ueblich auf UTC steht,
// verschoeben sich Datumsangaben lautlos um zwei Stunden.
//
// Deshalb hier festgelegt, aber NUR wenn nichts vorgegeben ist: Wer `TZ` bewusst setzt, behaelt
// die Kontrolle. Auf dem heutigen Produktivserver aendert das nichts (er steht bereits so).
if (!process.env.TZ) process.env.TZ = 'Europe/Berlin';

require('dotenv').config({ quiet: true });
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { initDatabase, saveToFile, getDb } = require('./database/init');
const { JWT_SECRET } = require('./middleware/auth');
const { addClient, removeClient, getClientCount } = require('./sse');
const { authenticate, authorize, sitzungPruefen, einrichtungFehlt } = require('./middleware/auth');
const { berlinJetzt } = require('./zeit');

const app = express();
const PORT = process.env.PORT || 3000;

// Auf welcher Adresse der Server lauscht (P4, 11.11.2026). Vorgabe: nur dieser Rechner.
//
// Vorher stand hier nichts, und Node lauschte damit auf ALLEN Schnittstellen. Hinter einem Proxy
// (der empfohlene Aufbau) war der Port dann zusaetzlich direkt erreichbar, sobald keine Firewall
// davorstand — und wer direkt kommt, darf sich seine Adresse selbst aussuchen: Wegen
// `trust proxy` glaubt die App der Kopfzeile X-Forwarded-For, die sonst nur der Proxy setzt.
// Damit liess sich die Anmeldebremse je Adresse umgehen und das Protokoll mit erfundenen
// Adressen fuellen. Der Schutz hing allein an der Firewall.
//
// Wer die App OHNE Proxy betreibt und aus dem Netz erreichen will, setzt LISTEN_HOST=0.0.0.0
// (nur IPv4) oder LISTEN_HOST=:: (IPv4 und IPv6, das Verhalten von frueher).
//
// Bewusst nicht „HOST": Diesen Namen belegen manche Umgebungen von sich aus (tcsh, conda), und
// weil die .env eine bereits gesetzte Variable nicht ueberschreibt, lauschte der Server dann
// stillschweigend auf einer fremden Adresse.
const LISTEN_HOST = (process.env.LISTEN_HOST || '').trim() || '127.0.0.1';
const NUR_DIESER_RECHNER = /^(127\.|::1$|localhost$)/i.test(LISTEN_HOST);

// Express nennt sich sonst in jeder Antwort selbst („X-Powered-By: Express") — eine Auskunft, die
// nur dem nuetzt, der nach passenden Luecken sucht.
app.disable('x-powered-by');

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
// HSTS (Strict-Transport-Security): „diese Adresse kuenftig nur noch ueber https" — der Browser
// merkt sich das ein Jahr und fragt gar nicht erst unverschluesselt an (P8, 11.11.2026). Bis dahin
// stand hier, das uebernehme der Proxy; Caddy setzt die Kopfzeile von sich aus aber nicht, sie
// fehlte also. Gesetzt wird sie nur, wenn die Anfrage tatsaechlich ueber https kam (req.secure —
// das meldet der Proxy in X-Forwarded-Proto). Wer die App ohne https betreibt, bekommt sie nicht
// und sperrt sich damit auch nicht aus. Ohne includeSubDomains: Unter derselben Domain koennen
// andere Dienste haengen, ueber die diese App nicht zu bestimmen hat.
const HSTS = 'max-age=31536000';
const CSP_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: fuer Profilbilder. Sie liegen hinter der Anmeldung und werden per fetch geholt;
  // das Ergebnis kann der Browser nur als blob:-Adresse anzeigen. data: bleibt bewusst
  // verboten — das waere die deutlich breitere Erlaubnis.
  "img-src 'self' blob:",
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
  if (req.secure) res.setHeader('Strict-Transport-Security', HSTS);
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Express 5 lässt req.body ohne Body undefined (Express 4: {}) — eine Stelle statt rund 190 ungeprüfter Zugriffe.
app.use(require('./middleware/body-standard'));
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

// API-Antworten nie zwischenspeichern (01.10.2026). Chrome hob API-Antworten mit ETag auf und lieferte bei
// „304 — unverändert" die GESPEICHERTE Antwort samt ihrer alten Kopfzeilen aus, auch ein altes `X-Neues-Token`
// (gleitende Sitzung). Die App übernahm es; lag dessen Anmeldung schon über der Höchstdauer, flog man direkt
// nach jeder Anmeldung wieder heraus — Website-Daten löschen half nicht, nur der Bild- und Datei-Cache (Alex,
// PWA, Zwei-Faktor wöchentlich). Ohne ETag gibt es kein 304, und no-store hält die Antwort ganz aus dem Speicher.
// Routen mit eigener Regel (Profilbilder) setzen ihren Kopf danach und gewinnen. Die App prüft zusätzlich selbst
// (tokenUebernehmen nimmt nur ein NEUERES Token).
app.set('etag', false);
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// API-Routes
app.use('/api/avatare', require('./routes/avatare'));
app.use('/api/auth/2fa', require('./routes/twofa'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/users', require('./routes/users'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/statistics', require('./routes/statistics'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/payouts', require('./routes/payouts'));
app.use('/api/closure', require('./routes/closure'));
app.use('/api/planning', require('./routes/planning'));
app.use('/api/bulletin', require('./routes/bulletin'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/meldungen', require('./routes/meldungen'));
app.use('/api/kollegen', require('./routes/kollegen'));
app.use('/api/products', require('./routes/products'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/notes', require('./routes/notes'));
// Gäste in Notizen: Verwaltung durch den Eigentümer + die Wege des Gasts (ohne Mitarbeiter-Anmeldung)
app.use('/api/notes', require('./routes/notiz-gaeste').verwaltung);
app.use('/api/gast', require('./routes/notiz-gaeste').gast);
app.use('/api/badges', require('./routes/badges'));
app.use('/api/absences', require('./routes/absences'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/push', require('./routes/push'));
app.use('/api/schluessel', require('./routes/schluessel'));

// Kurzlebiges SSE-Ticket: normaler (authentifizierter) Aufruf per Authorization-Header liefert ein
// nur 60 Sekunden gueltiges Token. Der Client haengt DIESES an die SSE-URL — nicht mehr den langen
// Login-Token. Selbst falls die URL in einem Proxy-Log landet, ist das Ticket Sekunden spaeter wertlos.
//
// Das Ticket traegt Stand und Anmeldezeitpunkt der Sitzung, aus der es geholt wurde. Ohne sie
// koennte der Kanal spaeter nicht erkennen, dass genau diese Sitzung beendet worden ist.
app.get('/api/events/ticket', authenticate, (req, res) => {
  const ticket = jwt.sign({ userId: req.user.id, sse: true, sitzung: req.sitzung.stand, anmeldung: req.sitzung.anmeldung },
    JWT_SECRET, { expiresIn: '60s' });
  res.json({ ticket });
});

// Herzschlag des Ereigniskanals. Nur fuer Tests verstellbar (tests/sitzung-widerruf.js) — dreissig
// Sekunden auf einen geschlossenen Kanal zu warten, waere dort verlorene Zeit.
const SSE_PULS_MS = Math.max(200, Number(process.env.SSE_PULS_MS) || 30000);

// SSE – Echtzeit-Updates für alle verbundenen Clients
app.get('/api/events', (req, res) => {
  // Bevorzugt das kurzlebige Ticket; der lange Login-Token bleibt als Fallback gueltig (z.B. fuer
  // einen alten, noch offenen Tab vor dem Reload).
  const token = req.query.ticket || req.query.token;
  if (!token) return res.status(401).end();
  // Dieselbe Pruefung wie an der API (middleware/auth.js, sitzungPruefen) — beim Oeffnen UND danach
  // bei jedem Herzschlag (P6, 10.11.2026). Vorher zaehlte hier nur die Unterschrift: Das Token
  // eines ausgestellten Kontos oder eine per „ueberall abmelden" beendete Anmeldung oeffnete den
  // Kanal weiter, und ein einmal offener Kanal blieb bis zu einer Stunde stehen, egal was mit dem
  // Konto geschah.
  //
  // Die Pruefung im Herzschlag statt eines gezielten Schliessens an jeder Stelle, die eine Sitzung
  // beendet: So kann keine Stelle vergessen werden (Ausstellen, Loeschen, Passwortwechsel,
  // Zurueckspielen einer Sicherung …), und wer selbst sein Passwort wechselt, hat sein neues Token
  // laengst in der Hand, wenn sein eigener Kanal zum Neuverbinden geschlossen wird.
  let sitzungGilt;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Der Zwischen-Token der Zwei-Faktor-Anmeldung ist hier ausdruecklich NICHT gueltig — sonst
    // haette man mit halber Anmeldung einen Live-Draht in die App.
    //
    // Der lange Login-Token bleibt dagegen bewusst weiter erlaubt. Ihn hier zu sperren waere
    // sauberer, wuerde aber jeden alten, noch offenen Tab und jede PWA mit aeltererm Zwischenspeicher
    // von den Live-Aktualisierungen abschneiden, bis jemand neu laedt. Er ist kein Loch: Es IST
    // ein gueltiger Zugangs-Token derselben Person — und er wird genauso geprueft wie an der API.
    if (decoded.pending2fa) return res.status(401).end();
    // Gäste (Etappe C) bekommen den Live-Draht der App nie — ihr Token hat keine Nutzernummer.
    if (decoded.gast !== undefined || decoded.gastTicket !== undefined || !decoded.userId) return res.status(401).end();
    sitzungGilt = () => {
      const db = getDb();
      const pruefung = sitzungPruefen(db, decoded);
      // Ohne eingerichteten zweiten Faktor gibt es keine Datenrouten — und keinen Kanal (GATE_FREI).
      return !!pruefung.user && !einrichtungFehlt(db, pruefung.user);
    };
    if (!sitzungGilt()) return res.status(401).end();
  } catch (_) { return res.status(401).end(); }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  addClient(res);
  const hb = setInterval(() => {
    // Sitzung inzwischen beendet? Dann Schluss. Der Browser verbindet neu, holt dafuer ein Ticket —
    // und erfaehrt dort den Grund (401 mit Code), den ein Ereigniskanal nicht uebermitteln kann.
    let gilt = false;
    try { gilt = sitzungGilt(); } catch (_) {}
    if (!gilt) { try { res.end(); } catch (_) {} return; }
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
  }, SSE_PULS_MS);
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

// Unbekannte Adressen unter /api: 404 als JSON, fuer jede Methode (P9, 11.11.2026). Vorher fiel ein
// GET bis zum Rueckfall auf die App durch und bekam die Startseite mit 200 — ein Tippfehler in
// einer Adresse oder eine entfernte Route sah fuer den Aufrufer aus wie eine gelungene Antwort,
// nur eben mit HTML statt Daten. Muss NACH allen Wegen unter /api stehen und VOR dem Rueckfall.
app.use('/api', (req, res) => {
  res.status(404).json({ code: 'UNBEKANNTE_ADRESSE', error: 'Diese Adresse gibt es nicht.' });
});

// Seite für Gäste einer Notiz (Link: /gast#<Kennung>) — eigene, schlanke Seite ohne die App
app.get('/gast', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'gast.html'));
});

// SPA-Fallback (gerenderte index.html mit Branding-Tokens). Express 5 braucht für „alles" einen benannten Platzhalter.
app.get('/{*rest}', (req, res) => brandingRouter.renderIndex(req, res));

// Fehlerbehandlung
app.use((err, req, res, next) => {
  // Fehler aus express.json() liegen an der ANFRAGE, nicht am Server. Vorher wurde auch daraus
  // „Interner Serverfehler" (500) — wer zu viel Text schickte, erfuhr nicht, woran es lag (R9).
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ code: 'ZU_GROSS', error: 'Die Anfrage ist zu groß und wurde nicht verarbeitet. Bitte kürzer fassen.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Die Anfrage war ungültig und wurde nicht verarbeitet.' });
  }
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

// Server starten (async wegen sql.js)
function cleanupToolHistory() {
  try {
    const { getDb } = require('./database/init');
    const db = getDb();
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const cutoffStr = berlinJetzt(cutoff);
    const result = db.prepare('DELETE FROM tool_checkouts WHERE returned_at IS NOT NULL AND returned_at < ?').run(cutoffStr);
    if (result.changes > 0) console.log(`Werkzeug-Historie: ${result.changes} alte Einträge bereinigt.`);
  } catch (e) {}
}

async function start() {
  await initDatabase();
  cleanupToolHistory();
  setInterval(cleanupToolHistory, 24 * 60 * 60 * 1000); // täglich
  // Geplante Zusammenfassungen (Digest-Push): minütlicher Scheduler.
  require('./scheduler').start(require('./database/init').getDb);
  // Express 5 reicht einen Startfehler (z. B. Port belegt) an diesen Rückruf, statt abzustürzen wie Express 4.
  // Ohne die Prüfung meldete der Server „läuft" und endete mit Code 0 (nachgemessen in tests/express5-routen.js) —
  // ein irreführendes Protokoll, und ein Test auf belegtem Port hätte die Antworten eines fremden Servers geprüft.
  app.listen(PORT, LISTEN_HOST, (err) => {
    if (err) {
      console.error(`Server konnte nicht starten (Adresse ${LISTEN_HOST}, Port ${PORT}): ${err.code || err.message}`);
      process.exit(1);
    }
    console.log(`Arbeitsdoku-Server läuft auf http://localhost:${PORT}`);
    console.log(NUR_DIESER_RECHNER
      ? `Erreichbar nur von diesem Rechner (${LISTEN_HOST}) — gedacht für den Betrieb hinter einem Proxy. Direkt aus dem Netz: LISTEN_HOST=0.0.0.0 in der .env setzen.`
      : `Lauscht auf ${LISTEN_HOST} — direkt aus dem Netz erreichbar.`);
  });
}

// Graceful shutdown. Offene Live-Notizen zuerst in die Datenbank schreiben — sie speichern sonst
// erst nach 1,5 s Ruhe, und die letzten Tastendrücke vor einem Neustart (Deploy) gingen verloren.
function offeneNotizenSichern() {
  try { require('./notizen-live').allesSpeichern(); } catch (e) { console.error('Live-Notizen nicht gesichert:', e.message); }
}
// Absturz-Schutz (R2): async-Routen antworten mit 500 statt den Server zu beenden; unbehandelte Fehler
// werden protokolliert, bei echten Programmfehlern erst gesichert, dann neu gestartet.
const absturzschutz = require('./absturzschutz');
absturzschutz.asyncRoutenAbsichern();
absturzschutz.prozessWaechter({ sichern: () => { offeneNotizenSichern(); saveToFile(); } });

process.on('SIGINT', () => {
  console.log('\nServer wird beendet...');
  offeneNotizenSichern();
  saveToFile();
  process.exit(0);
});

process.on('SIGTERM', () => {
  offeneNotizenSichern();
  saveToFile();
  process.exit(0);
});

start().catch(err => {
  console.error('Fehler beim Starten:', err);
  process.exit(1);
});
