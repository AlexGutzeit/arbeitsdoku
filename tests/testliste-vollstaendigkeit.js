// Wächter über die Testliste in tests/README.md.
//
// Die Liste war einmal auf 9 von 143 Tests stehengeblieben, weil sie von Hand geführt wurde. Jetzt
// erzeugt sie `scripts/generate-test-index.js` — und dieser Test wird rot, sobald sie nicht mehr
// zum Stand von `tests/` passt. Gleiches Muster wie tests/deploy-vollstaendigkeit.js, das eine
// vergessene Datei in deploy.sh abfängt.
//
// Wird er rot, genügt:  node scripts/generate-test-index.js
//
//   node tests/testliste-vollstaendigkeit.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const WURZEL = path.join(__dirname, '..');
const README = path.join(__dirname, 'README.md');

let ausgabe = '', aktuell = true;
try {
  ausgabe = execFileSync(process.execPath, ['scripts/generate-test-index.js', '--pruefen'],
    { cwd: WURZEL, encoding: 'utf8' });
} catch (e) {
  aktuell = false;
  ausgabe = (e.stdout || '') + (e.stderr || '');
}
ok('Testliste in tests/README.md ist aktuell', aktuell,
  ausgabe.trim().split('\n').slice(0, 2).join(' | ') + '  → node scripts/generate-test-index.js');

// Zweite, unabhaengige Pruefung: JEDE Testdatei muss in der Liste vorkommen. Sie faengt auch den
// Fall ab, dass jemand die Marker entfernt oder den Erzeuger kaputtmacht — dann waere die erste
// Pruefung gruen, ohne dass die Liste noch etwas taugt.
const text = fs.readFileSync(README, 'utf8');
const dateien = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));
const fehlend = dateien.filter(f => !text.includes('`' + f + '`'));
ok(`alle ${dateien.length} Tests stehen in der Liste`, fehlend.length === 0, fehlend.slice(0, 5).join(', '));

// Und: Kein Test ohne beschreibende erste Zeile — sonst steht in der Liste nur ein Platzhalter.
const ohneKopf = dateien.filter(f => {
  const zeilen = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n');
  for (const z of zeilen.slice(0, 40)) {
    const t = z.trim();
    if (!t) continue;
    if (!t.startsWith('//')) return true;
    if (t.replace(/^\/\/\s?/, '').trim()) return false;
  }
  return true;
});
ok('jeder Test hat eine beschreibende erste Kommentarzeile', ohneKopf.length === 0, ohneKopf.slice(0, 5).join(', '));

console.log(`\nTestliste vollständig: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
process.exit(fail === 0 ? 0 : 1);
