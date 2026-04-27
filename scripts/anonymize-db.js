const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

async function run() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data', 'local.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const hash = bcrypt.hashSync('test', 10);
  db.run('UPDATE users SET password_hash = ?, password_plain = ?', [hash, '']);

  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();
  console.log('Fertig. Alle Passwörter zurückgesetzt auf: "test"');
}

run().catch(err => { console.error(err); process.exit(1); });
