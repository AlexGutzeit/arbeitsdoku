// Die nächtliche Sicherung: verschlüsselt sie, und was packt sie ein?
//
// Anlass (Alex, 09.09.2026): „die .env Datei ist ja sehr wichtig. Wird die auch jede Nacht mit
// gespeichert? Sonst bringen mir die ganzen backups nicht so viel, oder?" — Sie wurde nicht, und
// die nächtliche Sicherung verschlüsselte auch dann nicht, wenn Schlüssel hinterlegt waren. Das
// galt nur für den Download aus der App.
//
// Die WICHTIGSTE Zusage hier ist die verneinende: **Ohne Empfänger darf die `.env` NICHT ins
// Archiv.** Ein Klartext-Zip mit TWOFA_KEY und den VAPID-Schlüsseln läge am Ende in 60 Versionen
// auf zwei Rechnern — das wäre schlimmer als gar keine Sicherung der Schlüssel.
//
//   node tests/backup-naechtlich.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');
const krypto = require('../backup-krypto');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const REPO = path.join(__dirname, '..');
const WURZEL = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-naechtlich-'));
const APP = path.join(WURZEL, 'app');
const AUS = path.join(WURZEL, 'sicherungen');

function aufbauen(empfaengerZeile) {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP, 'data'), { recursive: true });
  fs.mkdirSync(path.join(APP, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(APP, 'storage', 'documents'), { recursive: true });
  // node_modules und das Krypto-Modul aus dem Repo mitbenutzen statt zu kopieren.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(APP, 'node_modules'));
  fs.copyFileSync(path.join(REPO, 'backup-krypto.js'), path.join(APP, 'backup-krypto.js'));
  fs.writeFileSync(path.join(APP, '.env'),
    'TWOFA_KEY=' + 'a'.repeat(64) + '\nJWT_SECRET=geheim-und-lang-genug-fuer-den-test\n'
    + (empfaengerZeile ? empfaengerZeile + '\n' : ''));
  fs.writeFileSync(path.join(APP, 'uploads', 'logo.txt'), 'ein Logo');
  fs.writeFileSync(path.join(APP, 'storage', 'documents', 'zettel.txt'), 'ein Dokument');
  // Die Datenbank legt der Aufrufer an (sie braucht sql.js und damit await).
}

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbBauen = (zeilen) => {
    const db = new SQL.Database();
    db.run('CREATE TABLE backup_empfaenger (id INTEGER PRIMARY KEY, name TEXT, pubkey TEXT)');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.run("INSERT INTO users (name) VALUES ('Testmensch')");
    for (const z of (zeilen || [])) db.run('INSERT INTO backup_empfaenger (name, pubkey) VALUES (?, ?)', [z.name, z.pubkey]);
    const buf = Buffer.from(db.export()); db.close(); return buf;
  };

  const laufen = () => execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-backup.js'), AUS],
    { env: { ...process.env, ARBEITSDOKU_APP: APP }, encoding: 'utf8' });
  const dateien = () => fs.readdirSync(AUS).filter(f => /^arbeitsdoku_backup_/.test(f)).sort();

  try {
    // ── 1. Ohne Empfänger ─────────────────────────────────────────────────────────────────────
    console.log('── Ohne hinterlegten Schlüssel ──');
    fs.rmSync(AUS, { recursive: true, force: true });
    aufbauen(null);
    fs.writeFileSync(path.join(APP, 'data', 'arbeitsdoku.db'), dbBauen([]));
    const ausgabe1 = laufen();
    const d1 = dateien();
    ok('es entsteht genau eine Sicherung', d1.length === 1, JSON.stringify(d1));
    ok('… als Klartext-Zip', d1[0].endsWith('.zip'), d1[0]);
    ok('… und die Warnung sagt es deutlich', /UNVERSCHLÜSSELT/.test(ausgabe1), ausgabe1.slice(0, 200));
    const zip1 = new AdmZip(path.join(AUS, d1[0]));
    const namen1 = zip1.getEntries().map(e => e.entryName);
    ok('… die Datenbank ist drin', namen1.includes('arbeitsdoku.db'), JSON.stringify(namen1));
    ok('… Uploads und Dokumente auch',
      namen1.includes('uploads/logo.txt') && namen1.includes('documents/zettel.txt'), JSON.stringify(namen1));
    // DIE ZUSAGE, auf die es ankommt:
    ok('… und die .env ist NICHT dabei', !namen1.some(n => n.includes('.env')), JSON.stringify(namen1));

    // ── 2. Empfänger in der .env ──────────────────────────────────────────────────────────────
    console.log('\n── Schlüssel in der .env ──');
    const paar = krypto.paarErzeugen();
    fs.rmSync(AUS, { recursive: true, force: true });
    aufbauen('BACKUP_EMPFAENGER=offline:' + paar.oeffentlich);
    fs.writeFileSync(path.join(APP, 'data', 'arbeitsdoku.db'), dbBauen([]));
    const ausgabe2 = laufen();
    const d2 = dateien();
    ok('die Sicherung ist verschlüsselt', d2.length === 1 && d2[0].endsWith('.adbk'), JSON.stringify(d2));
    ok('… und nennt den Empfänger im Protokoll', /offline/.test(ausgabe2), ausgabe2.slice(0, 200));
    const roh2 = fs.readFileSync(path.join(AUS, d2[0]));
    ok('… es ist wirklich ein Container, kein Zip', krypto.istContainer(roh2) && roh2.slice(0, 5).toString() === 'ADBK1',
      JSON.stringify(roh2.slice(0, 6).toString()));
    const zip2 = new AdmZip(krypto.entschluesseln(roh2, paar.privat));
    const namen2 = zip2.getEntries().map(e => e.entryName);
    ok('… entschlüsselt liegt die Datenbank darin', namen2.includes('arbeitsdoku.db'), JSON.stringify(namen2));
    ok('… und JETZT ist die .env dabei', namen2.includes('.env'), JSON.stringify(namen2));
    ok('… mit dem echten Inhalt',
      /TWOFA_KEY=/.test(zip2.readAsText('.env')), zip2.readAsText('.env').slice(0, 40));

    // ── 3. Empfänger NUR in den Einstellungen ────────────────────────────────────────────────
    console.log('\n── Schlüssel nur in den Einstellungen (Datenbank) ──');
    const paar3 = krypto.paarErzeugen();
    fs.rmSync(AUS, { recursive: true, force: true });
    aufbauen(null);                                    // .env OHNE BACKUP_EMPFAENGER
    fs.writeFileSync(path.join(APP, 'data', 'arbeitsdoku.db'),
      dbBauen([{ name: 'minipc', pubkey: paar3.oeffentlich }]));
    laufen();
    const d3 = dateien();
    ok('auch das genügt zum Verschlüsseln', d3.length === 1 && d3[0].endsWith('.adbk'), JSON.stringify(d3));
    const zip3 = new AdmZip(krypto.entschluesseln(fs.readFileSync(path.join(AUS, d3[0])), paar3.privat));
    ok('… und die .env ist drin', zip3.getEntries().map(e => e.entryName).includes('.env'));

    // ── 4. Ein FREMDER Schlüssel darf nicht öffnen ───────────────────────────────────────────
    console.log('\n── Ein fremder Schlüssel ──');
    const fremd = krypto.paarErzeugen();
    let abgewiesen = false;
    try { krypto.entschluesseln(fs.readFileSync(path.join(AUS, d3[0])), fremd.privat); }
    catch (_) { abgewiesen = true; }
    ok('kann die Sicherung NICHT öffnen', abgewiesen === true);

    // ── 5. Aufbewahrung zählt beide Endungen ────────────────────────────────────────────────
    console.log('\n── Aufbewahrung ──');
    fs.rmSync(AUS, { recursive: true, force: true });
    fs.mkdirSync(AUS, { recursive: true });
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(AUS, `arbeitsdoku_backup_2026010${i}-000000.zip`), 'alt');
    process.env.BACKUP_KEEP = '2';
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-backup.js'), AUS],
      { env: { ...process.env, ARBEITSDOKU_APP: APP, BACKUP_KEEP: '2' }, encoding: 'utf8' });
    const d5 = dateien();
    ok('alte Zips werden mitgezählt und weggeräumt', d5.length === 2, JSON.stringify(d5));
    ok('… die neue verschlüsselte ist dabei', d5.some(f => f.endsWith('.adbk')), JSON.stringify(d5));
    // ── 6. Der Ausfall vom 10.09.2026: relativer DB_PATH, woanderses Arbeitsverzeichnis ─────────
    //
    // In der `.env` des Produktivservers steht `DB_PATH=./data/arbeitsdoku.db`. cron startet im
    // Heimatverzeichnis — dort gibt es kein `./data`, und zwei Sicherungen fielen wortlos aus
    // („DB fehlt: ./data/arbeitsdoku.db"). Die App merkte nichts, weil systemd sie im
    // App-Verzeichnis startet. Genau diese Kombination wird hier nachgestellt.
    console.log('\n── Relativer DB_PATH aus der .env, aufgerufen von woanders ──');
    fs.rmSync(AUS, { recursive: true, force: true });
    aufbauen(null);
    fs.appendFileSync(path.join(APP, '.env'), 'DB_PATH=./data/arbeitsdoku.db\n');
    fs.writeFileSync(path.join(APP, 'data', 'arbeitsdoku.db'), dbBauen([]));
    // Ein Verzeichnis, in dem es garantiert kein „./data" gibt — wie das Heimatverzeichnis bei cron.
    const woanders = path.join(WURZEL, 'woanders');
    fs.mkdirSync(woanders, { recursive: true });
    let ausgabe6 = '', fehler6 = null;
    try {
      ausgabe6 = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-backup.js'), AUS],
        { env: { ...process.env, ARBEITSDOKU_APP: APP }, cwd: woanders, encoding: 'utf8' });
    } catch (e) { fehler6 = (e.stderr || '') + (e.stdout || ''); }
    ok('die Sicherung läuft trotzdem durch', fehler6 === null, String(fehler6).slice(0, 200));
    ok('… und es liegt wirklich eine Datei da', dateien().length === 1, JSON.stringify(dateien()));
    ok('… und die Meldung bestätigt eine fertige Sicherung', /OK arbeitsdoku_backup_/.test(ausgabe6),
      ausgabe6.slice(0, 200));
    // Gegenprobe: Fehlt die DB WIRKLICH, muss die Meldung sagen, WO gesucht wurde — der alte Text
    // nannte nur „./data/arbeitsdoku.db" und verschwieg damit das Entscheidende.
    fs.unlinkSync(path.join(APP, 'data', 'arbeitsdoku.db'));
    let meldung = '';
    try {
      execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-backup.js'), AUS],
        { env: { ...process.env, ARBEITSDOKU_APP: APP }, cwd: woanders, encoding: 'utf8' });
    } catch (e) { meldung = (e.stderr || '') + (e.stdout || ''); }
    ok('fehlt die DB wirklich, nennt die Meldung den gesuchten Ort',
      /DB fehlt/.test(meldung) && meldung.includes(path.join(APP, 'data', 'arbeitsdoku.db')),
      meldung.slice(0, 200));

  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    fs.rmSync(WURZEL, { recursive: true, force: true });
  }

  console.log(`\nNächtliche Sicherung: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
