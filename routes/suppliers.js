// Großhändler (Alex, 08.09.2026).
//
// Der Händler selbst: Name, Homepage, Kundennummer, Ansprechpartner, Notiz. Was ein EINZELNES
// PRODUKT bei diesem Händler an Bestellnummer, Link und Kommentar hat, steht dagegen in
// product_suppliers und wird über /api/products/:id/haendler gepflegt — zwei verschiedene Dinge,
// zwei verschiedene Wege.
//
// RECHTE, bewusst ohne ein viertes Recht:
//   ANSEHEN   — wer bestellen darf (der Sinn der Sache: der Chef klickt den Link) ODER wer pflegt.
//   AENDERN   — nur can_products („Lagerdaten pflegen", produktrecht.js).
//
// Der Ansprechpartner ist eine echte Person bei einer Fremdfirma. Das ist für einen
// Geschäftskontakt unproblematisch, gehört aber ins Verarbeitungsverzeichnis — deshalb steht es
// hier, damit es beim nächsten Blick in die Datenschutz-Unterlagen nicht übersehen wird.
const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit, berlinNow } = require('../audit');
const { broadcast } = require('../sse');
const { darfProduktePflegen } = require('../produktrecht');
const { darfBestellen } = require('../bestellrecht');
const { linkPruefen } = require('../linkpruefung');

const router = express.Router();

const nurPfleger = (req, res, next) =>
  darfProduktePflegen(req.user) ? next() : res.status(403).json({ error: 'Keine Berechtigung' });
const nurLesen = (req, res, next) =>
  (darfBestellen(req.user) || darfProduktePflegen(req.user))
    ? next() : res.status(403).json({ error: 'Keine Berechtigung' });

const FELDER = ['name', 'homepage', 'kundennummer', 'ansprechpartner', 'telefon', 'email', 'notiz'];
const SPALTEN = 'id, ' + FELDER.join(', ') + ', created_at';

/** Vergleichsform wie bei Produkten/Kategorien — „Sonepar" und „sonepar " sind derselbe Händler. */
function vergleichsform(name) {
  return String(name || '').toLowerCase().replace(/[\s\-_.,/()]/g, '');
}

// ── Liste ───────────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, nurLesen, (req, res) => {
  const db = getDb();
  const haendler = db.prepare(
    `SELECT ${SPALTEN},
            (SELECT COUNT(*) FROM product_suppliers ps
               JOIN products p ON p.id = ps.product_id
              WHERE ps.supplier_id = suppliers.id AND p.deleted_at IS NULL) AS produkte
       FROM suppliers WHERE deleted_at IS NULL ORDER BY name`).all();
  res.json({ haendler });
});

// ── Anlegen ─────────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Händlernamen mit mindestens 2 Zeichen angeben.' });
  const gleich = db.prepare('SELECT id, name FROM suppliers WHERE deleted_at IS NULL').all()
    .find(h => vergleichsform(h.name) === vergleichsform(name));
  if (gleich) return res.status(409).json({ error: `„${gleich.name}" gibt es bereits.`, haendler: gleich });

  const werte = werteLesen(req.body);
  if (werte.fehler) return res.status(400).json({ error: werte.fehler });
  const r = db.prepare(
    `INSERT INTO suppliers (name, homepage, kundennummer, ansprechpartner, telefon, email, notiz, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, werte.homepage, werte.kundennummer, werte.ansprechpartner, werte.telefon, werte.email, werte.notiz,
        berlinNow(), req.user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'supplier_create',
    details: `Großhändler angelegt: ${name}`, ip: req.ip });
  broadcast('produkte');
  res.status(201).json({ haendler: db.prepare(`SELECT ${SPALTEN} FROM suppliers WHERE id = ?`).get(r.lastInsertRowid) });
});

/**
 * Liest die optionalen Felder aus dem Rumpf und prueft dabei die Homepage.
 * Leere Eingaben werden zu NULL — nicht zu "", damit „nichts hinterlegt" EINE Form hat und die
 * Anzeige nicht zwischen leerem Feld und fehlendem Feld unterscheiden muss.
 */
function werteLesen(rumpf) {
  const t = (k, max) => {
    const v = String(rumpf[k] == null ? '' : rumpf[k]).trim();
    if (v.length > max) return { fehler: `„${k}" ist zu lang (höchstens ${max} Zeichen).` };
    return { wert: v || null };
  };
  const aus = {};
  for (const [k, max] of [['kundennummer', 60], ['ansprechpartner', 120], ['telefon', 60],
                          ['email', 160], ['notiz', 2000]]) {
    const r = t(k, max);
    if (r.fehler) return { fehler: r.fehler };
    aus[k] = r.wert;
  }
  const l = linkPruefen(rumpf.homepage);
  if (!l.ok) return { fehler: 'Homepage: ' + l.fehler };
  aus.homepage = l.wert;
  return aus;
}

// ── Aendern ─────────────────────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const h = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!h) return res.status(404).json({ error: 'Großhändler nicht gefunden' });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : h.name;
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Händlernamen mit mindestens 2 Zeichen angeben.' });
  const gleich = db.prepare('SELECT id, name FROM suppliers WHERE deleted_at IS NULL AND id != ?').all(id)
    .find(x => vergleichsform(x.name) === vergleichsform(name));
  if (gleich) return res.status(409).json({ error: `„${gleich.name}" gibt es bereits.`, haendler: gleich });

  // Nur mitgeschickte Felder aendern — sonst leert ein Teilformular still die uebrigen.
  const rumpf = {};
  for (const f of FELDER) rumpf[f] = req.body[f] !== undefined ? req.body[f] : h[f];
  const werte = werteLesen(rumpf);
  if (werte.fehler) return res.status(400).json({ error: werte.fehler });

  db.prepare(`UPDATE suppliers SET name=?, homepage=?, kundennummer=?, ansprechpartner=?, telefon=?, email=?, notiz=? WHERE id=?`)
    .run(name, werte.homepage, werte.kundennummer, werte.ansprechpartner, werte.telefon, werte.email, werte.notiz, id);
  const geaendert = FELDER.filter(f => String(f === 'name' ? name : werte[f] || '') !== String(h[f] || ''));
  if (geaendert.length) logAudit(db, { userId: req.user.id, username: req.user.username,
    action: 'supplier_update', details: `Großhändler „${h.name}" geändert: ${geaendert.join(', ')}`, ip: req.ip });
  broadcast('produkte');
  res.json({ haendler: db.prepare(`SELECT ${SPALTEN} FROM suppliers WHERE id = ?`).get(id) });
});

// ── Loeschen (weich) ────────────────────────────────────────────────────────────────────────
// Weich, und die Produktzuordnungen bleiben stehen: Eine geloeschte Zuordnung waere der stille
// Verlust von Bestellnummern, die jemand einzeln abgetippt hat. Wer den Haendler zurueckholt,
// hat alles wieder.
//
// Haengen noch Produkte dran, wird beim ersten Anlauf ABGEWIESEN und die Zahl genannt — nicht
// weil es technisch noetig waere, sondern weil „Sonepar geloescht" bei 60 hinterlegten
// Bestellnummern eine Entscheidung ist, die man bewusst treffen soll.
router.delete('/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!h) return res.status(404).json({ error: 'Großhändler nicht gefunden' });
  const anzahl = db.prepare(
    `SELECT COUNT(*) AS c FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
      WHERE ps.supplier_id = ? AND p.deleted_at IS NULL`).get(id).c;
  if (anzahl > 0 && !req.body.trotzdem) return res.status(409).json({
    error: `An „${h.name}" hängen ${anzahl} Produkt-Eintrag/-Einträge mit Bestellnummern. `
         + 'Die bleiben erhalten und kommen zurück, wenn der Händler wiederhergestellt wird — '
         + 'bitte bestätige das Löschen.', anzahl });
  db.prepare('UPDATE suppliers SET deleted_at = ? WHERE id = ?').run(berlinNow(), id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'supplier_delete',
    details: `Großhändler gelöscht: ${h.name}` + (anzahl ? ` (${anzahl} Produkt-Eintrag/-Einträge bleiben erhalten)` : ''), ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true, eintraege: anzahl });
});

// ── Was dieser Händler führt ────────────────────────────────────────────────────────────────
//
// Die Gegenrichtung zu /api/products/:id/haendler. Beide Wege sind nötig, weil es zwei
// verschiedene Arbeitsweisen gibt: „Ich habe ein Produkt vor mir, wo bekomme ich es?" — und
// „Ich habe die Preisliste von Sonepar vor mir und trage zwanzig Bestellnummern ein."
// Der zweite Fall war über die Produktliste mühsam (zwanzigmal aufklappen).
router.get('/:id/produkte', authenticate, nurLesen, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: 'Großhändler nicht gefunden' });
  const produkte = db.prepare(`
    SELECT p.id, p.name, ps.bestellnummer, ps.link, ps.kommentar,
           (SELECT COUNT(*) FROM product_barcodes b WHERE b.product_id = p.id) AS barcodes
      FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
     WHERE ps.supplier_id = ? AND p.deleted_at IS NULL
     ORDER BY p.name`).all(id);
  res.json({ haendler: { id: h.id, name: h.name }, produkte });
});

// ── Wiederherstellen ────────────────────────────────────────────────────────────────────────
//
// Das FEHLTE, obwohl die Loeschmeldung es ausdruecklich versprach („Die bleiben erhalten und
// kommen zurueck, wenn der Haendler wiederhergestellt wird"). Gemessen am 09.09.2026: Der Aufruf
// gab 404, und wer denselben Namen neu anlegte, bekam einen NEUEN Haendler — die alten
// Bestellnummern blieben als verwaiste Zeilen in der Datenbank haengen, unsichtbar fuer alle.
// Ein Versprechen, das die App nicht einloest, ist schlimmer als gar keins.
router.post('/:id/wiederherstellen', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, name, deleted_at FROM suppliers WHERE id = ?').get(id);
  if (!h || !h.deleted_at) return res.status(404).json({ error: 'Kein gelöschter Großhändler mit dieser Nummer' });
  // Der Name kann inzwischen neu vergeben sein — dann muesste einer von beiden umbenannt werden.
  // Das ist eine Entscheidung des Benutzers, keine des Programms.
  const belegt = db.prepare('SELECT id, name FROM suppliers WHERE deleted_at IS NULL').all()
    .find(x => vergleichsform(x.name) === vergleichsform(h.name));
  if (belegt) return res.status(409).json({
    error: `Es gibt inzwischen wieder einen Großhändler „${belegt.name}". Benenne einen von beiden `
         + 'um, dann lässt sich dieser zurückholen.', haendler: belegt });
  db.prepare('UPDATE suppliers SET deleted_at = NULL WHERE id = ?').run(id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'supplier_restore',
    details: `Großhändler wiederhergestellt: ${h.name}`, ip: req.ip });
  broadcast('produkte');
  res.json({ haendler: db.prepare(`SELECT ${SPALTEN} FROM suppliers WHERE id = ?`).get(id) });
});

module.exports = router;
module.exports.linkPruefen = linkPruefen;
module.exports.vergleichsform = vergleichsform;
