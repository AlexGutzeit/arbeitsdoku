// Unit-Tests der Serien-Engine (rein, ohne Server/DB). Start: node tests/planning-recurrence.js
const { computeOccurrences, nthWeekdayOfMonth, freqLabel, anchorParts } = require('../planning-recurrence');

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const eq = (n, got, exp) => ok(n, JSON.stringify(got) === JSON.stringify(exp), `got ${JSON.stringify(got)} ≠ ${JSON.stringify(exp)}`);

// 08.07.2026 ist ein Mittwoch, der 2. Mittwoch im Juli.
eq('anchorParts 2026-07-08', (({ weekday, nth, day }) => ({ weekday, nth, day }))(anchorParts('2026-07-08')), { weekday: 3, nth: 2, day: 8 });

// weekly + count
eq('weekly count=4', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', end_type: 'count', end_count: 4 }),
  ['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']);
// weekly + until
eq('weekly until 2026-08-01', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', end_type: 'until', end_until: '2026-08-01' }),
  ['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']);
// weekly interval 2 (alle 2 Wochen)
eq('weekly interval=2 count=3', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', interval_weeks: 2, end_type: 'count', end_count: 3 }),
  ['2026-07-08', '2026-07-22', '2026-08-05']);

// monthly_date normal
eq('monthly_date am 8., count=3', computeOccurrences({ freq: 'monthly_date', anchor_date: '2026-07-08', end_type: 'count', end_count: 3 }),
  ['2026-07-08', '2026-08-08', '2026-09-08']);
// monthly_date am 31. → Monate ohne 31. überspringen
eq('monthly_date am 31., count=4 (Feb/Apr/Jun übersprungen)', computeOccurrences({ freq: 'monthly_date', anchor_date: '2026-01-31', end_type: 'count', end_count: 4 }),
  ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);

// monthly_weekday: 2. Mittwoch
eq('monthly_weekday 2. Mi, count=3', computeOccurrences({ freq: 'monthly_weekday', anchor_date: '2026-07-08', end_type: 'count', end_count: 3 }),
  ['2026-07-08', '2026-08-12', '2026-09-09']);
// monthly_weekday: 5. Mittwoch → nur Monate mit 5 Mittwochen
eq('monthly_weekday 5. Mi, count=3 (nur Monate mit 5)', computeOccurrences({ freq: 'monthly_weekday', anchor_date: '2026-07-29', end_type: 'count', end_count: 3 }),
  ['2026-07-29', '2026-09-30', '2026-12-30']);

// yearly, Schaltjahr 29.02. → Nicht-Schaltjahre überspringen
eq('yearly 29.02. Schaltjahr, count=3', computeOccurrences({ freq: 'yearly', anchor_date: '2028-02-29', end_type: 'count', end_count: 3 }),
  ['2028-02-29', '2032-02-29', '2036-02-29']);
// yearly normal
eq('yearly am 08.07., count=2', computeOccurrences({ freq: 'yearly', anchor_date: '2026-07-08', end_type: 'count', end_count: 2 }),
  ['2026-07-08', '2027-07-08']);

// never + horizon (Scheduler-Materialisierung)
eq('weekly never bis Horizont 2026-07-31', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', end_type: 'never' }, { horizon: '2026-07-31' }),
  ['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']);
// from-Filter (nur neue Vorkommen ab Datum) — für rollierende Verlängerung
eq('weekly never, from-Filter 2026-07-20', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', end_type: 'never' }, { horizon: '2026-08-15', from: '2026-07-20' }),
  ['2026-07-22', '2026-07-29', '2026-08-05', '2026-08-12']);

// count bleibt über from-Filter korrekt (zählt ab anchor)
eq('count=4 mit from-Filter liefert nur die späteren, zählt aber ab anchor', computeOccurrences({ freq: 'weekly', anchor_date: '2026-07-08', end_type: 'count', end_count: 4 }, { from: '2026-07-22' }),
  ['2026-07-22', '2026-07-29']);

// Helfer
eq('nthWeekdayOfMonth: 5. Mi August 2026 gibt es nicht → null', nthWeekdayOfMonth(2026, 7, 3, 5), null);
ok('freqLabel weekly', /wöchentlich .*Mittwoch/.test(freqLabel('weekly', '2026-07-08')), freqLabel('weekly', '2026-07-08'));
ok('freqLabel monthly_weekday', /2\. Mittwoch/.test(freqLabel('monthly_weekday', '2026-07-08')), freqLabel('monthly_weekday', '2026-07-08'));

// leere/ungültige Regel
eq('ungültige freq → []', computeOccurrences({ freq: 'nope', anchor_date: '2026-07-08', end_type: 'count', end_count: 3 }), []);

console.log(`\nPlanning-Recurrence (Unit): ${pass} ok, ${fail} fehlgeschlagen`);
process.exit(fail === 0 ? 0 : 1);
