// Gäste in Notizen (Etappe C, 27.09.2026).
//
// Der Eigentümer einer Notiz lädt Leute von außerhalb der Firma ein (Alex, 26.09.2026: „jeder kann
// mehrere externe Mituser anlegen, denen Namen vergeben, jeder bekommt einen eigenen Link mit
// Passwort und Lese- oder Schreibrecht; einzeln entziehbar"). Entschieden dazu:
//   * Den NAMEN vergibt der Eigentümer; überall steht er mit dem festen Zusatz „(Gast)".
//   * Neues Passwort → nur DIESER Gast fliegt raus. Schreiben → Lesen gilt sofort, ohne Rauswurf.
//   * Ablaufdatum je Gast, freiwillig. Das Gerät merkt sich den Zugang 7 Tage, solange das Passwort gleich ist.
//   * Gäste sehen von den Mitarbeitern nur den Vornamen (notizen-live.js).
//   * Firmenschalter in den Einstellungen (`notiz_gaeste`); ausschalten wirft alle Gäste sofort raus.
//   * Fehlversuch-Bremse: 5 falsche Passwörter → 15 Minuten gesperrt, der Eigentümer wird benachrichtigt.
//
// Die Anmeldung eines Gasts ist ein eigenes Token (`gast`), das NIE als Mitarbeiter-Anmeldung gilt
// (middleware/auth.js, server.js /api/events) — und umgekehrt öffnet kein Mitarbeiter-Token die
// Gast-Wege (gastPruefen verlangt `gast`).
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { berlinHeute } = require('./zeit');

const JWT_SECRET = process.env.JWT_SECRET;
const PASSWORT_MIN = 8;              // wie bei den Konten (routes/users.js)
const NAME_MAX = 40;
const FEHLVERSUCHE_BIS_SPERRE = 5;
const SPERRE_MS = 15 * 60 * 1000;
const MERKEN = '7d';                 // so lange merkt sich ein Gerät den Zugang
const DUMMY_HASH = bcrypt.hashSync('gleich-lange-pruefen-auch-ohne-gast', 10);

/** Sind Gäste in dieser Firma erlaubt? Ohne Eintrag: ja (Alex: alle dürfen Gäste einladen). */
function erlaubt(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'notiz_gaeste'").get();
  return !r || r.value !== 'aus';
}

const abgelaufen = (g, heute = berlinHeute()) => !!g.ablauf && heute > g.ablauf;
const anzeigeName = (g) => `${g.name} (Gast)`;
const neuesToken = () => crypto.randomBytes(24).toString('base64url');

/**
 * Hat dieser Gast gerade Zugriff auf seine Notiz? 'write' | 'read' | null — mit Grund, wenn nicht.
 * Wird bei JEDER Gast-Anfrage und bei jeder Änderung im Live-Raum neu gefragt.
 */
function zugriff(db, gastId) {
  const g = db.prepare('SELECT * FROM note_gaeste WHERE id = ?').get(gastId);
  if (!g) return { zugriff: null, grund: 'gast-entfernt' };
  if (!erlaubt(db)) return { zugriff: null, grund: 'gaeste-aus', gast: g };
  if (abgelaufen(g)) return { zugriff: null, grund: 'gast-abgelaufen', gast: g };
  const n = db.prepare(`SELECT n.id, n.user_id, COALESCE(u.active, 1) AS aktiv, n.projekt_notiz_fuer, p.id AS pid, p.deleted_at AS p_geloescht
    FROM notes n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN projects p ON p.id = n.projekt_notiz_fuer WHERE n.id = ?`).get(g.note_id);
  if (!n) return { zugriff: null, grund: 'geloescht', gast: g };
  // Projektnotiz: Projekt im Papierkorb oder weg → wie gelöscht
  if (n.projekt_notiz_fuer && (!n.pid || n.p_geloescht)) return { zugriff: null, grund: 'geloescht', gast: g };
  // Ausgestellter Eigentümer: Seine Einladungen gelten nicht weiter.
  if (n.aktiv === 0) return { zugriff: null, grund: 'gast-entfernt', gast: g };
  return { zugriff: g.permission === 'write' ? 'write' : 'read', gast: g, eigentuemer: n.user_id };
}

// ─── Verwalten (nur der Eigentümer) ──────────────────────────────────────────────────────────

function pruefeEingabe({ name, permission, passwort, ablauf }, { neu }) {
  if (name !== undefined || neu) {
    const n = String(name || '').trim();
    if (!n) return 'Bitte einen Namen angeben — so erscheint der Gast bei allen in der Notiz.';
    if (n.length > NAME_MAX) return `Der Name darf höchstens ${NAME_MAX} Zeichen haben.`;
  }
  if (permission !== undefined && !['read', 'write'].includes(permission)) return 'Recht: erwartet „Lesen" oder „Schreiben".';
  if (passwort !== undefined || neu) {
    if (typeof passwort !== 'string' || passwort.length < PASSWORT_MIN) return `Das Passwort braucht mindestens ${PASSWORT_MIN} Zeichen.`;
    if (passwort.length > 200) return 'Das Passwort ist zu lang.';
  }
  if (ablauf !== undefined && ablauf !== null && ablauf !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ablauf) || isNaN(new Date(ablauf + 'T12:00:00Z'))) return 'Ablaufdatum: erwartet ein gültiges Datum.';
    if (ablauf < berlinHeute()) return 'Das Ablaufdatum liegt in der Vergangenheit.';
  }
  return null;
}

/** Was der Eigentümer über einen Gast sieht (ohne Hash). */
function fuerEigentuemer(g) {
  return { id: g.id, name: g.name, permission: g.permission, token: g.token, ablauf: g.ablauf || null,
    abgelaufen: abgelaufen(g), gesperrt: !!(g.gesperrt_bis && g.gesperrt_bis > Date.now()),
    zuletzt_da: g.zuletzt_da || null, created_at: g.created_at };
}

function liste(db, noteId) {
  return db.prepare('SELECT * FROM note_gaeste WHERE note_id = ? ORDER BY name COLLATE NOCASE, id').all(noteId).map(fuerEigentuemer);
}

function nameVergeben(db, noteId, name, ausser) {
  return db.prepare('SELECT id FROM note_gaeste WHERE note_id = ? AND lower(name) = lower(?) AND id != ?').get(noteId, String(name).trim(), ausser || 0);
}

async function anlegen(db, noteId, eingabe, vonUserId) {
  const fehler = pruefeEingabe(eingabe, { neu: true });
  if (fehler) return { status: 400, fehler };
  if (nameVergeben(db, noteId, eingabe.name)) return { status: 400, fehler: 'Diesen Namen hat in dieser Notiz schon ein Gast. Bitte unterscheidbar benennen.' };
  const hash = await bcrypt.hash(eingabe.passwort, 10);
  const r = db.prepare(`INSERT INTO note_gaeste (note_id, name, permission, token, pw_hash, pw_stand, ablauf, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`)
    .run(noteId, String(eingabe.name).trim(), eingabe.permission === 'write' ? 'write' : 'read', neuesToken(), hash, eingabe.ablauf || null, vonUserId);
  return { status: 201, gast: fuerEigentuemer(db.prepare('SELECT * FROM note_gaeste WHERE id = ?').get(r.lastInsertRowid)) };
}

/** Name, Recht, Ablauf ändern. Liefert { status, gast, vorher }. */
function aendern(db, noteId, gastId, eingabe) {
  const g = db.prepare('SELECT * FROM note_gaeste WHERE id = ? AND note_id = ?').get(gastId, noteId);
  if (!g) return { status: 404, fehler: 'Diesen Gast gibt es nicht (mehr).' };
  const e = { name: eingabe.name, permission: eingabe.permission, ablauf: eingabe.ablauf };
  const fehler = pruefeEingabe(e, { neu: false });
  if (fehler) return { status: 400, fehler };
  if (e.name !== undefined && nameVergeben(db, noteId, e.name, gastId)) return { status: 400, fehler: 'Diesen Namen hat in dieser Notiz schon ein Gast.' };
  db.prepare('UPDATE note_gaeste SET name = ?, permission = ?, ablauf = ? WHERE id = ?').run(
    e.name !== undefined ? String(e.name).trim() : g.name,
    e.permission !== undefined ? e.permission : g.permission,
    e.ablauf !== undefined ? (e.ablauf || null) : g.ablauf,
    gastId);
  return { status: 200, vorher: g, gast: fuerEigentuemer(db.prepare('SELECT * FROM note_gaeste WHERE id = ?').get(gastId)) };
}

/** Neues Passwort: entwertet jede bestehende Anmeldung dieses Gasts, hebt eine Sperre auf. */
async function passwortSetzen(db, noteId, gastId, passwort) {
  const g = db.prepare('SELECT * FROM note_gaeste WHERE id = ? AND note_id = ?').get(gastId, noteId);
  if (!g) return { status: 404, fehler: 'Diesen Gast gibt es nicht (mehr).' };
  const fehler = pruefeEingabe({ passwort }, { neu: false });
  if (fehler) return { status: 400, fehler };
  const hash = await bcrypt.hash(passwort, 10);
  db.prepare('UPDATE note_gaeste SET pw_hash = ?, pw_stand = pw_stand + 1, fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?').run(hash, gastId);
  return { status: 200, gast: fuerEigentuemer(db.prepare('SELECT * FROM note_gaeste WHERE id = ?').get(gastId)), vorher: g };
}

function entfernen(db, noteId, gastId) {
  const g = db.prepare('SELECT * FROM note_gaeste WHERE id = ? AND note_id = ?').get(gastId, noteId);
  if (!g) return { status: 404, fehler: 'Diesen Gast gibt es nicht (mehr).' };
  db.prepare('DELETE FROM note_gaeste WHERE id = ?').run(gastId);
  return { status: 200, vorher: g };
}

// ─── Anmelden und prüfen (der Gast) ──────────────────────────────────────────────────────────

/**
 * Link-Kennung + Passwort → Anmeldung. Liefert { status, fehler?, code?, token?, gast?, gesperrt? }.
 * `gesperrt` ist gesetzt, wenn DIESER Versuch die Sperre ausgelöst hat (die Route meldet es dem Eigentümer).
 */
async function anmelden(db, token, passwort) {
  const g = token ? db.prepare('SELECT * FROM note_gaeste WHERE token = ?').get(String(token)) : null;
  if (!g) {
    await bcrypt.compare(String(passwort || ''), DUMMY_HASH);   // gleich lange wie ein echter Versuch
    return { status: 404, code: 'GAST_UNBEKANNT', fehler: 'Dieser Link gilt nicht (mehr). Bitte frag bei dem nach, der ihn dir geschickt hat.' };
  }
  const z = zugriff(db, g.id);
  if (!z.zugriff) return { status: 403, code: z.grund.toUpperCase().replace(/-/g, '_'), fehler: grundText(z.grund), gast: g };
  if (g.gesperrt_bis && g.gesperrt_bis > Date.now()) {
    const min = Math.ceil((g.gesperrt_bis - Date.now()) / 60000);
    return { status: 429, code: 'GAST_GESPERRT', fehler: `Zu viele falsche Passwörter. Dieser Zugang ist noch ${min} Minute${min === 1 ? '' : 'n'} gesperrt.`, gast: g };
  }
  if (!(await bcrypt.compare(String(passwort || ''), g.pw_hash))) {
    const versuche = (g.fehlversuche || 0) + 1;
    if (versuche >= FEHLVERSUCHE_BIS_SPERRE) {
      db.prepare('UPDATE note_gaeste SET fehlversuche = 0, gesperrt_bis = ? WHERE id = ?').run(Date.now() + SPERRE_MS, g.id);
      return { status: 429, code: 'GAST_GESPERRT', gesperrt: true, gast: g,
        fehler: `Zu viele falsche Passwörter. Dieser Zugang ist jetzt ${SPERRE_MS / 60000} Minuten gesperrt.` };
    }
    db.prepare('UPDATE note_gaeste SET fehlversuche = ? WHERE id = ?').run(versuche, g.id);
    const rest = FEHLVERSUCHE_BIS_SPERRE - versuche;
    return { status: 401, code: 'GAST_PASSWORT_FALSCH', gast: g,
      fehler: `Das Passwort stimmt nicht.${rest <= 2 ? ` Noch ${rest} Versuch${rest === 1 ? '' : 'e'}, dann wird der Zugang für eine Viertelstunde gesperrt.` : ''}` };
  }
  db.prepare("UPDATE note_gaeste SET fehlversuche = 0, gesperrt_bis = NULL, zuletzt_da = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(g.id);
  return { status: 200, gast: g, zugriff: z.zugriff, token: jwt.sign({ gast: g.id, pws: g.pw_stand }, JWT_SECRET, { expiresIn: MERKEN }) };
}

function grundText(grund) {
  return {
    'gast-entfernt': 'Dieser Zugang wurde entfernt.',
    'gaeste-aus': 'Gastzugänge sind derzeit abgeschaltet.',
    'gast-abgelaufen': 'Dieser Zugang ist abgelaufen.',
    'geloescht': 'Diese Notiz gibt es nicht mehr.',
    'passwort-geaendert': 'Das Passwort wurde geändert. Bitte mit dem neuen Passwort anmelden.',
  }[grund] || 'Kein Zugang.';
}

/**
 * Anmeldung eines Gasts prüfen (Bearer-Token oder 60-s-Ticket). Liefert { gast, zugriff, eigentuemer }
 * oder { status, code, fehler }. `art` = 'gast' (Anmeldung) | 'ticket' (Ereignisstrom).
 */
function pruefen(db, tokenText, art = 'gast') {
  let t;
  try { t = jwt.verify(String(tokenText || ''), JWT_SECRET); } catch (_) {
    return { status: 401, code: 'GAST_NICHT_ANGEMELDET', fehler: 'Bitte mit dem Passwort anmelden.' };
  }
  const id = art === 'ticket' ? t.gastTicket : t.gast;
  if (!Number.isInteger(id)) return { status: 401, code: 'GAST_NICHT_ANGEMELDET', fehler: 'Bitte mit dem Passwort anmelden.' };
  const z = zugriff(db, id);
  if (z.gast && z.gast.pw_stand !== t.pws) return { status: 401, code: 'GAST_PASSWORT_GEAENDERT', fehler: grundText('passwort-geaendert') };
  if (!z.zugriff) return { status: z.grund === 'gast-entfernt' ? 401 : 403, code: z.grund.toUpperCase().replace(/-/g, '_'), fehler: grundText(z.grund) };
  return { gast: z.gast, zugriff: z.zugriff, eigentuemer: z.eigentuemer };
}

const ticket = (g) => jwt.sign({ gastTicket: g.id, pws: g.pw_stand }, JWT_SECRET, { expiresIn: '60s' });

module.exports = { erlaubt, zugriff, liste, anlegen, aendern, passwortSetzen, entfernen, anmelden, pruefen, ticket,
  anzeigeName, abgelaufen, grundText, PASSWORT_MIN, FEHLVERSUCHE_BIS_SPERRE, SPERRE_MS };
