// Was beim Ausstellen eines Mitarbeiters wirklich passiert — an EINER Stelle.
//
// Es gibt ZWEI Aufrufer:
//   1. `POST /api/users/:id/deactivate` — rueckwirkendes Austrittsdatum, wirkt sofort
//   2. `scheduler.js` — eine VORGEMERKTE Ausstellung wird faellig
//
// Stuende die Aufraeumarbeit zweimal im Code, liefe sie auseinander, sobald jemand nur eine der
// beiden Stellen anfasst — genau die Falle, die beim Bestellrecht dreimal zugeschlagen hat
// (siehe bestellrecht.js). Deshalb hier, wie dort.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN). Fehlt sie auf dem
// Server, startet der Dienst nach dem Neustart gar nicht mehr.
const zweiFaktor = require('./zweifaktor');
const { logAudit } = require('./audit');

const berlinHeute = () =>
  new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);
const berlinJetzt = () =>
  new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ');

/**
 * Das Austrittsdatum am Anstellungszeitraum festschreiben.
 *
 * Getrennt vom Vollzug, weil es zu einem ANDEREN Zeitpunkt passiert: Bei einer Vormerkung steht
 * das Datum sofort fest (und begrenzt damit schon die Soll-Stunden), das Konto schliesst aber
 * erst am Tag danach.
 */
function austrittsdatumSetzen(db, userId, employedUntil) {
  const offen = db.prepare(
    'SELECT id FROM employment_periods WHERE user_id = ? AND end_date IS NULL ORDER BY start_date DESC LIMIT 1'
  ).get(userId);
  if (offen) {
    db.prepare('UPDATE employment_periods SET end_date = ? WHERE id = ?').run(employedUntil, offen.id);
  } else {
    // Kein offener Zeitraum (Daten-Altlast) -> einen abgeschlossenen Tageszeitraum anlegen
    db.prepare('INSERT INTO employment_periods (user_id, start_date, end_date) VALUES (?, ?, ?)')
      .run(userId, employedUntil, employedUntil);
  }
}

/** Eine Vormerkung wieder aufheben: Der Zeitraum ist wieder offen. */
function austrittsdatumAufheben(db, userId) {
  const r = db.prepare(
    `UPDATE employment_periods SET end_date = NULL
      WHERE id = (SELECT id FROM employment_periods WHERE user_id = ? ORDER BY start_date DESC LIMIT 1)`
  ).run(userId);
  return r.changes > 0;
}

/**
 * Das Konto wirklich schliessen — der Vollzug.
 *
 * @param wer  { id, username, ip } — wer es ausgeloest hat. Beim Zeitplaner ist das der, der die
 *             Vormerkung angelegt hat: Der Vollzug ist seine Entscheidung, nur zeitversetzt.
 * @param zusatz  Text, der an den Protokolleintrag angehaengt wird (z. B. „(am … vorgemerkt)").
 */
function ausstellenVollziehen(db, userId, employedUntil, wer, zusatz = '') {
  const nutzer = db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId);

  db.prepare('UPDATE users SET active = 0, deactivated_at = ?, deactivated_by = ? WHERE id = ?')
    .run(berlinJetzt(), wer.id, userId);

  // Push-Abos des ausgestellten Nutzers entfernen (er soll keine Benachrichtigungen mehr bekommen;
  // notifyUsers sperrt zusaetzlich serverseitig). Bei Wiedereinstellung re-abonniert das Geraet beim Login.
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);

  // Zweiten Faktor loeschen (Alex, 25.08.2026). Ohne das ueberlebt der Authenticator auf dem
  // privaten Handy das Ausstellen — samt der gemerkten Geraete, die je nach Intervall wochenlang
  // gar keinen Code verlangen. Kaeme der Account je versehentlich wieder auf active=1, waere sein
  // altes Handy sofort wieder ein gueltiger zweiter Faktor: kein Schutz mehr, sondern eine offene
  // Tuer, die niemand sieht. Bei Wiedereinstellung richtet er neu ein — derselbe Weg wie beim
  // Handywechsel, den es als Knopf ohnehin gibt.
  //
  // Profilbild und Rechte bleiben ABSICHTLICH stehen: Das Bild haengt an alten Ansichten, und die
  // Rechte wirken ohne aktiven Account nicht — beide koennen nicht zur stillen Hintertuer werden.
  const hatteZweiFaktor = !!db.prepare('SELECT user_id FROM twofa_secrets WHERE user_id = ?').get(userId);
  zweiFaktor.zuruecksetzen(db, userId);

  logAudit(db, {
    userId: wer.id, username: wer.username, action: 'user_deactivate',
    details: `Ausgestellt: ${nutzer ? nutzer.username : '?'} (${nutzer ? nutzer.role : '?'}, id=${userId}), `
      + `letzter Arbeitstag ${employedUntil}${zusatz}`
      + (hatteZweiFaktor ? ' · Zwei-Faktor geloescht (Neueinrichtung noetig)' : ''),
    ip: wer.ip,
  });
  return { hatteZweiFaktor };
}

module.exports = { austrittsdatumSetzen, austrittsdatumAufheben, ausstellenVollziehen, berlinHeute, berlinJetzt };
