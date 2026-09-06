const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { darfBestellen } = require('../bestellrecht');
const { berlinJetzt } = require('../zeit');

const router = express.Router();

/**
 * `seen_at` als BERLINER Ortszeit — vergleichbar mit Feldern, die `berlinNow()` geschrieben hat.
 *
 * `user_seen.seen_at` entsteht mit SQLites `strftime('now')` und ist damit UTC. Die meisten Zähler
 * vergleichen es gegen Felder, die ebenfalls per `strftime('now')` gesetzt wurden (bulletin,
 * notes) — dort passt es. `overtime_payouts.entschieden_am` kommt dagegen aus `berlinNow()`, also
 * aus der Ortszeit: Im Sommer läge „gesehen" zwei Stunden HINTER der Entscheidung, und die
 * Meldung bliebe nach dem Ansehen noch zwei Stunden stehen. Gefunden, weil der Test genau das
 * gemessen hat.
 *
 * Die Umrechnung geht über den echten Zeitstempel und ist damit sommerzeitfest — ein festes
 * „+2 Stunden" wäre im Winter falsch.
 */
function getSeenAtBerlin(db, userId, topic) {
  const utc = getSeenAt(db, userId, topic);
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return utc;
  return berlinJetzt(d);
}

function getSeenAt(db, userId, topic) {
  const row = db.prepare('SELECT seen_at FROM user_seen WHERE user_id = ? AND topic = ?').get(userId, topic);
  return row ? row.seen_at : '2000-01-01 00:00:00';
}

// Zähler je Kategorie für EINEN Nutzer (rollen-/seen-abhängig). Von GET / UND dem Zusammenfassungs-
// Scheduler (scheduler.js) genutzt — Verhalten identisch zur bisherigen Route.
function computeBadgeCounts(db, user) {
  const uid = user.id;
  const role = user.role;

  const bulletinSince = getSeenAt(db, uid, 'bulletin');
  const notesSince    = getSeenAt(db, uid, 'notes');

  const bulletin = db.prepare(
    "SELECT COUNT(*) as n FROM bulletin_entries WHERE updated_at > ? AND COALESCE(updated_by, created_by) != ?"
  ).get(bulletinSince, uid).n;

  const sharedNotes = db.prepare(`
    SELECT COUNT(DISTINCT id) as n FROM (
      SELECT n.id FROM notes n
      WHERE n.user_id = ? AND n.updated_at > ? AND COALESCE(n.updated_by, n.user_id) != ?
      UNION
      SELECT n.id FROM notes n
      JOIN note_shares ns ON ns.note_id = n.id AND ns.user_id = ?
      WHERE (n.updated_at > ? AND COALESCE(n.updated_by, n.user_id) != ?) OR ns.created_at > ?
    )
  `).get(uid, notesSince, uid, uid, notesSince, uid, notesSince).n;

  const offers = db.prepare(
    "SELECT COUNT(*) as n FROM note_offers WHERE to_user_id = ? AND status = 'pending'"
  ).get(uid).n;

  // Der Zaehler folgt dem Recht, nicht der Rolle: Wer bestellen darf, muss auch sehen, dass etwas
  // offen ist. Seit dem 27.08.2026 gilt das ausnahmslos, den Buchhalter eingeschlossen (Alex: „wer
  // bestellen kann, muss auch coin und push bekommen") — und die Frage wird mit demselben Helfer
  // gestellt wie ueberall sonst, damit die Fassungen nicht wieder auseinanderlaufen.
  let orders = 0;
  if (darfBestellen(user)) {
    orders = db.prepare("SELECT COUNT(*) as n FROM orders WHERE ordered_at IS NULL").get().n;
  }

  // Abwesenheits-Badge für Chef/Admin/Buchhalter: neue Items zu bearbeiten
  let absences = 0;
  if (role !== 'mitarbeiter') {
    const absencesSince = getSeenAt(db, uid, 'absences');
    absences = db.prepare(`
      SELECT COUNT(*) as n FROM absences
      WHERE updated_at > ?
        AND deleted_at IS NULL
        AND (user_id IS NULL OR user_id != ?)
        AND COALESCE(created_by, user_id) != ?
        AND (processed_by IS NULL OR processed_by != ?)
        AND (
          status = 'pending'
          OR (status = 'active' AND type IN ('krank','berufsschule','innung')
              AND (notified_at IS NULL OR notified_at > ?))
        )
    `).get(absencesSince, uid, uid, uid, absencesSince).n;
  }

  // Alle Rollen: eigene Abwesenheiten mit ausstehender Bestätigung (Manager hat Änderungen vorgenommen)
  const maAckCount = db.prepare(
    'SELECT COUNT(*) as n FROM absences WHERE user_id = ? AND ma_needs_ack = 1 AND deleted_at IS NULL'
  ).get(uid).n;

  // MA: Status-Änderungen (genehmigt/abgelehnt) an eigenen Abwesenheiten seit letztem Besuch
  let maStatusCount = 0;
  if (role === 'mitarbeiter') {
    const statusSince = getSeenAt(db, uid, 'absence_status');
    maStatusCount = db.prepare(`
      SELECT COUNT(*) as n FROM absences
      WHERE user_id = ? AND updated_at > ? AND ma_needs_ack = 0
      AND deleted_at IS NULL
      AND (
        status IN ('approved','rejected')
        OR (status = 'pending' AND created_by IS NOT NULL AND created_by != user_id
            AND type IN ('urlaub','freizeitausgleich','sonderurlaub'))
      )
    `).get(uid, statusSince).n;
  }

  // Offene Ueberstunden-Auszahlung, die AUF MICH wartet. Sie haengt an "Mein Konto", weil dort
  // entschieden wird — und nur der Betroffene selbst kann entscheiden, auch kein Admin fuer ihn.
  // Jede Rolle kann betroffen sein, deshalb ohne Rollenabfrage.
  let konto = 0;
  try {
    konto = db.prepare("SELECT COUNT(*) as n FROM overtime_payouts WHERE user_id = ? AND status = 'offen'").get(uid).n;
  } catch (_) { konto = 0; }   // Tabelle fehlt (sehr alte Sicherung) -> nichts offen

  // Manager: Entscheidungen ueber Ueberstunden-Auszahlungen, die er noch nicht gesehen hat.
  //
  // Ohne diesen Zaehler haette der Chef keinen Anlass, ueberhaupt in die Mitarbeiterliste zu
  // schauen — er stellt eine Anfrage und erfaehrt nie, was daraus wurde. Gezaehlt werden nur
  // FREMDE Entscheidungen: Traegt er selbst eine unterschriebene Zustimmung ein, muss er sich
  // darueber nicht selbst benachrichtigen.
  let mitarbeiter = 0;
  if (role === 'chef' || role === 'admin') {
    const seit = getSeenAtBerlin(db, uid, 'mitarbeiter');
    try {
      mitarbeiter = db.prepare(
        `SELECT COUNT(*) as n FROM overtime_payouts
          WHERE status IN ('bestaetigt','abgelehnt')
            AND entschieden_am IS NOT NULL AND entschieden_am > ?
            AND COALESCE(entschieden_von, 0) != ?`
      ).get(seit, uid).n;
    } catch (_) { mitarbeiter = 0; }   // Tabelle fehlt (sehr alte Sicherung)
  }

  return { bulletin, notes: sharedNotes + offers, orders, absences: absences + maAckCount + maStatusCount, konto, mitarbeiter };
}

router.get('/', authenticate, (req, res) => {
  res.json(computeBadgeCounts(getDb(), req.user));
});

router.post('/:topic', authenticate, (req, res) => {
  const { topic } = req.params;
  if (!['bulletin', 'notes', 'absences', 'absence_status', 'mitarbeiter'].includes(topic)) return res.status(400).json({ error: 'Unbekanntes Topic' });
  const db = getDb();
  db.prepare(
    "INSERT INTO user_seen (user_id, topic, seen_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')) " +
    "ON CONFLICT(user_id, topic) DO UPDATE SET seen_at = strftime('%Y-%m-%d %H:%M:%f', 'now')"
  ).run(req.user.id, topic);
  res.json({ success: true });
});

module.exports = router;
module.exports.getSeenAt = getSeenAt;
module.exports.getSeenAtBerlin = getSeenAtBerlin;
module.exports.computeBadgeCounts = computeBadgeCounts;
