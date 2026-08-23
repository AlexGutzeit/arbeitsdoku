// Übersteht der echte Datenbestand das Update unverändert? (Alex, 23.08.2026)
//
// Diese Runde bringt fünf neue Tabellen mit (Zwei-Faktor, Profilbilder, Geburtstags-Freigabe,
// Sitzungszähler). Migrationen sind die Stelle, an der still etwas verschwinden kann — und bei
// dieser App laufen sie bei JEDEM Start. Ein Fehler dort fällt niemandem auf, bis jemand einen
// alten Monat sucht.
//
// Deshalb wird hier nicht die Anzahl der Zeilen geglaubt, sondern der INHALT verglichen: Für jede
// Tabelle die Spaltenliste plus alle Zeilen, sortiert und gehasht. Vorher/nachher muss jede
// bestehende Tabelle Zeichen für Zeichen dieselbe sein; dazukommen dürfen nur die neuen.
//
// Gelesen wird die Datei direkt (sql.js), NICHT über database/init.js — das hat einen eigenen
// Autosave-Takt und würde die Datei, die gerade geprüft wird, überschreiben.
//
//   node tests/prodklon-daten-vollstaendig.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3280, DB = '/tmp/prodklon-vollstaendig.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m }, x => {
      let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s }));
    });
    r.on('error', rej); r.end();
  });
}
// Spaltenliste + alle Zeilen je Tabelle, sortiert und gehasht.
async function aufnehmen(datei) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(datei));
  const t = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const raus = {};
  if (t.length) for (const [name] of t[0].values) {
    const spalten = db.exec(`PRAGMA table_info("${name}")`)[0].values.map(r => r[1]).join(',');
    const r = db.exec(`SELECT * FROM "${name}"`);
    const zeilen = r.length ? r[0].values.map(z => JSON.stringify(z)).sort().join('\n') : '';
    raus[name] = {
      spalten, anzahl: r.length ? r[0].values.length : 0,
      summe: crypto.createHash('sha256').update(spalten + '\n' + zeilen).digest('hex').slice(0, 16),
    };
  }
  db.close();
  return raus;
}

(async () => {
  if (!fs.existsSync(QUELLE)) {
    console.log(`Prod-Klon ${QUELLE} fehlt — Test uebersprungen.`);
    process.exit(0);
  }
  try { fs.unlinkSync(DB); } catch (_) {}
  fs.copyFileSync(QUELLE, DB);                 // ab hier nur die Kopie
  const vorher = await aufnehmen(DB);

  console.log('── Der Bestand vor dem Start ──');
  const gefuellt = Object.entries(vorher).filter(([, v]) => v.anzahl > 0);
  ok('der Klon enthaelt ueberhaupt Daten', gefuellt.length >= 10, `${gefuellt.length} gefuellte Tabellen`);
  const nutzer = vorher.users ? vorher.users.anzahl : 0;
  ok('… darunter echte Nutzer', nutzer >= 5, String(nutzer));
  console.log(`     (${Object.keys(vorher).length} Tabellen, ${gefuellt.length} davon gefuellt, ${nutzer} Nutzer)`);

  console.log('\n── Server starten: dabei laufen alle Migrationen ──');
  const logDatei = '/tmp/prodklon-vollstaendig-srv.log';
  const lg = fs.openSync(logDatei, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let hoch = false;
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) { hoch = true; break; } } catch (_) {} await sleep(200); }
  ok('der Server kommt mit dem Altbestand hoch', hoch);
  await sleep(8000);                            // Autosave-Takt abwarten
  srv.kill('SIGTERM'); await sleep(1500);

  const protokoll = fs.readFileSync(logDatei, 'utf8');
  const boese = protokoll.split('\n').filter(z => /error|exception|fehlgeschlagen|SQLITE_/i.test(z) && !/bereinigt/i.test(z));
  ok('kein Fehler beim Hochziehen', boese.length === 0, boese.slice(0, 3).join(' | '));

  console.log('\n── Und jetzt Zeile fuer Zeile vergleichen ──');
  const nachher = await aufnehmen(DB);
  const weg = [], veraendert = [], spalten = [], neu = [];
  for (const [t, a] of Object.entries(vorher)) {
    const b = nachher[t];
    if (!b) { weg.push(`${t} (hatte ${a.anzahl} Zeilen)`); continue; }
    if (a.summe === b.summe) continue;
    if (a.spalten !== b.spalten) {
      const alt = a.spalten.split(','), jetzt = b.spalten.split(',');
      spalten.push(`${t} [+${jetzt.filter(x => !alt.includes(x)).join('/')}] [-${alt.filter(x => !jetzt.includes(x)).join('/')}]`);
    } else veraendert.push(`${t} (${a.anzahl} → ${b.anzahl})`);
  }
  for (const t of Object.keys(nachher)) if (!(t in vorher)) neu.push(t);

  ok('KEINE Tabelle ist verschwunden', weg.length === 0, weg.join(', '));
  ok('KEINE Spalte ist verschwunden oder dazugekommen', spalten.length === 0, spalten.join(' | '));
  ok('KEINE Zeile hat sich veraendert', veraendert.length === 0, veraendert.join(', '));
  ok('alle bestehenden Tabellen sind Zeichen fuer Zeichen dieselben',
    Object.keys(vorher).every(t => nachher[t] && nachher[t].summe === vorher[t].summe),
    `${Object.keys(vorher).filter(t => !nachher[t] || nachher[t].summe !== vorher[t].summe).join(', ')}`);

  console.log('\n── Die neuen Tabellen sind entstanden ──');
  for (const t of ['twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe']) {
    ok(`${t} angelegt`, !!nachher[t], 'fehlt');
  }
  ok('… und sie sind leer (niemand ist ploetzlich eingerichtet)',
    ['twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe']
      .every(t => !nachher[t] || nachher[t].anzahl === 0),
    JSON.stringify(['twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe']
      .map(t => t + '=' + (nachher[t] ? nachher[t].anzahl : '?'))));
  ok('sonst ist nichts dazugekommen',
    neu.every(t => ['twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe'].includes(t)),
    neu.join(', '));

  // Gegenprobe zur Messung selbst: Waere sie blind, meldete sie auch bei echtem Verlust nichts.
  console.log('\n── Gegenprobe: erkennt die Messung ueberhaupt einen Verlust? ──');
  const probe = JSON.parse(JSON.stringify(nachher));
  delete probe.users;
  const merktEs = !Object.keys(vorher).every(t => probe[t] && probe[t].summe === vorher[t].summe);
  ok('eine fehlende Tabelle wuerde auffallen', merktEs);

  try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nProd-Klon vollstaendig: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
