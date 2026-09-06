// Eine Zeitzone im ganzen Servercode (Alex, 06.09.2026: „Nicht dass noch irgendwo Zeiten um
// (mehrere) Stunde(n) auseinander laufen.").
//
// Die Lage im Projekt ist bewusst zweigeteilt, und das ist in Ordnung, solange nicht VERGLICHEN
// wird:
//   * SQL-Zeitstempel (`strftime('now')`) sind UTC — Bulletin, Notizen, Abwesenheiten, user_seen.
//   * JS-Zeitstempel (`berlinJetzt()`) sind deutsche Ortszeit — Protokoll, Ausstellen, Auszahlung.
// Gefährlich wird es an drei Stellen, und die prüft dieser Test:
//
//   1. „HEUTE" aus `toISOString()`. Das ist das UTC-Datum: Zwischen Mitternacht und zwei Uhr
//      (Sommerzeit) liefert es den VORTAG. Am 1. Januar früh wäre das das falsche Jahr.
//      Genau so löschte der Aushang zwei Stunden zu spät und rechnete das Urlaubskonto im
//      falschen Jahr.
//   2. Ein Vergleich zwischen den beiden Familien. `user_seen.seen_at` ist UTC, aber
//      `overtime_payouts.entschieden_am` ist Ortszeit — dafür gibt es getSeenAtBerlin().
//   3. Die Zeitzone des PROZESSES. `toLocaleDateString('sv-SE')` ohne Angabe nimmt sie; auf einem
//      Server, der auf UTC steht, wäre alles lautlos zwei Stunden daneben.
//
//   node tests/zeitzonen.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

const WURZEL = path.join(__dirname, '..');
// Servercode. `public/` bleibt aussen vor: Dort gilt die Zeitzone des BROWSERS, und die ist beim
// Benutzer die richtige — eine feste Zone wäre dort sogar falsch.
function serverDateien() {
  const out = [];
  for (const d of ['.', 'routes', 'database', 'middleware']) {
    const voll = path.join(WURZEL, d);
    if (!fs.existsSync(voll)) continue;
    for (const f of fs.readdirSync(voll)) {
      if (!f.endsWith('.js')) continue;
      const p = path.join(voll, f);
      if (fs.statSync(p).isFile()) out.push(path.relative(WURZEL, p));
    }
  }
  return out;
}

const dateien = serverDateien();
console.log(`  ${dateien.length} Server-Dateien`);

// ── 1. Kein „heute" aus UTC ──────────────────────────────────────────────────────────────────
console.log('\n── „Heute" darf nicht aus UTC kommen ──');
const utcHeute = [];
for (const f of dateien) {
  const text = fs.readFileSync(path.join(WURZEL, f), 'utf8');
  text.split('\n').forEach((z, i) => {
    // Dateinamen von Ausgabedateien sind harmlos (Content-Disposition, a.download) — dort geht es
    // um eine Beschriftung, nicht um eine Rechnung.
    if (/Content-Disposition|filename=|\.download/.test(z)) return;
    if (/new Date\(\)\.toISOString\(\)\.slice\(0,\s*(10|7)\)/.test(z)) utcHeute.push(`${f}:${i + 1}`);
  });
}
ok('nirgends wird „heute" aus new Date().toISOString() gerechnet', utcHeute.length === 0, utcHeute.join(', '));

// ── 2. Ortszeit wird ausdrücklich benannt ────────────────────────────────────────────────────
console.log('\n── Ortszeit wird ausdrücklich benannt ──');
const implizit = [];
for (const f of dateien) {
  const text = fs.readFileSync(path.join(WURZEL, f), 'utf8');
  text.split('\n').forEach((z, i) => {
    // toLocaleDateString/-String OHNE timeZone-Angabe nimmt die Zeitzone des Prozesses.
    if (!/toLocale(Date)?String\('sv-SE'/.test(z)) return;
    if (/timeZone/.test(z)) return;
    implizit.push(`${f}:${i + 1}`);
  });
}
// Kein Fehler, aber es muss BEKANNT sein: server.js legt TZ fest, damit diese Stellen stimmen.
ok(`Stellen ohne ausdrückliche Zeitzone sind durch die TZ-Festlegung gedeckt (${implizit.length})`,
  fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8').includes("process.env.TZ = 'Europe/Berlin'"),
  implizit.slice(0, 6).join(', '));

// ── 3. Die Rechnung gibt es nur EINMAL ───────────────────────────────────────────────────────
console.log('\n── Eine Quelle für die Ortszeit ──');
const eigenbau = [];
for (const f of dateien) {
  if (f === 'zeit.js') continue;
  const text = fs.readFileSync(path.join(WURZEL, f), 'utf8');
  text.split('\n').forEach((z, i) => {
    if (/timeZone:\s*'Europe\/Berlin'/.test(z) && /toLocale/.test(z)) eigenbau.push(`${f}:${i + 1}`);
  });
}
ok('die Ortszeit-Rechnung steht nur in zeit.js', eigenbau.length === 0, eigenbau.join(', '));

// ── 4. Und sie stimmt ────────────────────────────────────────────────────────────────────────
console.log('\n── Die Rechnung stimmt ──');
const { berlinHeute, berlinJetzt } = require('../zeit');
const { berlinNow } = require('../audit');
const winter = new Date('2026-01-15T23:30:00Z');   // 00:30 Berlin am 16.01.
const sommer = new Date('2026-07-15T23:30:00Z');   // 01:30 Berlin am 16.07.
ok('Winterzeit: 23:30 UTC am 15.01. ist in Berlin schon der 16.01.',
  berlinHeute(winter) === '2026-01-16', berlinHeute(winter));
ok('Sommerzeit: 23:30 UTC am 15.07. ist in Berlin schon der 16.07.',
  berlinHeute(sommer) === '2026-07-16', berlinHeute(sommer));
ok('… und der UTC-Weg hätte in beiden Fällen den VORTAG geliefert',
  winter.toISOString().slice(0, 10) === '2026-01-15' && sommer.toISOString().slice(0, 10) === '2026-07-15');
ok('berlinJetzt liefert „JJJJ-MM-TT HH:MM:SS"', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(berlinJetzt()), berlinJetzt());
ok('audit.berlinNow und zeit.berlinJetzt sind dieselbe Rechnung',
  berlinNow().slice(0, 16) === berlinJetzt().slice(0, 16), `${berlinNow()} / ${berlinJetzt()}`);

// ── 5. Der Vergleich UTC gegen Ortszeit ist abgesichert ──────────────────────────────────────
console.log('\n── Der eine Vergleich über die Zonengrenze ──');
const badges = fs.readFileSync(path.join(WURZEL, 'routes/badges.js'), 'utf8');
ok('badges.js rechnet seen_at für den Auszahlungs-Vergleich in Ortszeit um',
  /getSeenAtBerlin\(db, uid, 'mitarbeiter'\)/.test(badges));
const payouts = fs.readFileSync(path.join(WURZEL, 'routes/payouts.js'), 'utf8');
ok('… und payouts.js ebenso', /getSeenAtBerlin\(/.test(payouts));
ok('die übrigen Zähler vergleichen UTC gegen UTC (getSeenAt, unverändert)',
  /getSeenAt\(db, uid, 'bulletin'\)|getSeenAt\(db, uid, 'notes'\)|getSeenAt\(db, uid, 'absences'\)/.test(badges));

console.log(`\nZeitzonen: ${pass} bestanden, ${fail} fehlgeschlagen`);
if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
