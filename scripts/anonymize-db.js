const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

async function run() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data', 'local.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const hash = bcrypt.hashSync('test', 10);
  db.run('UPDATE users SET password_hash = ?', [hash]);

  // Zwei-Faktor aus dem Klon entfernen. Zwei Gruende, beide wichtig:
  //   1. Die Geheimnisse sind mit TWOFA_KEY des Servers verschluesselt. Ein Klon hat den Wert
  //      nicht — wer 2FA aktiviert hat, kaeme hier NIE hinein, auch nicht mit dem richtigen
  //      Authenticator. Genau das legte am 24.08.2026 tests/browser-smoke.js lahm.
  //   2. Echte TOTP-Geheimnisse haben in einer Kopie nichts verloren, die zum Testen herumliegt.
  const tabellen = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const vorhanden = new Set(tabellen[0] ? tabellen[0].values.map(v => v[0]) : []);
  for (const t of ['twofa_secrets', 'twofa_devices']) {
    if (vorhanden.has(t)) db.run(`DELETE FROM ${t}`);   // Tabellen fehlen in aelteren Staenden
  }
  if (vorhanden.has('settings')) {
    db.run("DELETE FROM settings WHERE key IN ('twofa_admin','twofa_chef','twofa_buchhalter','twofa_mitarbeiter')");
  }

  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();
  console.log('Fertig. Alle Passwörter zurückgesetzt auf: "test"; Zwei-Faktor im Klon entfernt.');
}

run().catch(err => { console.error(err); process.exit(1); });
