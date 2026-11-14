// Zugangsschlüssel für Programme (Alex, 14.11.2026).
//
// Ein Programm — zuerst Alex' Hermes-Agent über /mcp, später Home Assistant oder ioBroker — meldet
// sich nicht mit Passwort an, sondern mit einem persönlichen Schlüssel `adk_…`. Der Schlüssel gehört
// zu genau einem App-Benutzer und kann nie mehr als dieser: Er läuft durch dieselben Routen wie die
// Oberfläche (middleware/auth.js, mitSchluessel), mit denselben Prüfungen und Rechten.
//
// Was ein Schlüssel ZUSÄTZLICH nicht darf, steht hier in EINER Liste (ERLAUBT). Alles, was dort nicht
// steht, ist verboten — Verwaltung, Einstellungen, Sicherungen, Papierkorb, Datei-Downloads, die
// Schlüssel selbst. Eine Erlaubt-Liste statt einer Verbotsliste: Eine neue Route ist für Schlüssel
// erst einmal zu, bis jemand sie bewusst einträgt.
//
// Gespeichert wird nur der SHA-256 des Schlüssels. Der Schlüssel ist 32 Zufallsbytes (256 Bit) — ein
// langsamer Passwort-Hash wie bcrypt schützt dort nichts zusätzlich, er würde nur jede Anfrage bremsen.
const crypto = require('crypto');

const PRAEFIX = 'adk_';
const RECHTE = ['lesen', 'schreiben'];   // 'schreiben' heißt „lesen + schreiben"

function istSchluessel(token) {
  return typeof token === 'string' && token.startsWith(PRAEFIX);
}
function hashVon(roh) {
  return crypto.createHash('sha256').update(String(roh)).digest('hex');
}
/** Neuer Schlüssel: `roh` wird genau einmal angezeigt, gespeichert werden nur `hash` und `anzeige`. */
function erzeugen() {
  const roh = PRAEFIX + crypto.randomBytes(32).toString('base64url');
  return { roh, hash: hashVon(roh), anzeige: roh.slice(0, PRAEFIX.length + 6) + '…' };
}

// ── Erlaubt-Liste ─────────────────────────────────────────────────────────────────────────────
// Lesen: nur GET, nur Datenrouten. Bewusst NICHT dabei: Papierkorb (/deleted), Änderungsverläufe
// (/history), CSV-/PDF-Exporte, Datei-Downloads, /api/users (Personaldaten — es gibt /api/users/list
// mit Namen und Rollen), Geburtstage, alles unter /api/auth, /api/settings, /api/backup, /api/audit,
// /api/push, /api/schluessel, der Ereigniskanal und die Gast-Zugänge der Notizen.
const Z = '\\d+';
const LESEN = [
  '/api/entries', `/api/entries/${Z}`,
  '/api/users/list',
  '/api/projects', '/api/projects/kategorien', `/api/projects/${Z}`, `/api/projects/${Z}/stats`, `/api/projects/${Z}/notiz`,
  '/api/planning', `/api/planning/${Z}`,
  '/api/absences', '/api/absences/summary', '/api/absences/vacation-overview', '/api/absences/by-date',
  '/api/statistics', '/api/statistics/overtime', '/api/statistics/target-hours',
  `/api/statistics/targets/${Z}`, `/api/statistics/vacation/${Z}`,
  '/api/payouts', `/api/payouts/stand/${Z}`,
  '/api/closure',
  '/api/bulletin',
  '/api/tools', `/api/tools/${Z}/history`,
  '/api/orders', '/api/orders/ordered',
  '/api/meldungen', '/api/meldungen/history', `/api/meldungen/${Z}`,
  '/api/kollegen', `/api/kollegen/${Z}`,
  '/api/products', '/api/products/katalog', '/api/products/kategorien', `/api/products/${Z}/haendler`,
  '/api/suppliers', `/api/suppliers/${Z}/produkte`,
  '/api/notes',
  '/api/documents', '/api/documents/folders/all',
];
// Schreiben (nur Recht 'schreiben'): Zeiteinträge anlegen und ändern. Nie DELETE.
const SCHREIBEN = [
  ['POST', '/api/entries'],
  ['PUT', `/api/entries/${Z}`],
];
const muster = (p) => new RegExp('^' + p + '/?$');
const LESEN_RE = LESEN.map(muster);
const SCHREIBEN_RE = SCHREIBEN.map(([m, p]) => [m, muster(p)]);

/** Darf ein Schlüssel mit diesem Recht diese Anfrage stellen? `pfad` ohne Abfrageteil. */
function erlaubt(recht, methode, pfad) {
  const p = String(pfad || '').split('?')[0];
  const m = String(methode || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return LESEN_RE.some(r => r.test(p));
  if (recht !== 'schreiben') return false;
  return SCHREIBEN_RE.some(([mm, r]) => mm === m && r.test(p));
}

// ── Bremsen ───────────────────────────────────────────────────────────────────────────────────
// Feste Zeitfenster im Speicher (wie die Anmeldebremse). Nach einem Neustart beginnen sie neu —
// für eine Bremse gegen Dauerfeuer reicht das.
function fenster(max, ms) {
  const zaehler = new Map();
  return {
    /** Zählt einen Treffer; true = über der Grenze. */
    zaehlen(schl) {
      const jetzt = Date.now();
      let z = zaehler.get(schl);
      if (!z || jetzt - z.start >= ms) { z = { start: jetzt, n: 0 }; zaehler.set(schl, z); }
      z.n++;
      if (zaehler.size > 5000) for (const [k, v] of zaehler) if (jetzt - v.start >= ms) zaehler.delete(k);
      return z.n > max;
    },
    gesperrt(schl) {
      const z = zaehler.get(schl);
      return !!z && Date.now() - z.start < ms && z.n >= max;
    },
    leeren() { zaehler.clear(); },
  };
}
const GRENZEN = { jeSchluessel: 60, jeIp: 120, fehlversucheJeIp: 10 };   // je Minute
const bremsen = {
  schluessel: fenster(GRENZEN.jeSchluessel, 60000),
  ip: fenster(GRENZEN.jeIp, 60000),
  fehlversuch: fenster(GRENZEN.fehlversucheJeIp, 60000),
};

// ── Interne Aufrufe ───────────────────────────────────────────────────────────────────────────
// Die MCP-Werkzeuge rufen die eigenen Routen über 127.0.0.1 auf (mcp-werkzeuge.js). Dabei gingen die
// echte Adresse des Aufrufers und der Name des Werkzeugs verloren, und jeder Folgeaufruf würde die
// Bremse ein zweites Mal treffen. Deshalb tragen interne Aufrufe ein Geheimnis, das nur dieser
// Prozess kennt (bei jedem Start neu) — nur dann gelten ihre Angaben zu Adresse und Werkzeug.
const INTERN = crypto.randomBytes(24).toString('hex');
function internerAufruf(req) {
  const h = req.headers || {};
  const geheim = String(h['x-intern'] || '');
  if (geheim.length !== INTERN.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(geheim), Buffer.from(INTERN))) return null;
  return { ip: String(h['x-intern-ip'] || '').slice(0, 64), werkzeug: String(h['x-intern-werkzeug'] || '').slice(0, 64) };
}

module.exports = {
  PRAEFIX, RECHTE, istSchluessel, hashVon, erzeugen, erlaubt, LESEN, SCHREIBEN,
  GRENZEN, bremsen, INTERN, internerAufruf,
};
