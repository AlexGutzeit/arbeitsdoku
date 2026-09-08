// Ein sehr altes Backup einspielen — und trotzdem hineinkommen.
//
// Der gefährlichste Fehler dieser App ist nicht eine kaputte Anzeige, sondern eine Anmeldung, die
// niemanden mehr durchlässt: middleware/auth.js liest bei JEDER Anfrage eine feste Spaltenliste aus
// `users`. Fehlt eine davon nach dem Wiederherstellen eines alten Standes, antwortet der Server auf
// alles mit „no such column" — auch dem Admin. Es gäbe keinen Weg zurück ausser über die Konsole.
//
// Deshalb prüft dieser Test nicht eine einzelne Spalte, sondern die REGEL: Was die Middleware liest,
// muss der Restore-Pfad nachziehen. Die Liste wird aus middleware/auth.js HERAUSGELESEN, nicht
// abgeschrieben — sonst wäre der Test beim nächsten neuen Recht still veraltet.
//
// Anlass: can_products (Recht „Lagerdaten pflegen", 08.09.2026). Der Test gilt aber für jedes
// weitere Recht, das noch kommt.
//
//   node tests/altdb-spalten.js
const fs = require('fs');

process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
process.env.DB_PATH = '/tmp/altdb-spalten-neu.db';
const ALT = '/tmp/altdb-spalten-alt.db';
for (const f of [process.env.DB_PATH, ALT]) { try { fs.unlinkSync(f); } catch (_) {} }

const dbModul = require('../database/init');
const { initDatabase, reloadFromFile, getDb } = dbModul;

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// Die Spaltenliste, die die Middleware wirklich benutzt — aus dem Quelltext gezogen.
function spaltenDerMiddleware() {
  const src = fs.readFileSync(__dirname + '/../middleware/auth.js', 'utf8');
  // In auth.js stehen MEHRERE solche Abfragen — die erste holt nur `username`. Genau daran ist
  // dieser Test beim ersten Lauf vorbeigelaufen und war gruen, ohne etwas zu pruefen. Es zaehlt
  // die LAENGSTE: die, an der die Anmeldung haengt.
  const alle = [...src.matchAll(/SELECT ([^"'`]*?) FROM users WHERE id = \?/g)].map(x => x[1]);
  if (!alle.length) throw new Error('SELECT in middleware/auth.js nicht gefunden — Test anpassen!');
  const laengste = alle.sort((a, b) => b.split(',').length - a.split(',').length)[0];
  if (laengste.split(',').length < 5) throw new Error('Nur ' + laengste.split(',').length + ' Spalten gefunden — Muster passt nicht mehr!');
  return laengste.split(',').map(s => s.trim())
    .map(s => s.replace(/^COALESCE\(([a-z_]+).*$/i, '$1'))   // COALESCE(active,1) AS active
    .map(s => s.split(/\s+AS\s+/i)[0].trim())
    .filter(s => /^[a-z_]+$/.test(s));
}

(async () => {
  await initDatabase();

  const SQL = dbModul.SQL;
  // Ein Stand von damals: users kennt nur das Nötigste, KEINES der später ergänzten Rechte.
  const alt = new SQL.Database();
  alt.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','chef','buchhalter','mitarbeiter'))
    );
    INSERT INTO users (username, password_hash, name, role) VALUES ('admin', 'x', 'Admin', 'admin');
  `);
  fs.writeFileSync(ALT, Buffer.from(alt.export()));
  alt.close();

  const erwartet = spaltenDerMiddleware();
  console.log(`── Alter Stand mit ${5} Spalten, die Middleware liest ${erwartet.length} ──`);

  reloadFromFile(ALT);
  const db = getDb();

  const daNach = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const fehlend = erwartet.filter(c => !daNach.includes(c));
  ok('der Restore-Pfad zieht jede Spalte nach, die die Middleware liest',
    fehlend.length === 0, 'fehlt: ' + fehlend.join(', '));

  // Die Gegenprobe zur Gegenprobe: die Abfrage im Original ausfuehren. Eine Spalte kann da sein und
  // die Abfrage trotzdem scheitern (Tippfehler, Alias, Klammer).
  let gelesen = null, fehler = null;
  try {
    gelesen = db.prepare(`SELECT ${erwartet.join(', ')} FROM users WHERE id = ?`).get(1);
  } catch (e) { fehler = e.message; }
  ok('die Abfrage der Middleware läuft auf dem alten Stand', !!gelesen && !fehler, fehler || 'kein Treffer');

  // Und die Rechte stehen auf „nein" statt auf undefiniert — sonst waere `!!undefined` zwar auch
  // falsch, aber ein spaeteres `=== 0` still nicht mehr.
  ok('can_products steht auf 0, nicht auf NULL',
    gelesen && Number(gelesen.can_products) === 0, JSON.stringify(gelesen));
  ok('can_order ebenso', gelesen && Number(gelesen.can_order) === 0, JSON.stringify(gelesen));

  console.log(`\nAlter Stand: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
