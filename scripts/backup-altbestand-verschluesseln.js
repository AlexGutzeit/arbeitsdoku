#!/usr/bin/env node
// Verschlüsselt Sicherungen, die noch im Klartext herumliegen — die einmalige Umstellung.
//
//   node scripts/backup-altbestand-verschluesseln.js ~/arbeitsdoku-backups [--trocken]
//
// Die Reihenfolge ist der ganze Punkt dieses Skripts:
//   1. verschlüsseln,
//   2. sofort wieder entschlüsseln und Byte für Byte mit dem Original vergleichen,
//   3. ERST DANN das Klartext-Zip löschen.
// Ein Fehler im Format wäre sonst der Totalverlust der gesamten Historie, und zwar unbemerkt,
// weil niemand ein Backup öffnet, solange nichts kaputt ist.
//
// Ohne BACKUP_SCHLUESSEL kann Schritt 2 nicht laufen. Dann wird verschlüsselt, aber NICHTS
// gelöscht — auf einem Server, der absichtlich keinen privaten Schlüssel hat, ist das der
// richtige Ausgang.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { empfaengerAusUmgebung, verschluesselnStream, entschluesseln } = require('../backup-krypto');

async function eineDatei(zipPfad, empfaenger, schluessel, trocken) {
  const zielPfad = zipPfad.replace(/\.zip$/i, '.adbk');
  if (fs.existsSync(zielPfad)) return { zustand: 'schon-da', datei: path.basename(zipPfad) };
  if (trocken) return { zustand: 'waere', datei: path.basename(zipPfad) };

  // Erst in eine Teil-Datei schreiben. Bricht der Lauf mittendrin ab (Strom, Platte voll),
  // liegt danach kein halbes .adbk herum, das beim nächsten Mal als „schon erledigt" gilt.
  const teilPfad = zielPfad + '.teil';
  try {
    await pipeline(fs.createReadStream(zipPfad), verschluesselnStream(empfaenger), fs.createWriteStream(teilPfad));
  } catch (e) {
    fs.rmSync(teilPfad, { force: true });
    return { zustand: 'fehler', datei: path.basename(zipPfad), grund: e.message };
  }

  if (schluessel) {
    const urspruenglich = fs.readFileSync(zipPfad);
    let zurueck;
    try { zurueck = entschluesseln(fs.readFileSync(teilPfad), schluessel); }
    catch (e) {
      fs.rmSync(teilPfad, { force: true });
      return { zustand: 'fehler', datei: path.basename(zipPfad), grund: 'Rückweg scheitert: ' + e.message };
    }
    if (!zurueck.equals(urspruenglich)) {
      fs.rmSync(teilPfad, { force: true });
      return { zustand: 'fehler', datei: path.basename(zipPfad), grund: 'Rückweg liefert andere Bytes' };
    }
  }

  const alt = fs.statSync(zipPfad);
  fs.renameSync(teilPfad, zielPfad);
  fs.chmodSync(zielPfad, 0o600);
  fs.utimesSync(zielPfad, alt.atime, alt.mtime);   // Alter bleibt — die Rotation geht danach

  if (!schluessel) return { zustand: 'ungeprueft', datei: path.basename(zipPfad) };
  fs.rmSync(zipPfad);
  return { zustand: 'fertig', datei: path.basename(zipPfad) };
}

async function umstellen(verzeichnis, optionen = {}) {
  const trocken = !!optionen.trocken;
  const empfaenger = optionen.empfaenger || empfaengerAusUmgebung();
  if (!empfaenger.length) throw new Error('BACKUP_EMPFAENGER ist nicht gesetzt — ohne Empfänger gibt es nichts zu verschlüsseln.');
  if (!fs.existsSync(verzeichnis)) throw new Error(`Verzeichnis nicht gefunden: ${verzeichnis}`);

  const schluessel = (optionen.schluessel !== undefined ? optionen.schluessel : process.env.BACKUP_SCHLUESSEL || '').trim();
  const zips = fs.readdirSync(verzeichnis).filter(n => /\.zip$/i.test(n)).sort();

  const ergebnisse = [];
  for (const name of zips) ergebnisse.push(await eineDatei(path.join(verzeichnis, name), empfaenger, schluessel, trocken));
  return { geprueft: !!schluessel, empfaenger: empfaenger.map(e => e.name), ergebnisse };
}

module.exports = { umstellen };

if (require.main === module) {
  const argumente = process.argv.slice(2);
  const trocken = argumente.includes('--trocken');
  const verzeichnis = argumente.find(a => !a.startsWith('--'));
  if (!verzeichnis) {
    console.error('Kein Verzeichnis angegeben.\n\n  node scripts/backup-altbestand-verschluesseln.js <verzeichnis> [--trocken]');
    process.exit(1);
  }
  umstellen(verzeichnis, { trocken }).then(({ geprueft, empfaenger, ergebnisse }) => {
    const zaehl = (z) => ergebnisse.filter(e => e.zustand === z).length;
    for (const e of ergebnisse.filter(e => e.zustand === 'fehler')) console.error(`  ✗ ${e.datei}: ${e.grund}`);
    console.log(`\nEmpfänger: ${empfaenger.join(', ')}`);
    if (trocken) {
      console.log(`Probelauf: ${zaehl('waere')} Datei(en) würden verschlüsselt, ${zaehl('schon-da')} sind es schon.`);
    } else if (geprueft) {
      console.log(`${zaehl('fertig')} verschlüsselt und geprüft, Klartext gelöscht.`);
    } else {
      console.log(`${zaehl('ungeprueft')} verschlüsselt. BACKUP_SCHLUESSEL fehlt — der Rückweg wurde NICHT`);
      console.log('geprüft, deshalb liegen die Klartext-Zips noch da. Erst nach einer Prüfung löschen.');
    }
    if (zaehl('schon-da')) console.log(`${zaehl('schon-da')} übersprungen (.adbk lag schon daneben).`);
    if (zaehl('fehler')) { console.log(`${zaehl('fehler')} FEHLGESCHLAGEN — deren Klartext-Zips liegen unangetastet da.`); process.exit(1); }
  }).catch(e => { console.error('Fehler: ' + e.message); process.exit(1); });
}
