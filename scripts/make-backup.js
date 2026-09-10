#!/usr/bin/env node
// Nächtliche Sicherung der Arbeitsdoku — vom Zeitplan des Servers aufgerufen (4× täglich).
//
// WARUM DIESE DATEI IM REPO LIEGT: Sie lag bis 09.09.2026 NUR auf dem Server. Damit war sie
// unversioniert, ungeprüft und bei jedem Neuaufsetzen von Hand nachzubauen — für das Programm,
// das im Ernstfall alles retten soll, der falsche Ort.
//
// WAS SIE ANDERS MACHT ALS DIE ALTE FASSUNG:
//
//  1. Sie VERSCHLÜSSELT, sobald Empfänger hinterlegt sind — aus der `.env` (BACKUP_EMPFAENGER)
//     ODER aus den Einstellungen (Tabelle backup_empfaenger), genau wie der Download in der App.
//     Alex am 09.09.2026: „sobald in der .env ein schlüssel liegt oooooder in den einstellungen
//     bei backup, dann wird verschlüsselt." Genau so ist es jetzt — vorher galt das NUR für den
//     Download, die nächtliche Sicherung schrieb immer Klartext.
//
//  2. Sie legt die `.env` mit hinein — aber AUSSCHLIESSLICH in die verschlüsselte Fassung.
//     Ohne sie ist eine Sicherung nur die halbe Miete: Die Zwei-Faktor-Geheimnisse in der
//     Datenbank sind mit TWOFA_KEY verschlüsselt, die Push-Anmeldungen hängen an den
//     VAPID-Schlüsseln. Fehlt die `.env`, spielt man eine Datenbank zurück, aus der sich niemand
//     mehr anmelden kann und deren Push-Einträge nichts mehr taugen.
//
//     DIE REGEL DAZU IST HART: Ohne Empfänger wird die `.env` NICHT eingepackt. Lieber eine
//     Sicherung ohne Schlüssel als Schlüssel im Klartext — die Zips liegen am Ende in 60
//     Versionen auf zwei Rechnern.
//
//  3. Sie hält beide Dateiendungen sauber: `.zip` (Klartext) und `.adbk` (verschlüsselt) zählen
//     gemeinsam zur Aufbewahrungsgrenze, damit beim Umstellen nichts doppelt liegen bleibt.
//
// Aufruf:  node scripts/make-backup.js [ZIEL-VERZEICHNIS]
const fs = require('fs');
const path = require('path');

const APP = process.env.ARBEITSDOKU_APP || path.join(__dirname, '..');
require(path.join(APP, 'node_modules', 'dotenv')).config({ path: path.join(APP, '.env') });

const archiver = require(path.join(APP, 'node_modules', 'archiver'));
const krypto = require(path.join(APP, 'backup-krypto'));

// Pfade aus der `.env` sind RELATIV zur App, nicht zum Arbeitsverzeichnis.
//
// Am 10.09.2026 fielen zwei naechtliche Sicherungen aus: `DB_PATH=./data/arbeitsdoku.db` steht so
// in der `.env`, und cron startet im Heimatverzeichnis — dort gibt es kein `./data`. Die App
// selbst merkt davon nichts, weil systemd sie im App-Verzeichnis startet. Mein Handlauf am Abend
// zuvor lief aus demselben Grund durch: Ich stand zufaellig im richtigen Verzeichnis.
// Ein Sicherungsskript darf nicht davon abhaengen, WO es aufgerufen wird.
const ausApp = (wert, ...standard) =>
  wert ? (path.isAbsolute(wert) ? wert : path.resolve(APP, wert)) : path.join(APP, ...standard);

const DB_PATH = ausApp(process.env.DB_PATH, 'data', 'arbeitsdoku.db');
const ENV_PATH = path.join(APP, '.env');
// Beim Aufrufargument bleibt das Arbeitsverzeichnis massgeblich — das erwartet man auf der
// Kommandozeile. Nur der Wert aus der `.env` haengt an der App.
const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : (process.env.BACKUP_OUT ? path.resolve(APP, process.env.BACKUP_OUT)
                            : path.join(path.dirname(APP), 'arbeitsdoku-backups'));
const KEEP = Number(process.env.BACKUP_KEEP || 60);   // 4x taeglich -> 15 Tage

const teile = [
  { dir: path.join(APP, 'uploads'), name: 'uploads' },
  { dir: path.join(APP, 'storage', 'documents'), name: 'documents' },
  { dir: path.join(APP, 'storage', 'avatare'), name: 'avatare' },
];

function melde(text) { console.log(`[backup] ${new Date().toISOString()} ${text}`); }

/**
 * Empfänger aus BEIDEN Quellen — Umgebung und Einstellungen.
 *
 * Die Datenbank wird nur GELESEN, und zwar mit sql.js direkt aus der Datei. NICHT über
 * database/init.js: das startet einen Autosave-Takt, und ein zweiter Prozess auf derselben Datei
 * ist genau der Weg, auf dem man sich eine Sicherung zerschiesst, die man gerade erstellen will.
 */
async function empfaengerLesen() {
  let ausDb = [];
  try {
    const initSqlJs = require(path.join(APP, 'node_modules', 'sql.js'));
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));
    try {
      const res = db.exec(krypto.EMPFAENGER_SQL);
      const zeilen = res.length ? res[0].values.map(v => ({ name: v[0], pubkey: v[1] })) : [];
      ausDb = krypto.empfaengerAusZeilen(zeilen, (name, grund) =>
        console.error(`[backup] Empfänger „${name}" übersprungen — ${grund}`));
    } finally { db.close(); }
  } catch (e) {
    // Fehlt die Tabelle (sehr alter Stand), ist das kein Grund, die Sicherung ausfallen zu lassen.
    if (!/no such table/i.test(e.message)) console.error('[backup] Empfänger aus der DB nicht lesbar: ' + e.message);
  }
  let ausUmgebung = [];
  try { ausUmgebung = krypto.empfaengerAusUmgebung(); }
  catch (e) { console.error('[backup] BACKUP_EMPFAENGER unbrauchbar: ' + e.message); }
  return krypto.empfaengerZusammen(ausUmgebung, ausDb);
}

function dateienSammeln(archive, mitEnv) {
  archive.file(DB_PATH, { name: 'arbeitsdoku.db' });
  for (const { dir, name } of teile) lauf(archive, dir, name);
  if (mitEnv && fs.existsSync(ENV_PATH)) archive.file(ENV_PATH, { name: '.env' });
}

function lauf(archive, dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const eintrag of fs.readdirSync(dir)) {
    if (eintrag === 'tmp') continue;              // multer-Zwischenablage
    const voll = path.join(dir, eintrag);
    const rel = prefix + '/' + eintrag;
    try {
      const st = fs.statSync(voll);
      if (st.isFile()) archive.file(voll, { name: rel });
      else if (st.isDirectory()) lauf(archive, voll, rel);
    } catch (_) { /* verschwundene Datei waehrend des Laufs: ueberspringen */ }
  }
}

function altesEntfernen() {
  const muster = /^arbeitsdoku_backup_.*\.(zip|adbk)$/;
  const dateien = fs.readdirSync(OUT_DIR).filter(f => muster.test(f)).sort();
  for (const f of dateien.slice(0, Math.max(0, dateien.length - KEEP))) {
    try { fs.unlinkSync(path.join(OUT_DIR, f)); melde('alt entfernt: ' + f); } catch (_) {}
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    // Den GEMEINTEN Pfad mitschreiben, nicht den geschriebenen: „DB fehlt: ./data/arbeitsdoku.db"
    // sagt nicht, wo gesucht wurde, und genau daran lag es beim Ausfall am 10.09.2026.
    console.error(`[backup] DB fehlt: ${DB_PATH} (App ${APP}, DB_PATH=${process.env.DB_PATH || '—'})`);
    process.exit(1);
  }

  const empfaenger = await empfaengerLesen();
  const verschluesselt = empfaenger.length > 0;

  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const ts = `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
  const ziel = path.join(OUT_DIR, `arbeitsdoku_backup_${ts}.${verschluesselt ? 'adbk' : 'zip'}`);
  const tmp = ziel + '.part';

  if (!verschluesselt) {
    melde('WARNUNG: kein Empfänger hinterlegt — die Sicherung bleibt UNVERSCHLÜSSELT, und die '
        + '.env wird deshalb NICHT eingepackt. Schlüssel hinterlegen: Einstellungen → Backup, '
        + 'oder BACKUP_EMPFAENGER in der .env.');
  } else {
    melde('verschlüsselt für: ' + empfaenger.map(e => e.name).join(', '));
  }

  const ausgabe = fs.createWriteStream(tmp);
  const archive = archiver('zip', { zlib: { level: 9 } });
  let fehlgeschlagen = false;

  const abbruch = (was, err) => {
    if (fehlgeschlagen) return;
    fehlgeschlagen = true;
    console.error(`[backup] ${was}: ${err && err.message}`);
    try { fs.unlinkSync(tmp); } catch (_) {}
    process.exit(1);
  };
  archive.on('error', e => abbruch('Archiv-Fehler', e));
  ausgabe.on('error', e => abbruch('Schreibfehler', e));

  ausgabe.on('close', () => {
    if (fehlgeschlagen) return;
    fs.renameSync(tmp, ziel);      // erst nach vollstaendigem Schreiben sichtbar (atomar)
    melde(`OK ${path.basename(ziel)} (${fs.statSync(ziel).size} Bytes)`);
    altesEntfernen();
  });

  if (verschluesselt) {
    const chiffre = krypto.verschluesselnStream(empfaenger);
    chiffre.on('error', e => abbruch('Verschlüsselung', e));
    archive.pipe(chiffre).pipe(ausgabe);
  } else {
    archive.pipe(ausgabe);
  }

  dateienSammeln(archive, verschluesselt);
  archive.finalize();
})();
