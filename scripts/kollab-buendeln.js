#!/usr/bin/env node
// Baut das Bündel für die gemeinsamen Notizen: public/vendor/kollab.min.js + kollab.css + kollab-LIZENZEN.txt
//
// Warum ein Bündel: Die App lädt nur eigene Skript-Dateien (CSP `script-src 'self'`) und hat keinen
// Build-Schritt. Yjs, Quill und ihre Anbindungen sind ES-Module mit vielen Einzeldateien — esbuild
// fasst sie zu EINER klassischen Datei zusammen, die `window.Kollab` bereitstellt. Das Ergebnis
// wird eingecheckt wie `zxing.min.js`; der Server braucht zur Laufzeit nichts davon zu bauen.
//
// Versionen: Sie stehen FEST in package.json (ohne ^). Dieselben Paketfassungen liefen am 26.09.2026
// bei Alex auf dem Handy (Probe: Tippen, Checklisten, fremde Einfügungen in der eigenen Zeile).
// yjs ist zusätzlich eine Laufzeit-Abhängigkeit des Servers — Browser und Server rechnen mit
// derselben Fassung.
//
//   node scripts/kollab-buendeln.js            baut und schreibt die drei Dateien
//   node scripts/kollab-buendeln.js --pruefen  baut im Speicher und vergleicht mit den eingecheckten
//                                              (Exit 1, wenn sie nicht zu package-lock.json passen)
'use strict';
const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'vendor');
const DATEIEN = { js: 'kollab.min.js', css: 'kollab.css', lizenzen: 'kollab-LIZENZEN.txt' };

// Der Einstieg liegt im Projekt (package.json OHNE "type"), damit esbuild ihn als ES-Modul liest.
// Merkposten: Die erste Handy-Probe lag in einem Ordner mit "type": "commonjs" — dort verpackt
// esbuild jedes Paket zusätzlich in eine Hülle, die erst beim ersten Zugriff lädt (8,6 KB mehr).
// Der Bibliothekscode ist in beiden Fassungen derselbe (Eingaben verglichen), nur die Hülle nicht.
const EINTRAG = path.join(__dirname, 'kollab-eintrag.js');

// Paketname aus einem node_modules-Pfad ("node_modules/@scope/name/..." oder "node_modules/name/...")
function paketAus(pfad) {
  const m = pfad.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  return m ? m[1] : null;
}

function lizenzText(paketOrdner) {
  const kandidat = fs.readdirSync(paketOrdner).find(f => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return kandidat ? fs.readFileSync(path.join(paketOrdner, kandidat), 'utf8').trim() : null;
}

async function buendeln() {
  const esbuild = require('esbuild');
  const pakete = require('../package.json');
  const erg = await esbuild.build({
    entryPoints: [EINTRAG],
    bundle: true, minify: true, format: 'iife', write: false, metafile: true,
    // KEIN `target`: esbuild kann lib0 (Yjs) nicht auf ältere Browser herunterübersetzen
    // („Transforming destructuring … is not supported yet"). Das Bündel bleibt beim Stand der
    // Quellen — genau das, was bei Alex auf dem Handy lief.
    legalComments: 'none',   // die Lizenzen stehen vollständig in kollab-LIZENZEN.txt
    logLevel: 'silent',
  });

  const namen = [...new Set(Object.keys(erg.metafile.inputs).map(paketAus).filter(Boolean))].sort();
  const eintraege = namen.map(name => {
    const ordner = path.join(WURZEL, 'node_modules', name);
    const pj = require(path.join(ordner, 'package.json'));
    return { name, version: pj.version, lizenz: pj.license || '(nicht angegeben)', text: lizenzText(ordner) };
  });

  const kopf = `/*! Arbeitsdoku – gemeinsame Notizen: ${eintraege.map(e => e.name + ' ' + e.version).join(', ')}.`
    + ' Lizenzen: /vendor/kollab-LIZENZEN.txt. Gebaut mit scripts/kollab-buendeln.js — nicht von Hand ändern. */\n';
  const js = kopf + erg.outputFiles[0].text;

  const css = '/* Arbeitsdoku – Stile für die gemeinsamen Notizen: quill ' + pakete.devDependencies.quill
    + ' (Snow) + quill-cursors ' + pakete.devDependencies['quill-cursors']
    + '. Gebaut mit scripts/kollab-buendeln.js — Anpassungen gehören nach public/css/style.css. */\n'
    + fs.readFileSync(require.resolve('quill/dist/quill.snow.css'), 'utf8').trim() + '\n'
    + fs.readFileSync(path.join(WURZEL, 'node_modules', 'quill-cursors', 'dist', 'quill-cursors.min.css'), 'utf8').trim() + '\n';

  const lizenzen = 'Mitgelieferte Bibliotheken in kollab.min.js / kollab.css\n'
    + '(erzeugt von scripts/kollab-buendeln.js aus den installierten Paketen)\n\n'
    + eintraege.map(e => `${'='.repeat(72)}\n${e.name} ${e.version} — ${e.lizenz}\n${'='.repeat(72)}\n\n`
      + (e.text || `Das Paket enthält keine eigene Lizenzdatei. Angegebene Lizenz: ${e.lizenz}.`) + '\n').join('\n');

  return { js, css, lizenzen, pakete: eintraege };
}

module.exports = { buendeln, DATEIEN, ZIEL };

if (require.main === module) {
  (async () => {
    const b = await buendeln();
    if (process.argv.includes('--pruefen')) {
      const abweichend = Object.entries(DATEIEN).filter(([k, datei]) => {
        const p = path.join(ZIEL, datei);
        return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== b[k];
      }).map(([, datei]) => datei);
      if (abweichend.length) {
        console.log('ABWEICHUNG: ' + abweichend.join(', ') + ' passen nicht zu den installierten Paketen.'
          + ' Neu bauen: node scripts/kollab-buendeln.js');
        process.exit(1);
      }
      console.log('Bündel stimmt mit den installierten Paketen überein (' + b.pakete.length + ' Pakete).');
      return;
    }
    for (const [k, datei] of Object.entries(DATEIEN)) fs.writeFileSync(path.join(ZIEL, datei), b[k]);
    const kb = Math.round(Buffer.byteLength(b.js) / 1024);
    console.log(`geschrieben: ${Object.values(DATEIEN).join(', ')} — ${kb} KB, ${b.pakete.length} Pakete: `
      + b.pakete.map(p => p.name + ' ' + p.version + ' (' + p.lizenz + ')').join(', '));
  })().catch(e => { console.error(e); process.exit(1); });
}
