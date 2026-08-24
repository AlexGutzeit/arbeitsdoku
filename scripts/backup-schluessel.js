#!/usr/bin/env node
// Erzeugt ein Schlüsselpaar für verschlüsselte Sicherungen.
//
//   node scripts/backup-schluessel.js minipc
//
// Der ÖFFENTLICHE Teil kommt in die .env der Server (BACKUP_EMPFAENGER). Der PRIVATE Teil wird
// hier EINMAL angezeigt und nirgends gespeichert — wer ihn verliert, kann die damit gesicherten
// Daten nie wieder lesen.
const { paarErzeugen } = require('../backup-krypto');

const name = (process.argv[2] || 'schluessel').replace(/[^a-zA-Z0-9_-]/g, '');
const p = paarErzeugen();

console.log(`
════════════════════════════════════════════════════════════════════════════
  Schlüsselpaar „${name}"
════════════════════════════════════════════════════════════════════════════

ÖFFENTLICH — kommt auf die Server, darf jeder sehen.
In die .env, bei mehreren Empfängern mit Komma getrennt:

BACKUP_EMPFAENGER=${name}:${p.oeffentlich}

────────────────────────────────────────────────────────────────────────────

PRIVAT — wird JETZT gesichert und danach nie wieder angezeigt.
Ohne ihn sind alle damit verschlüsselten Sicherungen für immer verloren.

${p.privat}

  → in die Passwortverwaltung, UND an einen zweiten Ort (USB-Stick, Ausdruck).
  → gehört NICHT auf den Server, der nur verschlüsseln können soll.
  → die Zweitanlage braucht ihren eigenen als BACKUP_SCHLUESSEL in der .env,
    damit die Notfall-Umschaltung ohne Menschen läuft.

════════════════════════════════════════════════════════════════════════════
`);
