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
const { abgerechnetBis, deDatum, MIN_GRUND, tagDanach, korrekturenZuAbschluss,
  nachtraegeImZeitraum, monatLabel } = require('../abschluss');

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

/**
 * Was hat sich seit dem Abschluss an diesem Zeitraum verändert — und wie viel davon ist noch
 * NICHT übernommen?
 *
 * Die offene Differenz ist der springende Punkt: Trägt der Administrator vier Stunden nach, sind
 * die zwar sichtbar, aber sie stecken in keinem Überstundenstand und würden nie bezahlt. Erst die
 * Übernahme bucht sie in den laufenden Zeitraum.
 *
 * Gerechnet wird auf dem SALDO (Ist minus Soll): Eine nachgetragene Abwesenheit verschiebt das
 * Soll, ein nachgetragener Eintrag das Ist — für den Überstundenstand zählt die Differenz beider.
 */
function abweichungen(db, closure) {
  const titel = `${closure.period_from} – ${closure.period_to}`;
  const jetzt = new Map(lohnZeilen(db, closure.period_from, closure.period_to, titel)
    .map(z => [Number(z.userId), z]));
  const gebucht = {}; const gruende = {};
  for (const k of korrekturenZuAbschluss(db, closure.id)) {
    const uid = Number(k.user_id);
    gebucht[uid] = (gebucht[uid] || 0) + (Number(k.stunden) || 0);
    if (k.grund) (gruende[uid] || (gruende[uid] = [])).push(k.grund);
  }

  const liste = [];
  for (const alt of zeilenVon(db, closure.id)) {
    const uid = Number(alt.user_id);
    const neu = jetzt.get(uid);
    const felder = {};
    for (const feld of ZEILEN_FELDER) {
      const spalte = feld === 'ueberstundenGesamt' ? 'ueberstunden_gesamt' : feld;
      const a = Number(alt[spalte]) || 0;
      const b = neu ? (Number(neu[feld]) || 0) : 0;
      const d = Math.round((b - a) * 100) / 100;
      if (d !== 0) felder[feld] = { bezahlt: a, jetzt: b, differenz: d };
    }
    const saldoDiff = Math.round(((neu ? Number(neu.saldo) || 0 : 0) - (Number(alt.saldo) || 0)) * 100) / 100;
    const offen = Math.round((saldoDiff - (gebucht[uid] || 0)) * 100) / 100;
    if (Object.keys(felder).length || offen !== 0 || gebucht[uid]) {
      liste.push({
        userId: alt.user_id, name: alt.name, felder, entfernt: !neu,
        saldoDifferenz: saldoDiff, uebernommen: gebucht[uid] || 0, offen,
        kommentar: (gruende[uid] || []).join(' · '),
      });
    }
  }
  return liste;
}

const zahlDe = (n) => (n > 0 ? '+' : '') + String(Math.round(Number(n) * 100) / 100).replace('.', ',');

function nachtragsHinweis(treffer) {
  const namen = [...new Set(treffer.flatMap(t => t.betroffen.map(b => b.name)))];
  return `In bereits abgeschlossenen Zeiträumen wurde nachträglich etwas geändert `
    + `(${namen.join(', ')}). Diese Differenzen müssen erst übernommen oder verworfen werden — `
    + `sonst gingen die Stunden verloren.`;
}
function nachtragsListe(treffer) {
  return treffer.map(t => ({
    id: t.closure.id, periodFrom: t.closure.period_from, periodTo: t.closure.period_to,
    betroffen: t.betroffen.map(b => ({ name: b.name, offen: b.offen })),
  }));
}

/** Alle Zeiträume mit noch nicht übernommener Differenz — blockiert den nächsten Abschluss. */
function offeneDifferenzen(db) {
  const treffer = [];
  for (const p of perioden(db)) {
    const betroffen = abweichungen(db, p).filter(a => a.offen !== 0);
    if (betroffen.length) treffer.push({ closure: p, betroffen });
  }
  return treffer;
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
    // Eigene uebernommene Nachtraege MIT Herkunft: Der Mitarbeiter soll nicht raetseln, warum sein
    // Stand ploetzlich hoeher ist als die Summe seiner Monate.
    nachtraege: nachtraegeImZeitraum(db, req.user.id, '0000-01-01', '9999-12-31').map(n => ({
      stunden: n.stunden, wirksamAb: n.wirksam_ab, grund: n.grund || '',
      herkunft: monatLabel(n.period_from), uebernommenVon: n.created_by_name, uebernommenAm: n.created_at,
    })),
    perioden: alle.map(p => {
      // Offene Nachtraege mitliefern: Der Mitarbeiter soll auf seiner Statistik sehen, dass sein
      // Stand eine noch nicht uebernommene Korrektur NICHT enthaelt — sonst waere der Widerspruch
      // zwischen Monats- und Gesamtzahl unerklaerlich.
      const abw = abweichungen(db, p);
      const meine = abw.filter(a => Number(a.userId) === Number(req.user.id));
      return {
        id: p.id, periodFrom: p.period_from, periodTo: p.period_to,
        closedAt: p.closed_at, closedByName: p.closed_by_name,
        zeilen: zeilenVon(db, p.id).filter(z => manager || Number(z.user_id) === Number(req.user.id)),
        offenGesamt: Math.round((manager ? abw : meine).reduce((sum, a) => sum + a.offen, 0) * 100) / 100,
      };
    }),
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

  const nachtraege = offeneDifferenzen(db);
  if (nachtraege.length) return res.status(409).json({ error: nachtragsHinweis(nachtraege), nachtraege: nachtragsListe(nachtraege) });

  const { closureId, zeilen } = abschliessen(db, bereich, req.user);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_create',
    details: `Abrechnung abgeschlossen: ${bereich.titel} (${zeilen.length} Mitarbeiter)`, ip: req.ip,
  });

  res.status(201).json({ id: closureId, periodFrom: bereich.von, periodTo: bereich.bis, anzahl: zeilen.length });
});

// Mehrere Monate am Stück abschließen, bis einschließlich `month`.
//
// Gedacht für den Fall, dass spät angefangen wird: Abschlüsse müssen lückenlos sein, also müsste
// man sich sonst Monat für Monat vorarbeiten. Hier wird dieselbe Prüfung je Monat angewandt und
// beim ersten Hindernis angehalten — abgeschlossen ist dann alles davor, und die Meldung sagt,
// woran es lag. Ein stilles Überspringen gäbe es nie: das würde eine Lücke erzeugen.
router.post('/bis', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  const ziel = monatsBereich(req.body && req.body.month);
  if (!ziel) return res.status(400).json({ error: 'Ungültiger Monat (erwartet JJJJ-MM)' });

  const heute = berlinNow().slice(0, 10);
  const erledigt = [];
  let hindernis = null;

  for (let schutz = 0; schutz < 120; schutz++) {
    const m = naechsterMonat(db);
    if (!m || m > req.body.month) break;
    const b = monatsBereich(m);
    if (!b) { hindernis = `Monat ${m} ist unlesbar.`; break; }
    if (b.bis >= heute) { hindernis = `${b.titel} ist noch nicht vorbei.`; break; }
    const offen = offeneAntraege(db, b.von, b.bis);
    if (offen.length) {
      hindernis = `${b.titel}: ${offen.length} Antrag/Anträge sind noch nicht entschieden `
        + `(${offen.map(o => o.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).`;
      break;
    }
    const nachtraege = offeneDifferenzen(db);
    if (nachtraege.length) { hindernis = nachtragsHinweis(nachtraege); break; }
    const { zeilen } = abschliessen(db, b, req.user);
    erledigt.push({ monat: m, titel: b.titel, anzahl: zeilen.length });
    logAudit(db, {
      userId: req.user.id, username: req.user.username, action: 'closure_create',
      details: `Abrechnung abgeschlossen: ${b.titel} (${zeilen.length} Mitarbeiter)`, ip: req.ip,
    });
  }

  if (!erledigt.length && hindernis) return res.status(409).json({ error: hindernis });
  res.status(erledigt.length ? 201 : 200).json({ erledigt, hindernis, bis: abgerechnetBis(db) });
});

// Was hat sich seit dem Abschluss an diesem Zeitraum verändert? Das ist der Ausweis für
// nachträgliche Korrekturen: Der Saldo des Mitarbeiters bleibt auf dem bezahlten Stand, die
// Differenz wird hier sichtbar — damit sie bewusst nachgemeldet werden kann statt still zu wirken.
router.get('/:id/abweichung', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM payroll_closures WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Abschluss nicht gefunden' });

  const liste = abweichungen(db, p);
  res.json({
    id: p.id, periodFrom: p.period_from, periodTo: p.period_to,
    abweichungen: liste,
    offenGesamt: Math.round(liste.reduce((s, a) => s + a.offen, 0) * 100) / 100,
  });
});

/**
 * Die Differenz übernehmen: Sie wird als Korrektur ab dem laufenden Zeitraum gebucht und geht
 * damit in den nächsten Lohn-Export. Der festgehaltene Zeitraum bleibt als Beleg unverändert —
 * bezahlt wurde damals, was damals bezahlt wurde.
 *
 * Ohne diesen Schritt wären nachgetragene Stunden zwar sichtbar, aber niemand bekäme sie je.
 */
router.post('/:id/uebernehmen', authenticate, authorize('admin', 'chef', 'buchhalter'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT * FROM payroll_closures WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Abschluss nicht gefunden' });

  const offen = abweichungen(db, p).filter(a => a.offen !== 0);
  if (!offen.length) return res.status(409).json({ error: 'Für diesen Zeitraum gibt es keine offene Differenz.' });

  // Kommentar ist Pflicht: Im Folgemonat tauchen sonst Stunden auf, die niemand zuordnen kann —
  // im Lohn-Export, beim Mitarbeiter und im Protokoll steht deshalb IMMER, wofuer sie sind.
  const grundRoh = String((req.body && req.body.reason) || '').trim();
  if (grundRoh.length < MIN_GRUND) {
    return res.status(400).json({ error: 'Bitte einen Kommentar angeben — er erscheint im Lohn-Export und beim Mitarbeiter.' });
  }

  // Wirksam ab dem Tag nach dem LETZTEN Stichtag — dort liegt der noch offene Zeitraum. Nicht ab
  // dem Ende dieser Periode: dazwischen koennen weitere Monate abgeschlossen sein, deren Zahlen
  // ebenfalls feststehen und sich nicht mehr aendern duerfen.
  const wirksamAb = tagDanach(abgerechnetBis(db));
  const grund = grundRoh;
  const ins = db.prepare(
    `INSERT INTO payroll_adjustments (closure_id, user_id, name, stunden, wirksam_ab, grund, created_at, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const a of offen) {
    ins.run(p.id, a.userId, a.name, a.offen, wirksamAb, grund, berlinNow(), req.user.id, req.user.name || req.user.username);
  }

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_adjust',
    details: `Nachträge aus ${deDatum(p.period_from)}–${deDatum(p.period_to)} übernommen, wirksam ab `
      + `${deDatum(wirksamAb)}: ` + offen.map(a => `${a.name} ${zahlDe(a.offen)} h`).join(', ')
      + `. Kommentar: ${grund}`,
    ip: req.ip,
  });
  res.json({ uebernommen: offen.map(a => ({ name: a.name, stunden: a.offen })), wirksamAb, grund });
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

  // Übernommene Nachträge dieses Zeitraums MÜSSEN mit weg. Sie wurden nur gebucht, WEIL der
  // Zeitraum eingefroren war und seine Einträge nicht mehr zählten. Ist er wieder offen, zählen
  // sie erneut direkt mit — die Korrektur daneben wäre dieselbe Zeit ein zweites Mal.
  // Gemessen in tests/abschluss-haerte.js: ohne diese Zeile 4 h zu viel.
  const nachtraege = korrekturenZuAbschluss(db, p.id);
  const summe = Math.round(nachtraege.reduce((s, n) => s + (Number(n.stunden) || 0), 0) * 100) / 100;
  db.prepare('DELETE FROM payroll_adjustments WHERE closure_id = ?').run(p.id);
  db.prepare('DELETE FROM payroll_closure_rows WHERE closure_id = ?').run(p.id);
  db.prepare('DELETE FROM payroll_closures WHERE id = ?').run(p.id);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'closure_reopen',
    details: `Abschluss ${deDatum(p.period_from)}–${deDatum(p.period_to)} aufgehoben. Grund: ${grund}`
      + (nachtraege.length ? ` — dabei ${nachtraege.length} übernommene(r) Nachtrag/Nachträge über `
        + `${zahlDe(summe)} h zurückgenommen (der Zeitraum zählt jetzt wieder direkt).` : ''),
    ip: req.ip,
  });
  res.json({ success: true, nachtraegeZurueckgenommen: nachtraege.length, stunden: summe });
});

module.exports = router;
module.exports.naechsterMonat = naechsterMonat;
module.exports.offeneAntraege = offeneAntraege;
module.exports.abschliessen = abschliessen;
