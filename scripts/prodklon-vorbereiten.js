// Aus einer ROHEN Kopie der Produktivdaten die Testvorlage /tmp/prodklon.db bauen.
//
// Warum es das braucht: Mehrere Tests melden sich am Klon mit dem Passwort `test` an
// (tests/aussperren-prodklon.js, tests/zweifaktor-klickweg-prodklon.js …). Eine rohe Kopie hat
// die echten Passwort-Hashes — die Anmeldung schlaegt fehl, und der Test meldet einen Fehler, der
// keiner ist. Genau das ist am 06.09.2026 passiert, weil die rohe Kopie ueber die Vorlage kopiert
// wurde und nirgends stand, dass sie aufbereitet gehoert.
//
// Der Host steht bewusst NICHT hier drin (oeffentliches Repo) — die rohe Kopie holt man selbst:
//   . ./.env.deploy && scp "$DEPLOY_HOST:$DEPLOY_PATH/data/arbeitsdoku.db" /tmp/prodklon-echt.db
//   node scripts/prodklon-vorbereiten.js
//
// Es wird NUR in /tmp geschrieben. Die Produktivdatenbank wird nie angefasst.
const fs = require('fs');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

const ROH = process.argv[2] || '/tmp/prodklon-echt.db';
const ZIEL = process.argv[3] || '/tmp/prodklon.db';
const PW = 'test';

(async () => {
  if (!fs.existsSync(ROH)) {
    console.error(`Rohe Kopie ${ROH} fehlt. Zuerst per scp vom Produktivserver holen.`);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(ROH));
  const hash = bcrypt.hashSync(PW, 10);
  db.run('UPDATE users SET password_hash = ?', [hash]);

  // Zwei-Faktor leeren. Die Tests bauen ihren eigenen Authenticator auf und setzen einen
  // UNBELASTETEN Stand voraus ("nach dem Update ist niemand betroffen"). Seit auf Produktion
  // wirklich jemand 2FA eingerichtet hat, brachte eine rohe Kopie einen echten Eintrag mit —
  // `POST /2fa/setup` lieferte dann keinen Schluessel mehr und der Test starb an
  // "Leerer Base32-Schluessel". Das ist kein Fehler in der App, sondern eine unpassende Vorlage.
  let zwei = 0;
  for (const t of ['twofa_secrets', 'twofa_devices']) {
    try { zwei += db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0]; db.run(`DELETE FROM ${t}`); }
    catch (_) { /* Tabelle gibt es in sehr alten Staenden noch nicht */ }
  }
  const n = db.exec('SELECT COUNT(*) FROM users')[0].values[0][0];
  fs.writeFileSync(ZIEL, Buffer.from(db.export()));
  db.close();
  console.log(`${ZIEL} gebaut: ${n} Konten, Passwort ueberall "${PW}", ${zwei} Zwei-Faktor-Eintraege entfernt.`);
})();
