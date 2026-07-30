#!/usr/bin/env node
// Erzeugt die vollständige Testliste in tests/README.md — zwischen den Markern.
//
// Warum erzeugt statt gepflegt: Die Liste war auf 9 von 143 Tests stehengeblieben, weil sie von
// Hand geführt wurde. Eine erzeugte Liste kann nicht veralten, und tests/testliste-vollstaendigkeit.js
// wird rot, sobald sie es doch tut.
//
// Die Beschreibung ist die erste Kommentarzeile des Tests. Wer einen neuen Test schreibt, gibt ihm
// also einfach eine ordentliche erste Zeile — mehr ist nicht zu tun.
//
//   node scripts/generate-test-index.js            schreibt die Liste
//   node scripts/generate-test-index.js --pruefen   meldet nur, ob sie aktuell ist
const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
const TESTS = path.join(WURZEL, 'tests');
const ZIEL = path.join(TESTS, 'README.md');
const START = '<!-- TESTLISTE:START — erzeugt von scripts/generate-test-index.js, nicht von Hand ändern -->';
const ENDE = '<!-- TESTLISTE:ENDE -->';

function beschreibung(datei) {
  const zeilen = fs.readFileSync(path.join(TESTS, datei), 'utf8').split('\n');
  for (const z of zeilen.slice(0, 40)) {
    const t = z.trim();
    if (!t) continue;
    if (!t.startsWith('//')) break;                 // Code beginnt → keine Kopfzeile vorhanden
    const text = t.replace(/^\/\/\s?/, '').trim();
    if (text) return text.replace(/\|/g, '\\|');
  }
  return '(keine Beschreibung in der ersten Kommentarzeile)';
}

function baueListe() {
  const dateien = fs.readdirSync(TESTS).filter(f => f.endsWith('.js')).sort();
  const zeilen = dateien.map(f => `| \`${f}\` | ${beschreibung(f)} |`);
  return [
    START,
    '',
    `**${dateien.length} Tests.** Die Beschreibung ist jeweils die erste Kommentarzeile der Datei.`,
    '',
    '| Test | prüft |',
    '|---|---|',
    ...zeilen,
    '',
    ENDE,
  ].join('\n');
}

const inhalt = fs.readFileSync(ZIEL, 'utf8');
const i = inhalt.indexOf(START), j = inhalt.indexOf(ENDE);
if (i === -1 || j === -1) {
  console.error(`Marker fehlen in ${ZIEL}. Erwartet:\n${START}\n${ENDE}`);
  process.exit(2);
}
const neu = inhalt.slice(0, i) + baueListe() + inhalt.slice(j + ENDE.length);

if (process.argv.includes('--pruefen')) {
  if (neu === inhalt) { console.log('Testliste ist aktuell.'); process.exit(0); }
  console.error('Testliste in tests/README.md ist NICHT aktuell.');
  console.error('Bitte einmal ausführen:  node scripts/generate-test-index.js');
  process.exit(1);
}
fs.writeFileSync(ZIEL, neu);
console.log('Testliste geschrieben:', ZIEL);
