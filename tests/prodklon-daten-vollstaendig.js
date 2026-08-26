// Übersteht der echte Datenbestand das Update unverändert? (Alex, 23.08.2026)
//
// Diese Runde bringt fünf neue Tabellen mit (Zwei-Faktor, Profilbilder, Geburtstags-Freigabe,
// Sitzungszähler). Migrationen sind die Stelle, an der still etwas verschwinden kann — und bei
// dieser App laufen sie bei JEDEM Start. Ein Fehler dort fällt niemandem auf, bis jemand einen
// alten Monat sucht.
//
// Der Test muss mit dem Bestand mitaltern: Sobald die Runde produktiv ist, stehen in ihren
// Tabellen echte Zeilen. Deshalb wird nicht „leer" verlangt, sondern das, worum es geht — die
// Migration darf nichts erfinden und nichts anfassen, was schon da war.
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

// Eine Tabelle nur ueber die ALTEN Spalten hashen. Wird eine Spalte ergaenzt, aendert sich die
// Gesamtsumme zwangslaeufig — und ohne diesen Blick waere danach ueberhaupt nicht mehr geprueft,
// ob die bestehenden Werte die Migration heil ueberstanden haben. Genau darum geht es aber.
async function summeUeberSpalten(datei, tabelle, spalten) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(datei));
  const liste = spalten.map(c => `"${c}"`).join(', ');
  const r = db.exec(`SELECT ${liste} FROM "${tabelle}"`);
  const zeilen = r.length ? r[0].values.map(z => JSON.stringify(z)).sort().join('\n') : '';
  db.close();
  return crypto.createHash('sha256').update(zeilen).digest('hex').slice(0, 16);
}

// Was diese Runde ABSICHTLICH mitbringt. Waechst mit jeder Runde — steht hier, damit „nichts ist
// dazugekommen" eine echte Aussage bleibt und nicht mit der Zeit aufgeweicht wird.
const ERLAUBT_NEUE_TABELLEN = [
  'twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe',  // 23.08.2026
  'backup_empfaenger',                                                                      // 25.08.2026
  'warnung_prefs',                                                                          // 26.08.2026
];
const ERLAUBT_NEUE_SPALTEN = {
  users: ['can_order'],   // 25.08.2026, Bestellrecht
};

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
  const weg = [], veraendert = [], spalten = [], neu = [], ergaenzt = [];
  for (const [t, a] of Object.entries(vorher)) {
    const b = nachher[t];
    if (!b) { weg.push(`${t} (hatte ${a.anzahl} Zeilen)`); continue; }
    if (a.summe === b.summe) continue;
    if (a.spalten !== b.spalten) {
      const alt = a.spalten.split(','), jetzt = b.spalten.split(',');
      const dazu = jetzt.filter(x => !alt.includes(x));
      const fort = alt.filter(x => !jetzt.includes(x));
      const erlaubt = ERLAUBT_NEUE_SPALTEN[t] || [];
      // Nur erwartete Ergaenzungen und nichts verschwunden? Dann NICHT durchwinken, sondern
      // nachmessen: Die alten Spalten muessen Wert fuer Wert dieselben geblieben sein.
      if (!fort.length && dazu.every(c => erlaubt.includes(c))) {
        ergaenzt.push({ tabelle: t, dazu, alteSpalten: alt });
      } else {
        spalten.push(`${t} [+${dazu.join('/')}] [-${fort.join('/')}]`);
      }
    } else veraendert.push(`${t} (${a.anzahl} → ${b.anzahl})`);
  }
  for (const t of Object.keys(nachher)) if (!(t in vorher)) neu.push(t);

  ok('KEINE Tabelle ist verschwunden', weg.length === 0, weg.join(', '));
  ok('KEINE Spalte ist verschwunden oder dazugekommen', spalten.length === 0, spalten.join(' | '));
  ok('KEINE Zeile hat sich veraendert', veraendert.length === 0, veraendert.join(', '));
  const unveraendert = Object.keys(vorher).filter(t => !ergaenzt.some(e => e.tabelle === t));
  ok('alle unveraenderten Tabellen sind Zeichen fuer Zeichen dieselben',
    unveraendert.every(t => nachher[t] && nachher[t].summe === vorher[t].summe),
    `${unveraendert.filter(t => !nachher[t] || nachher[t].summe !== vorher[t].summe).join(', ')}`);

  // Die Tabellen, die eine erwartete Spalte bekommen haben: alte Werte nachmessen.
  for (const e of ergaenzt) {
    const vorSumme = await summeUeberSpalten(QUELLE, e.tabelle, e.alteSpalten);
    const nachSumme = await summeUeberSpalten(DB, e.tabelle, e.alteSpalten);
    ok(`${e.tabelle}: Spalte +${e.dazu.join('/')} kam dazu, die alten Werte sind unveraendert`,
      vorSumme === nachSumme, `${vorSumme} → ${nachSumme}`);
  }

  console.log('\n── Die Tabellen dieser Runde ──');
  const RUNDE = ['twofa_secrets', 'twofa_devices', 'user_avatars', 'user_sitzung', 'geburtstag_freigabe'];
  for (const t of RUNDE) ok(`${t} vorhanden`, !!nachher[t], 'fehlt');

  // Ab dem Tag, an dem die Runde produktiv ist, stehen in diesen Tabellen echte Zeilen — am
  // 24.08.2026 zum ersten Mal (ein Profilbild, eine Geburtstags-Freigabe). „Muss leer sein" waere
  // dann schlicht falsch. Geprueft gehoert, was wirklich zaehlt: Die MIGRATION darf nichts
  // erfinden. Also leer nur, was sie gerade erst angelegt hat; alles, was schon im Bestand war,
  // muss Zeichen fuer Zeichen so bleiben.
  // Ueber ALLE neu entstandenen Tabellen, nicht nur ueber die einer bestimmten Runde: Sonst waere
  // eine spaeter dazugekommene Tabelle zwar erlaubt, aber nie darauf geprueft, ob die Migration sie
  // auch FUELLT. Genau das war am 26.08.2026 bei warnung_prefs der Fall.
  const neuAngelegt = [...new Set([...RUNDE.filter(t => !vorher[t]), ...neu])];
  const schonDa = RUNDE.filter(t => vorher[t]);
  console.log(`     (neu angelegt: ${neuAngelegt.join(', ') || 'keine'} · schon im Bestand: ${schonDa.join(', ') || 'keine'})`);

  if (neuAngelegt.length) {
    ok(`die NEU angelegten sind leer (${neuAngelegt.join(', ')})`,
      neuAngelegt.every(t => !nachher[t] || nachher[t].anzahl === 0),
      JSON.stringify(neuAngelegt.map(t => t + '=' + (nachher[t] ? nachher[t].anzahl : '?'))));
  }
  if (schonDa.length) {
    ok('die schon vorhandenen sind unveraendert (das Update fasst sie nicht an)',
      schonDa.every(t => nachher[t] && nachher[t].summe === vorher[t].summe),
      JSON.stringify(schonDa.map(t => t + ': ' + (vorher[t] ? vorher[t].anzahl : '?') + ' → ' + (nachher[t] ? nachher[t].anzahl : '?'))));
  }
  ok('sonst ist nichts dazugekommen', neu.every(t => ERLAUBT_NEUE_TABELLEN.includes(t)), neu.join(', '));

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
