// Lohn-Export (C1): eine CSV je Kalendermonat, eine Zeile je Mitarbeiter.
//
// Zweck: Das Buero tippt diese Zahlen bisher jeden Monat aus dem Arbeitsnachweis-PDF ab — und muss
// dafuer sogar PRO PERSON ein eigenes PDF erzeugen, weil der Abwesenheitsblock dort nur bei Auswahl
// eines einzelnen Mitarbeiters erscheint.
//
// Die Zahlen werden hier NICHT neu berechnet. Stunden kommen aus routes/user-hours.js, die
// Abwesenheitstage aus routes/absence-days.js — dieselben Funktionen, die auch Statistik und PDF
// benutzen. Damit koennen die drei Ausgaben nicht auseinanderdriften.

const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { csvZelle, csvDatei } = require('../csv');
const { stundenFuerZeitraum } = require('./user-hours');
const { computeAbsenceSummary } = require('./absence-days');
const { getEmploymentPeriods, employmentOverlaps } = require('./statistics');

const router = express.Router();

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// Zahl mit deutschem Dezimalkomma, wie in den vorhandenen CSV-Exporten.
const zahlDe = (n) => String(Math.round((Number(n) || 0) * 100) / 100).replace('.', ',');

// Monat -> { von, bis, titel }. Gibt null bei ungueltiger Eingabe.
function monatsBereich(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const jahr = Number(m[1]), monat = Number(m[2]);
  if (monat < 1 || monat > 12 || jahr < 1970 || jahr > 9999) return null;
  const letzter = new Date(Date.UTC(jahr, monat, 0)).getUTCDate();   // Tag 0 des Folgemonats
  return {
    von: `${m[1]}-${m[2]}-01`,
    bis: `${m[1]}-${m[2]}-${String(letzter).padStart(2, '0')}`,
    titel: `${MONATE[monat - 1]} ${jahr}`,
  };
}

const SPALTEN = [
  'Personalnummer', 'Name', 'Monat',
  'Soll-Stunden', 'Ist-Stunden', 'Saldo', 'Überstunden gesamt',
  'Urlaub', 'Krank', 'FZA', 'Sonderurlaub', 'Berufsschule', 'Innung', 'Feiertage',
  'Beschäftigt bis',
];

// Sammelt die Zeilen — auch fuer Tests direkt nutzbar, ohne HTTP.
function lohnZeilen(db, von, bis, titel) {
  // Alle ausser Admin, auch bereits ausgestellte: wer im Monat noch angestellt war, gehoert in die
  // Lohnabrechnung — sonst fehlt der letzte Monat.
  const nutzer = db.prepare(
    "SELECT id, name, personnel_no, start_overtime, active FROM users WHERE role <> 'admin' ORDER BY name"
  ).all();

  const zeilen = [];
  for (const u of nutzer) {
    const zeitraeume = getEmploymentPeriods(db, u.id);
    if (!employmentOverlaps(zeitraeume, von, bis)) continue;   // im Monat gar nicht angestellt

    const h = stundenFuerZeitraum(db, u.id, von, bis, u.start_overtime);
    const { summary } = computeAbsenceSummary(db, u.id, von, bis);
    const tag = (k) => Number(summary[k] || 0);

    // „Beschaeftigt bis": nur wenn die Anstellung im Monat oder davor geendet hat.
    let bisDatum = '';
    if (zeitraeume.length) {
      const letzter = zeitraeume[zeitraeume.length - 1];
      if (letzter.end_date && letzter.end_date <= bis) bisDatum = letzter.end_date;
    }

    zeilen.push({
      userId: u.id,                      // fuer den Abrechnungs-Abschluss; in der CSV nicht enthalten
      personalnummer: u.personnel_no || '',
      name: u.name,
      monat: titel,
      soll: h.sollStunden,
      ist: h.istStunden,
      saldo: h.saldo,
      ueberstundenGesamt: h.ueberstundenGesamt,
      urlaub: tag('urlaub'),
      krank: tag('krank'),
      fza: tag('freizeitausgleich'),
      sonderurlaub: tag('sonderurlaub'),
      berufsschule: tag('berufsschule'),
      innung: tag('innung'),
      feiertage: tag('feiertag'),
      beschaeftigtBis: bisDatum,
    });
  }
  return zeilen;
}

function baueCsv(zeilen, titel) {
  const lines = [SPALTEN.map(csvZelle).join(';')];
  const summe = { soll: 0, ist: 0, saldo: 0, urlaub: 0, krank: 0, fza: 0, sonderurlaub: 0, berufsschule: 0, innung: 0, feiertage: 0 };
  for (const z of zeilen) {
    for (const k of Object.keys(summe)) summe[k] += Number(z[k]) || 0;
    lines.push([
      z.personalnummer, z.name, z.monat,
      zahlDe(z.soll), zahlDe(z.ist), zahlDe(z.saldo), zahlDe(z.ueberstundenGesamt),
      zahlDe(z.urlaub), zahlDe(z.krank), zahlDe(z.fza), zahlDe(z.sonderurlaub),
      zahlDe(z.berufsschule), zahlDe(z.innung), zahlDe(z.feiertage),
      z.beschaeftigtBis,
    ].map(csvZelle).join(';'));
  }
  // Summenzeile zum Gegenrechnen. „Überstunden gesamt" wird bewusst NICHT summiert — ein
  // aufaddierter Ueberstundenstand mehrerer Personen hat keine Bedeutung.
  lines.push([
    '', 'Summe', titel,
    zahlDe(summe.soll), zahlDe(summe.ist), zahlDe(summe.saldo), '',
    zahlDe(summe.urlaub), zahlDe(summe.krank), zahlDe(summe.fza), zahlDe(summe.sonderurlaub),
    zahlDe(summe.berufsschule), zahlDe(summe.innung), zahlDe(summe.feiertage),
    '',
  ].map(csvZelle).join(';'));
  return csvDatei(lines);
}

// Chef/Admin/Buchhalter — die Datei enthaelt die Zahlen aller Beschaeftigten.
router.get('/monat.csv', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const bereich = monatsBereich(req.query.month);
  if (!bereich) return res.status(400).json({ error: 'Ungültiger Monat (erwartet JJJJ-MM)' });

  const db = getDb();
  const zeilen = lohnZeilen(db, bereich.von, bereich.bis, bereich.titel);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'payroll_export',
    details: `Lohn-Export ${bereich.titel} (${zeilen.length} Mitarbeiter)`, ip: req.ip,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Lohn_${req.query.month}.csv"`);
  res.send(baueCsv(zeilen, bereich.titel));
});

module.exports = router;
module.exports.monatsBereich = monatsBereich;
module.exports.lohnZeilen = lohnZeilen;
module.exports.SPALTEN = SPALTEN;
