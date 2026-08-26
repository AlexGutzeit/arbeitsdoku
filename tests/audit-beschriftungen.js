// Jede protokollierte Aktion braucht eine Beschriftung (Alex, 26.08.2026)
//
// AUDIT_LABELS in app-6-admin.js steuert ZWEI Dinge: wie eine Zeile im Protokoll heisst — und
// welche Eintraege im Filter-Auswahlfeld ueberhaupt auftauchen. Fehlt dort ein Eintrag, steht im
// Protokoll ein technischer Bezeichner wie „backup_empfaenger_add", und nach genau dieser Aktion
// laesst sich gar nicht erst filtern. Auffallen tut das niemandem, bis jemand etwas sucht.
//
// Genau so passiert: Die Sicherungs-Schluessel und das aufgeraeumte Bestellrecht wurden zwar
// protokolliert, aber ohne Beschriftung. Deshalb dieser Test — er vergleicht, was der Code
// wirklich schreibt, mit dem, was die Oberflaeche benennen kann.
//
//   node tests/audit-beschriftungen.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const wurzel = path.join(__dirname, '..');

// Alle Aktionen, die irgendwo per logAudit geschrieben werden.
function aktionenAusCode() {
  const raus = new Set();
  const dateien = [
    ...fs.readdirSync(path.join(wurzel, 'routes')).filter(f => f.endsWith('.js')).map(f => path.join('routes', f)),
    // middleware/ nicht vergessen: Dort wird der Sitzungs-Timeout protokolliert.
    ...fs.readdirSync(path.join(wurzel, 'middleware')).filter(f => f.endsWith('.js')).map(f => path.join('middleware', f)),
    ...fs.readdirSync(wurzel).filter(f => f.endsWith('.js')),
  ];
  for (const rel of dateien) {
    const p = path.join(wurzel, rel);
    if (!fs.statSync(p).isFile()) continue;
    const inhalt = fs.readFileSync(p, 'utf8');
    for (const zeile of inhalt.split('\n')) {
      // Nur echte Aufrufe, keine Kommentarzeilen wie „// action: 'update' | 'delete'".
      if (/^\s*\/\//.test(zeile)) continue;
      // Nicht nur `action: 'x'`: Es gibt Ternaere (`action: a ? 'x' : 'y'`) und Aufrufe, die den
      // Namen als Parameter durchreichen (auditVac(db, req, 'vacation_create', …)). Deshalb ab
      // `action:` bzw. bei bekannten Hilfsfunktionen ALLE Zeichenketten der Zeile einsammeln.
      const ab = zeile.indexOf('action:');
      let rest = ab >= 0 ? zeile.slice(ab) : (/audit[A-Za-z]*\(|logAudit\(/.test(zeile) ? zeile : '');
      // Am naechsten Schluessel abschneiden — sonst wandert der Wert von `details:` mit hinein
      // (so geriet 'manuell' in die Liste).
      for (const schluessel of ['details:', 'ip:', 'userId:', 'username:']) {
        const i = rest.indexOf(schluessel, 1);
        if (i > 0) rest = rest.slice(0, i);
      }
      for (const m of rest.matchAll(/'([a-z][a-z_0-9]{3,})'/g)) raus.add(m[1]);
    }
  }
  return raus;
}

// Die Beschriftungen aus der Oberflaeche.
function beschriftungen() {
  const inhalt = fs.readFileSync(path.join(wurzel, 'public', 'js', 'app-6-admin.js'), 'utf8');
  const anfang = inhalt.indexOf('const AUDIT_LABELS = {');
  if (anfang < 0) return null;
  const ende = inhalt.indexOf('\n};', anfang);
  const block = inhalt.slice(anfang, ende);
  const raus = new Set();
  for (const m of block.matchAll(/^\s{2}([a-z_0-9]+):\s*'/gm)) raus.add(m[1]);
  return raus;
}

const code = aktionenAusCode();
const labels = beschriftungen();

ok('AUDIT_LABELS gefunden', !!labels && labels.size > 10, labels ? String(labels.size) : 'nicht gefunden');
ok('es werden ueberhaupt Aktionen protokolliert', code.size > 20, String(code.size));

const ohneBeschriftung = [...code].filter(a => !labels.has(a)).sort();
ok('jede protokollierte Aktion hat eine Beschriftung (und ist damit filterbar)',
  ohneBeschriftung.length === 0, ohneBeschriftung.join(', '));

// Andersherum ebenfalls: Eine Beschriftung fuer etwas, das niemand mehr schreibt, fuellt das
// Filterfeld mit toten Eintraegen. Kein Beinbruch, aber ein Hinweis auf Reste.
const totesLabel = [...labels].filter(a => !code.has(a)).sort();
ok('keine Beschriftung fuer Aktionen, die es nicht mehr gibt', totesLabel.length === 0, totesLabel.join(', '));

console.log(`\nAudit-Beschriftungen: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
process.exit(fail === 0 ? 0 : 1);
