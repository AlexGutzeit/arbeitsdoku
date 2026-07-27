// Abrechnungs-Abschluss: Monate abschließen, die dabei gültigen Zahlen festhalten, Abweichungen
// nachträglicher Korrekturen ausweisen.
//
// Warum überhaupt: siehe abschluss.js. Kurz — der Überstundenstand lief bisher bei jeder Abfrage
// über die gesamte Firmengeschichte, eine Korrektur im bezahlten Mai landete damit still im
// heutigen Guthaben.
//
// Die Zahlen werden hier NICHT neu erfunden: lohnZeilen() aus dem Lohn-Export liefert exakt die
// Werte, die auch in der CSV ans Lohnbüro gehen. Damit ist die festgehaltene Zeile per Bauart der
// Beleg dessen, was exportiert wurde — und nicht eine zweite, leicht abweichende Rechnung.

const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit, berlinNow } = require('../audit');
const { monatsBereich, lohnZeilen } = require('./payroll');
const { kumulierteRohwerte } = require('./user-hours');
const { getEarliestTargetDate } = require('./statistics');
const { abgerechnetBis, deDatum, MIN_GRUND } = require('../abschluss');

const router = express.Router();

const istManager = (u) => u && (u.role === 'admin' || u.role === 'chef' || u.role === 'buchhalter');

const ZEILEN_FELDER = ['soll', 'ist', 'saldo', 'ueberstundenGesamt', 'urlaub', 'krank', 'fza',
  'sonderurlaub', 'berufsschule', 'innung', 'feiertage'];

function perioden(db) {
  return db.prepare('SELECT * FROM payroll_closures ORDER BY period_to ASC').all();
}

function zeilenVon(db, closureId) {
  return db.prepare('SELECT * FROM payroll_closure_rows WHERE closure_id = ? ORDER BY name').all(closureId);
}

// Welcher Monat ist als nächstes dran? Lückenlos: immer der Monat NACH dem letzten Abschluss,
// beim allerersten Mal der Monat des frühesten Zeiteintrags.
function naechsterMonat(db) {
  const bis = abgerechnetBis(db);
  if (bis) {
    const d = new Date(bis + 'T12:00:00Z');
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 7);
  }
  const r = db.prepare('SELECT MIN(date) AS d FROM entries WHERE deleted_at IS NULL').get();
  return (r && r.d) ? String(r.d).slice(0, 7) : null;
}

// Offene Anträge im Zeitraum. Sie zu genehmigen würde die gerade festgeschriebenen Zahlen
// nachträglich verschieben — deshalb müssen sie vorher entschieden sein.
function offeneAntraege(db, von, bis) {
  return db.prepare(
    `SELECT a.id, a.type, a.date_from, a.date_to, u.name
       FROM absences a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.status = 'pending' AND a.deleted_at IS NULL
        AND a.date_from <= ? AND a.date_to >= ?
      ORDER BY a.date_from`
  ).all(bis, von);
}

/**
 * Schreibt Periode + Zeilen. Getrennt von der Route, damit der Gleichheits-Test genau diesen
 * Schreibweg benutzen kann statt einer Nachbildung — eine Nachbildung würde die eigentliche
 * Frage (ändert der Abschluss angezeigte Zahlen?) am Prüfling vorbei testen.
 *
 * WICHTIG: lohnZeilen() läuft VOR dem INSERT. Sonst wäre die gerade angelegte Periode schon die
 * Rechenbasis für sich selbst — der festgehaltene Wert entstünde aus einem leeren Rest-Zeitraum
 * und wäre der Stand des VORmonats.
 */
function abschliessen(db, bereich, user) {
  const zeilen = lohnZeilen(db, bereich.von, bereich.bis, bereich.titel);

  // Ungerundete Zwischenstaende — die Rechenbasis fuer alles nach dem Stichtag. Sie MUESSEN vor
  // dem INSERT ermittelt werden: danach waere die neue Periode schon ihre eigene Basis und die
  // Werte kaemen aus einem leeren Rest-Zeitraum.
  const kum = {};
  for (const z of zeilen) {
    const ab = getEarliestTargetDate(db, z.userId);
    kum[z.userId] = ab ? kumulierteRohwerte(db, z.userId, ab, bereich.bis) : { istRoh: 0, sollRoh: 0 };
  }

  const info = db.prepare(
    'INSERT INTO payroll_closures (period_from, period_to, closed_at, closed_by, closed_by_name) VALUES (?, ?, ?, ?, ?)'
  ).run(bereich.von, bereich.bis, berlinNow(), user.id, user.name || user.username);
  const closureId = info.lastInsertRowid;

  const ins = db.prepare(
    `INSERT INTO payroll_closure_rows
       (closure_id, user_id, personnel_no, name, soll, ist, saldo, ueberstunden_gesamt,
        ist_kumuliert, soll_kumuliert,
        urlaub, krank, fza, sonderurlaub, berufsschule, innung, feiertage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const z of zeilen) {
    ins.run(closureId, z.userId, z.personalnummer, z.name, z.soll, z.ist, z.saldo,
      z.ueberstundenGesamt, kum[z.userId].istRoh, kum[z.userId].sollRoh,
      z.urlaub, z.krank, z.fza, z.sonderurlaub, z.berufsschule,
      z.innung, z.feiertage);
  }
  return { closureId, zeilen };
}

// Stand für alle: Mitarbeiter sehen den Stichtag und ihre EIGENEN festgehaltenen Zahlen —
// sie sollen nachvollziehen können, was für sie ans Lohnbüro ging. Muster: der schmale
// Endpunkt GET /api/settings/arbeitszeit.
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const alle = perioden(db);
  const manager = istManager(req.user);
  res.json({
    bis: abgerechnetBis(db),
    naechsterMonat: manager ? naechsterMonat(db) : null,
    perioden: alle.map(p => ({
      id: p.id, periodFrom: p.period_from, periodTo: p.period_to,
      closedAt: p.closed_at, closedByName: p.closed_by_name,
      zeilen: zeilenVon(db, p.id).filter(z => manager || Number(z.user_id) === Number(req.user.id)),
    })),
  });
});

router.post('/', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  const bereich = monatsBereich(req.body && req.body.month);
  if (!bereich) return res.status(400).json({ error: 'Ungültiger Monat (erwartet JJJJ-MM)' });

  // Lückenlos — sonst entstünden Zeiträume ohne Beleg, und die Rechenbasis würde einen
  // ungeprüften Monat überspringen.
  const erwartet = naechsterMonat(db);
  if (erwartet && req.body.month !== erwartet) {
    return res.status(409).json({
      error: `Als nächstes muss ${erwartet} abgeschlossen werden — Zeiträume dürfen keine Lücken haben.`,
    });
  }

  // Nur vollständig vergangene Monate: ein laufender Monat wäre morgen schon falsch.
  const heute = berlinNow().slice(0, 10);
  if (bereich.bis >= heute) {
    return res.status(409).json({ error: 'Der Monat ist noch nicht vorbei.' });
  }

  const offen = offeneAntraege(db, bereich.von, bereich.bis);
  if (offen.length) {
    return res.status(409).json({
      error: `${offen.length} Antrag/Anträge im Zeitraum sind noch nicht entschieden. ` +
             `Bitte zuerst genehmigen oder ablehnen.`,
      offen: offen.map(o => ({ id: o.id, name: o.name, typ: o.type, von: o.date_from, bis: o.date_to })),
    });
  }

  const { closureId, zeilen } = abschliessen(db, bereich, req.user);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_create',
    details: `Abrechnung abgeschlossen: ${bereich.titel} (${zeilen.length} Mitarbeiter)`, ip: req.ip,
  });

  res.status(201).json({ id: closureId, periodFrom: bereich.von, periodTo: bereich.bis, anzahl: zeilen.length });
});

// Was hat sich seit dem Abschluss an diesem Zeitraum verändert? Das ist der Ausweis für
// nachträgliche Korrekturen: Der Saldo des Mitarbeiters bleibt auf dem bezahlten Stand, die
// Differenz wird hier sichtbar — damit sie bewusst nachgemeldet werden kann statt still zu wirken.
router.get('/:id/abweichung', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM payroll_closures WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Abschluss nicht gefunden' });

  const titel = `${p.period_from} – ${p.period_to}`;
  const jetzt = lohnZeilen(db, p.period_from, p.period_to, titel);
  const jetztNach = new Map(jetzt.map(z => [Number(z.userId), z]));

  const abweichungen = [];
  for (const alt of zeilenVon(db, p.id)) {
    const neu = jetztNach.get(Number(alt.user_id));
    const diffs = {};
    for (const feld of ZEILEN_FELDER) {
      const spalte = feld === 'ueberstundenGesamt' ? 'ueberstunden_gesamt' : feld;
      const a = Number(alt[spalte]) || 0;
      const b = neu ? (Number(neu[feld]) || 0) : 0;
      const d = Math.round((b - a) * 100) / 100;
      if (d !== 0) diffs[feld] = { bezahlt: a, jetzt: b, differenz: d };
    }
    if (Object.keys(diffs).length) {
      abweichungen.push({ userId: alt.user_id, name: alt.name, felder: diffs, entfernt: !neu });
    }
  }
  res.json({ id: p.id, periodFrom: p.period_from, periodTo: p.period_to, abweichungen });
});

// Aufheben: nur Admin, nur der LETZTE Abschluss, nur mit Begründung. Der letzte deshalb, weil
// ein Loch in der Mitte die Rechenbasis aller späteren Zeiträume unterlaufen würde.
router.delete('/:id', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur der Administrator darf einen Abschluss aufheben.' });

  const grund = String((req.body && req.body.reason) || '').trim();
  if (grund.length < MIN_GRUND) return res.status(400).json({ error: 'Bitte eine Begründung angeben.' });

  const p = db.prepare('SELECT * FROM payroll_closures WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Abschluss nicht gefunden' });
  const letzter = db.prepare('SELECT id FROM payroll_closures ORDER BY period_to DESC LIMIT 1').get();
  if (!letzter || Number(letzter.id) !== Number(p.id)) {
    return res.status(409).json({ error: 'Es lässt sich nur der zuletzt abgeschlossene Zeitraum wieder öffnen.' });
  }

  db.prepare('DELETE FROM payroll_closure_rows WHERE closure_id = ?').run(p.id);
  db.prepare('DELETE FROM payroll_closures WHERE id = ?').run(p.id);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_reopen',
    details: `Abschluss ${deDatum(p.period_from)}–${deDatum(p.period_to)} aufgehoben. Grund: ${grund}`,
    ip: req.ip,
  });
  res.json({ success: true });
});

module.exports = router;
module.exports.naechsterMonat = naechsterMonat;
module.exports.offeneAntraege = offeneAntraege;
module.exports.abschliessen = abschliessen;
