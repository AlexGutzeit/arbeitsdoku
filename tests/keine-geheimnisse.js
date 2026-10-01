// Keine Geheimnisse im Repo (Alex, 01.10.2026).
//
// Das Repo ist öffentlich. GitGuardian meldete am 01.10.2026 einen privaten VAPID-Schlüssel: Sieben Tests trugen
// seit dem 27.06. den Push-Schlüssel der LOKALEN Entwicklungsumgebung fest im Code (nicht den von Prod — per
// Prüfsumme verglichen). Die Tests erzeugen ihr Paar seitdem beim Start, der lokale Schlüssel ist getauscht.
// Dieser Test hält den Stand. Er durchsucht jede Datei, die Git verfolgt oder neu aufnehmen würde, nach
//   A  einem privaten VAPID-Schlüssel als fester Wert (VAPID_PRIVATE = '…', privateKey: '…');
//   B  einem privaten Schlüssel im PEM-Format (-----BEGIN … PRIVATE KEY-----);
//   C  den Werten der geheimen Einträge aus der lokalen .env (Name enthält SECRET, KEY, PRIVATE, TOKEN oder PASS)
//      — so fällt auch ein Geheimnis auf, für das es kein Muster gibt. Ohne .env (anderer Rechner) entfällt C,
//      und der Test sagt das.
// Die Suchmuster prüft er vorher an eingesetzten Beispielen — ein Muster, das nichts findet, wäre sonst grün.
//
//   node tests/keine-geheimnisse.js
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const webpush = require('web-push');

const APP = path.join(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const MUSTER = [
  ['privater VAPID-Schlüssel', /VAPID_PRIVATE\s*[:=]\s*['"`]?[A-Za-z0-9_-]{30,}/],
  ['privateKey als fester Wert', /privateKey\s*:\s*['"`][A-Za-z0-9_+/=-]{30,}['"`]/],
  ['PEM-Schlüssel', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const fund = (text) => MUSTER.filter(([, re]) => re.test(text)).map(([name]) => name);

// Geheime Werte aus der lokalen .env — die Werte selbst werden nie ausgegeben
function geheimeWerte() {
  const p = path.join(APP, '.env');
  if (!fs.existsSync(p)) return null;
  const werte = [];
  for (const zeile of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(zeile);
    if (!m || !/SECRET|KEY|PRIVATE|TOKEN|PASS/.test(m[1]) || /PUBLIC/.test(m[1])) continue;
    const wert = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (wert.length >= 12) werte.push({ name: m[1], wert });
  }
  return werte;
}

console.log('Die Suchmuster finden, was sie finden sollen');
const paar = webpush.generateVAPIDKeys();
ok('A: eingesetzter Schlüssel (process.env.VAPID_PRIVATE = …) wird gefunden', fund(`process.env.VAPID_PRIVATE = '${paar.privateKey}';`).length === 1);
ok('A: auch in einer .env-Zeile und als Objektfeld', fund(`VAPID_PRIVATE=${paar.privateKey}`).length === 1 && fund(`{ privateKey: '${paar.privateKey}' }`).length === 1);
// Zur Laufzeit zusammengesetzt — stünde der Kopf hier am Stück, schlüge der Test (und GitGuardian) bei sich selbst an
ok('B: PEM-Kopf wird gefunden', fund('-----BEGIN EC PRIV' + 'ATE KEY-----\nMHcCAQEE…').length === 1);
ok('kein Fehlalarm bei erzeugten Paaren und Platzhaltern',
  fund("{ const k = require('web-push').generateVAPIDKeys(); process.env.VAPID_PRIVATE = k.privateKey; }").length === 0
  && fund('VAPID_PRIVATE=<privater Schlüssel>').length === 0 && fund("const { privateKey: VAPID_PRIVATE } = gen();").length === 0);

// Auch neue, noch nicht committete Dateien (aber nichts, was .gitignore ausschließt, also nicht die .env) — so
// fällt ein Geheimnis VOR dem Push auf. Genau ein neuer Test hatte die Meldung vom 01.10. ausgelöst.
console.log('Alle Dateien, die Git verfolgt oder neu aufnehmen würde');
const dateien = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: APP }).toString().split('\0').filter(Boolean);
const geheim = geheimeWerte();
const treffer = [], envTreffer = [];
let gelesen = 0;
for (const rel of dateien) {
  const p = path.join(APP, rel);
  let st; try { st = fs.statSync(p); } catch (_) { continue; }   // im Arbeitsbaum gelöscht
  if (!st.isFile() || st.size > 20 * 1024 * 1024) continue;
  const text = fs.readFileSync(p).toString('latin1');
  gelesen++;
  for (const name of fund(text)) treffer.push(`${rel}: ${name}`);
  if (geheim) for (const g of geheim) if (text.includes(g.wert)) envTreffer.push(`${rel}: Wert von ${g.name}`);
}
ok(`${gelesen} Dateien gelesen`, gelesen > 300, String(gelesen));
ok('A/B: kein privater Schlüssel als fester Wert', treffer.length === 0, treffer.slice(0, 5).join(' | '));
if (geheim) {
  ok(`C: keiner der ${geheim.length} geheimen Werte aus der lokalen .env steht im Repo`, geheim.length > 0 && envTreffer.length === 0,
    envTreffer.slice(0, 5).join(' | '));
} else {
  console.log('  · C entfällt: keine .env auf diesem Rechner');
}

console.log(`\nKeine Geheimnisse im Repo: ${pass} bestanden, ${fail} fehlgeschlagen`);
if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
