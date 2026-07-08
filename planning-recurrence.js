'use strict';
// Serien-Engine für Planungs-Wiederholungen. REINE Funktionen (keine DB) → unit-testbar.
// Berechnet die Start-Daten der Wiederholungen aus einer Regel. Das Anwenden der Tages-Vorlage
// (mehrtägige Spanne, Zeiten) passiert im Route-Handler; hier geht es nur um die Vorkommen-Daten.
//
// Rechnen bewusst in UTC (Date.UTC / toISOString), damit Sommer-/Winterzeit keine Tage verschiebt.

const MS_DAY = 86400000;
const FREQS = ['yearly', 'monthly_date', 'monthly_weekday', 'weekly'];

const fromISO = (s) => new Date(s + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m: 0–11

// n-tes Vorkommen (1–5) eines Wochentags im Monat, oder null wenn es das nicht gibt (z. B. 5. Mittwoch).
function nthWeekdayOfMonth(y, m, weekday, nth) {
  const first = new Date(Date.UTC(y, m, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  if (day > daysInMonth(y, m)) return null;
  return new Date(Date.UTC(y, m, day));
}

// Aus dem Startdatum abgeleitete Serien-Merkmale (Wochentag, Monatstag, n-ter Wochentag).
function anchorParts(anchorISO) {
  const a = fromISO(anchorISO);
  const day = a.getUTCDate();
  return {
    year: a.getUTCFullYear(), month: a.getUTCMonth(), day,
    weekday: a.getUTCDay(),                 // 0=So … 6=Sa
    nth: Math.floor((day - 1) / 7) + 1,     // wievielter dieses Wochentags im Monat
  };
}

// rule: { freq, anchor_date, interval_weeks?, end_type('never'|'count'|'until'), end_count?, end_until? }
// opts: { horizon?: ISO (Pflicht bei 'never'), from?: ISO (nur Vorkommen >= from zurückgeben) }
// Liefert aufsteigend sortierte ISO-Startdaten der Wiederholungen (inkl. Startdatum selbst).
function computeOccurrences(rule, opts = {}) {
  if (!rule || !FREQS.includes(rule.freq) || !rule.anchor_date) return [];
  const { freq } = rule;
  const interval = Math.max(1, Number(rule.interval_weeks) || 1);
  const { year: aY, month: aM, day: aD, weekday: aW, nth } = anchorParts(rule.anchor_date);
  const anchor = fromISO(rule.anchor_date);

  const endType = rule.end_type || 'never';
  const count = endType === 'count' ? Math.max(1, Number(rule.end_count) || 1) : null;
  const until = endType === 'until' ? rule.end_until : null;
  const horizon = opts.horizon || null;
  const from = opts.from || null;

  const out = [];
  const MAX_ITER = 8000; // Sicherheitsobergrenze (viele Skips bei z. B. „am 31.")
  let produced = 0;      // Anzahl echter Vorkommen ab anchor (für 'count')

  for (let k = 0; k < MAX_ITER; k++) {
    let d = null;
    if (freq === 'weekly') {
      d = new Date(anchor.getTime() + k * interval * 7 * MS_DAY);
    } else if (freq === 'yearly') {
      const y = aY + k;
      if (!(aM === 1 && aD === 29 && daysInMonth(y, 1) < 29)) d = new Date(Date.UTC(y, aM, aD));
    } else if (freq === 'monthly_date') {
      const y = aY + Math.floor((aM + k) / 12);
      const m = (aM + k) % 12;
      if (daysInMonth(y, m) >= aD) d = new Date(Date.UTC(y, m, aD));
    } else if (freq === 'monthly_weekday') {
      const y = aY + Math.floor((aM + k) / 12);
      const m = (aM + k) % 12;
      d = nthWeekdayOfMonth(y, m, aW, nth);
    }
    if (!d) continue; // übersprungener Kandidat (existiert in dem Monat/Jahr nicht)

    const ds = iso(d);
    if (until && ds > until) break;
    if (horizon && ds > horizon) break;
    produced++;
    if (!from || ds >= from) out.push(ds);
    if (count && produced >= count) break;
  }
  return out;
}

// Menschenlesbares Label für die Serien-Frequenz (für Vorschau/Anzeige).
function freqLabel(freq, anchorISO) {
  const wd = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const { day, weekday, nth } = anchorParts(anchorISO);
  const nthWord = ['', '1.', '2.', '3.', '4.', '5.'][nth] || (nth + '.');
  switch (freq) {
    case 'yearly': return `jährlich (jedes Jahr am ${day}.${(fromISO(anchorISO).getUTCMonth() + 1)}.)`;
    case 'monthly_date': return `monatlich (jeden Monat am ${day}.)`;
    case 'monthly_weekday': return `monatlich (jeden ${nthWord} ${wd[weekday]} des Monats)`;
    case 'weekly': return `wöchentlich (jeden ${wd[weekday]})`;
    default: return '';
  }
}

module.exports = { computeOccurrences, nthWeekdayOfMonth, daysInMonth, anchorParts, freqLabel, FREQS };
