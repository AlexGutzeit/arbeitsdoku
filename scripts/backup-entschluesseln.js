#!/usr/bin/env node
// Entschlüsselt eine Sicherung auf der Kommandozeile — für Skripte, nicht für Menschen.
//
//   node scripts/backup-entschluesseln.js sicherung.adbk [ziel.zip]
//
// Menschen nehmen „Einstellungen → Backup" in der App oder das Hilfsprogramm
// werkzeuge/sicherung-entschluesseln.html. Dieses Skript ist der Weg für
// notfall-umschalten.sh auf dem Mini-PC, wo niemand etwas eintippen kann.
//
// Der Schlüssel kommt aus BACKUP_SCHLUESSEL (Umgebung oder .env) und wird bewusst NICHT als
// Aufrufparameter genommen: Parameter stehen in der Prozessliste und in der Shell-Historie.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { entschluesseln, istContainer, empfaengerNamen } = require('../backup-krypto');

function abbruch(text) {
  console.error('Fehler: ' + text);
  process.exit(1);
}

const quelle = process.argv[2];
if (!quelle) abbruch('Keine Datei angegeben.\n\n  node scripts/backup-entschluesseln.js sicherung.adbk [ziel.zip]');
if (!fs.existsSync(quelle)) abbruch(`Datei nicht gefunden: ${quelle}`);

const daten = fs.readFileSync(quelle);

// Eine Klartext-Sicherung durchzureichen ist kein Fehler, sondern der Altbestand: das Skript soll
// auch dann laufen, wenn im Verzeichnis noch unverschlüsselte Zips liegen.
if (!istContainer(daten)) {
  const ziel = process.argv[3];
  if (ziel && path.resolve(ziel) !== path.resolve(quelle)) fs.writeFileSync(ziel, daten);
  console.error(`Hinweis: ${path.basename(quelle)} ist nicht verschlüsselt — unverändert übernommen.`);
  process.exit(0);
}

const schluessel = (process.env.BACKUP_SCHLUESSEL || '').trim();
if (!schluessel) {
  abbruch('BACKUP_SCHLUESSEL ist nicht gesetzt.\n\n'
    + `  ${path.basename(quelle)} ist verschlüsselt; öffnen können sie: ${empfaengerNamen(daten).join(', ') || 'unbekannt'}.\n`
    + '  Den privaten Schlüssel in die .env dieser Maschine eintragen (BACKUP_SCHLUESSEL=…)\n'
    + '  oder die Datei am eigenen Rechner mit werkzeuge/sicherung-entschluesseln.html öffnen.');
}

let zip;
try { zip = entschluesseln(daten, schluessel); }
catch (e) { abbruch(e.message); }

const ziel = process.argv[3] || quelle.replace(/\.adbk$/i, '') + (/\.adbk$/i.test(quelle) ? '' : '.zip');
fs.writeFileSync(ziel, zip);
fs.chmodSync(ziel, 0o600);
console.error(`${path.basename(quelle)} → ${path.basename(ziel)} (${(zip.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(ziel);   // auf stdout NUR der Pfad, damit ZIEL=$(node …) im Shell-Skript funktioniert
