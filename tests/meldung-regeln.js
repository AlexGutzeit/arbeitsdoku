// Regelmäßige Meldungen — die Rechnung (Etappe 3, 30.09.2026).
//
// Alex: „Auto 1 → jeden zweiten 1. März → TÜV" und „jeden 1. und 3. Montag des Monats" (mehrere Auslöser).
// Die Planung kennt kein „alle 2 Jahre" — meldung-regeln.js rechnet selbst. Geprüft wird die reine Rechnung
// gegen Sollwerte, die hier UNABHÄNGIG nachgeprüft werden (Wochentag über Date, nicht über die Funktion):
// Intervalle mit Monatsende und Schaltjahr, n-ter und letzter Wochentag, mehrere Auslöser ohne Doppel,
// Ende nach Anzahl/Datum, Vorlauf, „ab Erledigung", Eingabeprüfung, Beschreibung, Vorschau.
//
//   node tests/meldung-regeln.js
const R = require('../meldung-regeln');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const gleich = (n, ist, soll) => ok(n, JSON.stringify(ist) === JSON.stringify(soll), `ist ${JSON.stringify(ist)} · soll ${JSON.stringify(soll)}`);
const wochentag = (iso) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(iso + 'T12:00:00Z').getUTCDay()];
const regel = (extra, ausloeser) => ({ vorlauf_zahl: 0, vorlauf_einheit: 'tag', uhrzeit: '07:00', takt: 'fest', ende_typ: 'nie', ende_anzahl: null, ende_datum: null, ...extra, _a: ausloeser });
const faellig = (r, bis, basis) => R.faelligkeiten(r, r._a, bis, basis);

console.log('Intervalle');
{
  const tuev = regel({}, [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-03-01' }]);
  gleich('„jeden zweiten 1. März" = alle 2 Jahre ab 01.03.2026', faellig(tuev, '2031-12-31'), ['2026-03-01', '2028-03-01', '2030-03-01']);
  const monat = regel({}, [{ art: 'intervall', einheit: 'monat', n: 1, start_datum: '2026-01-31' }]);
  gleich('Monatsende bleibt Monatsende (31.01. → 28.02. → 31.03. → 30.04.), kein Wandern', faellig(monat, '2026-05-15'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  gleich('Schaltjahr: 31.01.2028 + 1 Monat = 29.02.2028', R.plusMonate('2028-01-31', 1), '2028-02-29');
  gleich('29.02.2028 + 1 Jahr = 28.02.2029', R.schritt('2028-02-29', 'jahr', 1), '2029-02-28');
  const woche = regel({}, [{ art: 'intervall', einheit: 'woche', n: 2, start_datum: '2026-10-05' }]);
  gleich('alle 2 Wochen', faellig(woche, '2026-11-10'), ['2026-10-05', '2026-10-19', '2026-11-02']);
  const tag = regel({}, [{ art: 'intervall', einheit: 'tag', n: 3, start_datum: '2026-12-30' }]);
  gleich('alle 3 Tage über den Jahreswechsel', faellig(tag, '2027-01-06'), ['2026-12-30', '2027-01-02', '2027-01-05']);
}

console.log('Wochentage');
{
  const muell = regel({}, [
    { art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-01' },
    { art: 'wochentag', nth: 3, wochentag: 1, n: 1, start_datum: '2026-10-01' }]);
  const d = faellig(muell, '2026-11-30');
  gleich('1. und 3. Montag (zwei Auslöser, sortiert)', d, ['2026-10-05', '2026-10-19', '2026-11-02', '2026-11-16']);
  ok('… alle wirklich Montage', d.every(x => wochentag(x) === 'Mo'), d.map(wochentag).join());
  ok('… der 1. Montag liegt am 1.–7., der 3. am 15.–21.', Number(d[0].slice(8)) <= 7 && Number(d[1].slice(8)) >= 15 && Number(d[1].slice(8)) <= 21);
  const letzter = regel({}, [{ art: 'wochentag', nth: -1, wochentag: 5, n: 1, start_datum: '2026-10-01' }]);
  const l = faellig(letzter, '2027-02-28');
  gleich('letzter Freitag im Monat', l, ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26']);
  ok('… alle Freitage, und danach kommt im selben Monat keiner mehr', l.every(x => wochentag(x) === 'Fr' && Number(x.slice(8)) + 7 > new Date(Date.UTC(+x.slice(0, 4), +x.slice(5, 7), 0)).getUTCDate()));
  const mitte = regel({}, [{ art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-10' }]);
  gleich('Start mitten im Monat: der 1. Montag davor zählt nicht', faellig(mitte, '2026-12-31'), ['2026-11-02', '2026-12-07']);
  const jaehrlich = regel({}, [{ art: 'wochentag', nth: 1, wochentag: 1, n: 12, start_datum: '2027-02-01' }]);
  gleich('alle 12 Monate = „jedes Jahr am 1. Montag im Februar"', faellig(jaehrlich, '2029-03-01'), ['2027-02-01', '2028-02-07', '2029-02-05']);
  gleich('n-ter Wochentag: den 5. Montag gibt es nicht immer (Februar 2027)', R.nterWochentag(2027, 1, 1, 5), null);
}

console.log('Mehrere Auslöser, Ende');
{
  const doppelt = regel({}, [{ art: 'intervall', einheit: 'woche', n: 1, start_datum: '2026-10-05' },
    { art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-01' }]);
  gleich('fallen zwei Auslöser auf denselben Tag: einmal', faellig(doppelt, '2026-10-20'), ['2026-10-05', '2026-10-12', '2026-10-19']);
  const anzahl = regel({ ende_typ: 'anzahl', ende_anzahl: 3 }, [
    { art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-01' },
    { art: 'wochentag', nth: 3, wochentag: 1, n: 1, start_datum: '2026-10-01' }]);
  gleich('Ende nach 3 Mal — über beide Auslöser gezählt', faellig(anzahl, '2027-12-31'), ['2026-10-05', '2026-10-19', '2026-11-02']);
  const datum = regel({ ende_typ: 'datum', ende_datum: '2030-02-28' }, [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-03-01' }]);
  gleich('Ende am Datum', faellig(datum, '2035-12-31'), ['2026-03-01', '2028-03-01']);
}

console.log('Vorlauf, ab Erledigung');
{
  gleich('4 Wochen Vorlauf vor dem 01.03.2028, um 07:00', R.ausloeseMoment({ vorlauf_zahl: 4, vorlauf_einheit: 'woche', uhrzeit: '07:00' }, '2028-03-01'), '2028-02-02 07:00');
  gleich('1 Monat Vorlauf vor dem 31.03.2028 → 29.02.2028', R.ausloeseMoment({ vorlauf_zahl: 1, vorlauf_einheit: 'monat', uhrzeit: '06:30' }, '2028-03-31'), '2028-02-29 06:30');
  gleich('ohne Vorlauf: am Fälligkeitstag', R.ausloeseMoment({ vorlauf_zahl: 0, vorlauf_einheit: 'tag', uhrzeit: '07:00' }, '2026-10-05'), '2026-10-05 07:00');
  const oel = regel({ takt: 'ab_erledigung' }, [{ art: 'intervall', einheit: 'monat', n: 12, start_datum: '2026-11-01' }]);
  gleich('ab Erledigung, noch nie erledigt: das Startdatum', faellig(oel, '2030-01-01', null), ['2026-11-01']);
  gleich('ab Erledigung: 12 Monate nach der letzten Erledigung (10.05.2027)', faellig(oel, '2030-01-01', '2027-05-10'), ['2028-05-10']);
  gleich('… noch nicht so weit: nichts', faellig(oel, '2028-05-09', '2027-05-10'), []);
}

console.log('Eingabe prüfen');
{
  const gut = { text: 'TÜV', ausloeser: [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-03-01' }] };
  ok('gültige Regel: Vorgaben 07:00, Takt fest, Ende nie, Vorlauf 0', (() => { const r = R.regelPruefen(gut).r;
    return r && r.uhrzeit === '07:00' && r.takt === 'fest' && r.ende_typ === 'nie' && r.vorlauf_zahl === 0; })());
  const fehler = (name, b, muster) => { const r = R.regelPruefen(b); ok(name, r.fehler && muster.test(r.fehler), JSON.stringify(r)); };
  fehler('ohne Text', { ...gut, text: ' ' }, /Text/);
  fehler('ohne Auslöser', { ...gut, ausloeser: [] }, /Auslöser/);
  fehler('ungültiges Startdatum (31.02.)', { ...gut, ausloeser: [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-02-31' }] }, /Startdatum/);
  fehler('„5." gibt es nicht', { ...gut, ausloeser: [{ art: 'wochentag', nth: 5, wochentag: 1, n: 1, start_datum: '2026-10-01' }] }, /letzter/);
  fehler('Uhrzeit 25:00', { ...gut, uhrzeit: '25:00' }, /Uhrzeit/);
  fehler('ab Erledigung mit zwei Auslösern', { ...gut, takt: 'ab_erledigung', ausloeser: [gut.ausloeser[0], gut.ausloeser[0]] }, /genau einem/);
  fehler('ab Erledigung mit Wochentag-Auslöser', { ...gut, takt: 'ab_erledigung', ausloeser: [{ art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-01' }] }, /genau einem/);
  fehler('Ende nach 0 Mal', { ...gut, ende_typ: 'anzahl', ende_anzahl: 0 }, /Ende/);
  fehler('Vorlauf 400 Tage', { ...gut, vorlauf_zahl: 400 }, /Vorlauf/);
}

console.log('Beschreibung');
{
  gleich('TÜV', R.ausloeserText({ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-03-01' }), 'alle 2 Jahre ab 01.03.2026');
  gleich('monatlich', R.ausloeserText({ art: 'intervall', einheit: 'monat', n: 1, start_datum: '2026-01-31' }), 'jeden Monat ab 31.01.2026');
  gleich('1. Montag', R.ausloeserText({ art: 'wochentag', nth: 1, wochentag: 1, n: 1, start_datum: '2026-10-01' }), 'jeden 1. Montag im Monat');
  gleich('letzter Freitag', R.ausloeserText({ art: 'wochentag', nth: -1, wochentag: 5, n: 1, start_datum: '2026-10-01' }), 'jeden letzten Freitag im Monat');
  gleich('jährlich', R.ausloeserText({ art: 'wochentag', nth: 1, wochentag: 1, n: 12, start_datum: '2027-02-01' }), 'jedes Jahr am 1. Montag im Februar');
}

console.log('Vorschau');
{
  const jetzt = new Date('2026-09-30T08:00:00Z');   // 10:00 in Berlin
  const tuev = regel({ vorlauf_zahl: 4, vorlauf_einheit: 'woche' }, [{ art: 'intervall', einheit: 'jahr', n: 2, start_datum: '2026-03-01' }]);
  gleich('nächste Fälligkeiten mit Auslösung (die vergangene vom März 2026 fehlt)', R.vorschau(tuev, tuev._a, jetzt, 2),
    [{ faellig: '2028-03-01', ausloesung: '2028-02-02 07:00' }, { faellig: '2030-03-01', ausloesung: '2030-02-01 07:00' }]);
}

console.log(`\nRegelmäßige Meldungen — Rechnung: ${pass} bestanden, ${fail} fehlgeschlagen`);
if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
