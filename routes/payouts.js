// Überstunden auszahlen.
//
// Verlässt jemand die Firma — oder ist am Jahresende einfach zu viel aufgelaufen —, gibt es drei
// Wege: abfeiern, stehen lassen, auszahlen. Die ersten beiden konnte die App längst. Der dritte
// ist der einzige, bei dem Stunden verschwinden müssen, ohne dass jemand gearbeitet hat.
//
// Ohne diesen Weg behalf man sich mit einem Nachtrag über den Monatsabschluss. Das ist die falsche
// Schublade: Ein Nachtrag heißt „hier fehlten Stunden", eine Auszahlung heißt „diese Stunden sind
// mit Geld abgegolten". Im Lohn-Export landeten beide in denselben Spalten und wären für das
// Lohnbüro nicht mehr auseinanderzuhalten.
//
// KEIN Geldbetrag, kein Stundensatz: Die App liefert Stunden, das Lohnbüro rechnet.

const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit, berlinNow } = require('../audit');
const { broadcast } = require('../sse');
const { abgerechnetBis, tagDanach, MIN_GRUND, deDatum } = require('../abschluss');
const { stundenFuerZeitraum } = require('./user-hours');
const {
  OFFEN, BESTAETIGT, ABGELEHNT, ZURUECKGEZOGEN,
  BELEG_APP, BELEG_UNTERSCHRIFT, offeneSumme,
} = require('../auszahlung');

const router = express.Router();

const istManager = (u) => u && (u.role === 'admin' || u.role === 'chef');
const heuteIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

function nutzer(db, id) {
  return db.prepare('SELECT id, name, username, start_overtime FROM users WHERE id = ?').get(Number(id));
}

/** Aktueller Überstundenstand — dieselbe Rechnung wie überall sonst. */
function standVon(db, u) {
  const tag = heuteIso();
  return stundenFuerZeitraum(db, u.id, tag, tag, u.start_overtime).ueberstundenGesamt;
}

/**
 * Wunschtag auf den ersten noch offenen Tag ziehen, wenn er in einem abgeschlossenen Monat liegt.
 *
 * Alex' Entscheidung (06.09.2026): NICHT abweisen und NICHT rückwirkend verbuchen. Ein Abschluss,
 * der sich nachträglich bewegt, ist das Gegenteil von revisionssicher — die Zahlen gingen längst
 * ans Lohnbüro. Abweisen wäre die andere schlechte Antwort: Der Chef müsste raten, welcher Tag
 * erlaubt ist. Also ziehen, und den ursprünglichen Wunsch ins Protokoll schreiben.
 */
function wirksamAbZiehen(db, wunsch) {
  const bis = abgerechnetBis(db);
  if (bis && String(wunsch) <= String(bis)) {
    return { wirksamAb: tagDanach(bis), gezogenVon: String(wunsch), abschlussBis: bis };
  }
  return { wirksamAb: String(wunsch), gezogenVon: null, abschlussBis: bis };
}

function zeile(db, id) {
  return db.prepare('SELECT * FROM overtime_payouts WHERE id = ?').get(Number(id));
}

/** Eine Zeile so, wie die Oberfläche sie braucht. */
function fuerAnzeige(z, name) {
  return {
    id: z.id, user_id: z.user_id, name: name || null,
    stunden: Number(z.stunden), wirksam_ab: z.wirksam_ab,
    status: z.status, grund: z.grund || '',
    belegweg: z.belegweg,
    // Ausdrücklich mitgeliefert, damit keine Anzeigestelle es vergessen kann: Eine Zustimmung,
    // die nicht vom Mitarbeiter selbst kommt, darf nirgends wie eine aussehen.
    per_unterschrift: z.belegweg === BELEG_UNTERSCHRIFT,
    created_at: z.created_at, created_by_name: z.created_by_name || '',
    entschieden_am: z.entschieden_am || null, entschieden_von_name: z.entschieden_von_name || '',
  };
}

// ── Liste ────────────────────────────────────────────────────────────────────────────────────
// Manager sehen alles (oder gefiltert), Mitarbeiter ausschliesslich sich selbst.
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const manager = istManager(req.user);
  const gefragt = req.query.user_id ? Number(req.query.user_id) : null;
  if (!manager && gefragt && gefragt !== req.user.id) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }
  const uid = manager ? gefragt : req.user.id;

  const rows = uid
    ? db.prepare(`SELECT p.*, u.name FROM overtime_payouts p LEFT JOIN users u ON u.id = p.user_id
                   WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(uid)
    : db.prepare(`SELECT p.*, u.name FROM overtime_payouts p LEFT JOIN users u ON u.id = p.user_id
                   ORDER BY p.created_at DESC, p.id DESC`).all();

  res.json({ auszahlungen: rows.map(z => fuerAnzeige(z, z.name)) });
});

// ── Anlegen (Chef/Admin) ─────────────────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  if (!istManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();

  const uid = Number(req.body.user_id);
  const stunden = Math.round((Number(req.body.stunden) || 0) * 100) / 100;
  const wunsch = String(req.body.wirksam_ab || heuteIso()).slice(0, 10);
  const belegweg = req.body.belegweg === BELEG_UNTERSCHRIFT ? BELEG_UNTERSCHRIFT : BELEG_APP;

  const u = nutzer(db, uid);
  if (!u) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
  if (!(stunden > 0)) return res.status(400).json({ error: 'Bitte eine Stundenzahl größer als 0 angeben.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wunsch)) return res.status(400).json({ error: 'Ungültiges Datum.' });
  if (db.prepare('SELECT id FROM overtime_payouts WHERE user_id = ? AND status = ?').get(uid, OFFEN)) {
    return res.status(409).json({ error: 'Für diesen Mitarbeiter ist bereits eine Auszahlung offen.' });
  }

  const { wirksamAb, gezogenVon, abschlussBis } = wirksamAbZiehen(db, wunsch);

  // Mehr Stunden als vorhanden: WARNEN, aber zulassen (Alex, 06.09.2026). Ein Minus kann gewollt
  // sein, wenn nebenher etwas anderes verrechnet wurde — Abweisen machte diesen Fall unmöglich.
  const stand = standVon(db, u);
  const warnungen = [];
  if (stunden > stand) {
    warnungen.push(`Das sind mehr Stunden als der aktuelle Stand (${stand.toLocaleString('de-DE')} h). `
      + `Der Überstundenstand geht dadurch ins Minus.`);
  }
  if (gezogenVon) {
    warnungen.push(`Der ${deDatum(gezogenVon)} liegt in einem bereits abgeschlossenen Zeitraum `
      + `(bis ${deDatum(abschlussBis)}). Die Auszahlung wirkt deshalb ab ${deDatum(wirksamAb)}.`);
  }

  const jetzt = berlinNow();
  // Der ANZEIGENAME, nicht der Benutzername: In der Karte des Mitarbeiters stand sonst
  // "chef moechte dir ...". Das Protokoll bekommt weiterhin den Benutzernamen (logAudit).
  const anzeigename = (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id) || {}).name
    || req.user.username;
  // Unterschriftsweg: Die Zustimmung liegt schon vor, es gibt nichts mehr zu bestätigen. Sie wird
  // aber ÜBERALL als solche gekennzeichnet — belegweg bleibt 'unterschrift'.
  const direkt = belegweg === BELEG_UNTERSCHRIFT;
  const r = db.prepare(
    `INSERT INTO overtime_payouts
       (user_id, stunden, wirksam_ab, status, belegweg, created_at, created_by, created_by_name,
        entschieden_am, entschieden_von, entschieden_von_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uid, stunden, wirksamAb, direkt ? BESTAETIGT : OFFEN, belegweg, jetzt,
    req.user.id, anzeigename,
    direkt ? jetzt : null, direkt ? req.user.id : null, direkt ? anzeigename : null);

  logAudit(db, {
    userId: req.user.id, username: req.user.username,
    action: direkt ? 'overtime_payout_signed' : 'overtime_payout_create',
    details: `${u.name}: ${stunden} h zur Auszahlung, wirksam ab ${wirksamAb}`
      + (gezogenVon ? ` (gewünscht war ${gezogenVon}, in den Abschluss bis ${abschlussBis} gefallen)` : '')
      + (direkt ? ' · Zustimmung liegt unterschrieben vor' : ''),
    ip: req.ip,
  });

  // Damit der Zaehler beim Mitarbeiter SOFORT erscheint und nicht erst beim naechsten Laden — er
  // soll ueber eine Entscheidung, die seine Stunden betrifft, nicht zufaellig stolpern.
  broadcast('payouts');
  res.status(201).json({ success: true, auszahlung: fuerAnzeige(zeile(db, r.lastInsertRowid), u.name), warnungen });
});

// ── Bestätigen / Ablehnen (der Mitarbeiter selbst) ───────────────────────────────────────────
// Der Verzicht auf Stunden ist die Entscheidung des Mitarbeiters, keine Verwaltungshandlung.
// Deshalb kann hier AUSDRÜCKLICH kein Manager für ihn handeln — auch der Admin nicht. Wer eine
// unterschriebene Zustimmung hat, legt sie beim Anlegen mit belegweg='unterschrift' an; sie ist
// dann überall als solche erkennbar.
function entscheiden(req, res, neuerStatus) {
  const db = getDb();
  const z = zeile(db, req.params.id);
  if (!z) return res.status(404).json({ error: 'Auszahlung nicht gefunden' });
  if (z.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Nur der betroffene Mitarbeiter kann das entscheiden.' });
  }
  if (z.status !== OFFEN) return res.status(409).json({ error: 'Diese Auszahlung ist bereits entschieden.' });

  const grund = String(req.body.grund || '').trim();
  if (neuerStatus === ABGELEHNT && grund.length < MIN_GRUND) {
    return res.status(400).json({ error: `Bitte einen Grund angeben (mindestens ${MIN_GRUND} Zeichen).` });
  }

  db.prepare(
    'UPDATE overtime_payouts SET status = ?, grund = ?, entschieden_am = ?, entschieden_von = ?, entschieden_von_name = ? WHERE id = ?'
  ).run(neuerStatus, neuerStatus === ABGELEHNT ? grund : null, berlinNow(), req.user.id, req.user.username, z.id);

  logAudit(db, {
    userId: req.user.id, username: req.user.username,
    action: neuerStatus === BESTAETIGT ? 'overtime_payout_confirm' : 'overtime_payout_reject',
    details: `${z.stunden} h zur Auszahlung (wirksam ab ${z.wirksam_ab}) ${neuerStatus === BESTAETIGT ? 'bestätigt' : 'abgelehnt'}`
      + (grund ? `: ${grund}` : ''),
    ip: req.ip,
  });

  broadcast('payouts');
  res.json({ success: true, auszahlung: fuerAnzeige(zeile(db, z.id)) });
}

router.post('/:id/bestaetigen', authenticate, (req, res) => entscheiden(req, res, BESTAETIGT));
router.post('/:id/ablehnen', authenticate, (req, res) => entscheiden(req, res, ABGELEHNT));

// ── Zurückziehen (Chef/Admin) ────────────────────────────────────────────────────────────────
router.post('/:id/zurueckziehen', authenticate, (req, res) => {
  if (!istManager(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const z = zeile(db, req.params.id);
  if (!z) return res.status(404).json({ error: 'Auszahlung nicht gefunden' });
  if (z.status !== OFFEN) return res.status(409).json({ error: 'Nur eine offene Auszahlung kann zurückgezogen werden.' });

  db.prepare(
    'UPDATE overtime_payouts SET status = ?, entschieden_am = ?, entschieden_von = ?, entschieden_von_name = ? WHERE id = ?'
  ).run(ZURUECKGEZOGEN, berlinNow(), req.user.id, req.user.username, z.id);

  logAudit(db, {
    userId: req.user.id, username: req.user.username, action: 'overtime_payout_withdraw',
    details: `${z.stunden} h zur Auszahlung (wirksam ab ${z.wirksam_ab}) zurückgezogen`,
    ip: req.ip,
  });
  broadcast('payouts');
  res.json({ success: true, auszahlung: fuerAnzeige(zeile(db, z.id)) });
});

// ── Stand + offene Anfrage, für Dialoge ──────────────────────────────────────────────────────
router.get('/stand/:userId', authenticate, (req, res) => {
  const db = getDb();
  const uid = Number(req.params.userId);
  if (!istManager(req.user) && uid !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  const u = nutzer(db, uid);
  if (!u) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
  res.json({ ueberstunden: standVon(db, u), offen: offeneSumme(db, uid) });
});

module.exports = router;
module.exports.wirksamAbZiehen = wirksamAbZiehen;
