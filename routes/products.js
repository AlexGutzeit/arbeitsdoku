// Produktverzeichnis für die Bestellungen: Kategorien, Produkte, Barcodes.
//
// DIE REGEL, an der alles hängt (Alex, 07.09.2026): In den Katalog kommt NUR, was einen Barcode
// hat. Eine getippte Bestellung erzeugt keinen Eintrag. Das hält das Verzeichnis klein und
// vertrauenswürdig — jeder Eintrag ist etwas, das jemand in der Hand hatte und gescannt hat.
//
// Daraus folgt: Ein Produkt hat IMMER mindestens einen Barcode. Den letzten zu entfernen wird
// abgewiesen, auch über den Umweg Zusammenführen. Wer ein Produkt loswerden will, löscht es
// bewusst — es soll nicht als Nebenwirkung eines Klicks verschwinden.
//
// Anlegen darf JEDER, der eine Bestellung anlegen darf — also jeder Mitarbeiter. Wer im Lager vor
// einem unbekannten Barcode steht und nichts tun kann, umgeht die App. Gegen Doppel-Einträge hilft
// nicht das Recht, sondern die Suche: Sie muss beim Tippen so gut treffen, dass Anlegen die
// Ausnahme bleibt.
//
// Pflegen (umbenennen, zusammenführen, löschen) dürfen nur Chef und Admin.

const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit, berlinNow } = require('../audit');
const { broadcast } = require('../sse');

const router = express.Router();

const istPfleger = (u) => u && (u.role === 'admin' || u.role === 'chef');

/**
 * Vergleichsform eines Namens: klein, ohne Leerzeichen, Bindestriche und Satzzeichen.
 *
 * Damit findet die Suche „Kabelbinder", „kabelbinder" und „kabel-binder" als dasselbe — genau die
 * Doppel, die sonst entstehen. Wird beim Anlegen als Warnung genutzt, NICHT als Verbot: Es kann
 * zwei Produkte geben, die sich nur in der Schreibweise unterscheiden und trotzdem verschieden
 * sind.
 */
function vergleichsform(name) {
  return String(name || '').toLowerCase().replace(/[\s\-_.,/()]/g, '');
}

const KAT_FELDER = 'id, name, created_at, created_by';

function produktMitCodes(db, id) {
  const p = db.prepare(
    `SELECT p.*, k.name AS kategorie_name
       FROM products p LEFT JOIN product_categories k ON k.id = p.category_id
      WHERE p.id = ?`
  ).get(id);
  if (!p) return null;
  p.barcodes = db.prepare('SELECT code FROM product_barcodes WHERE product_id = ? ORDER BY id').all(id).map(r => r.code);
  return p;
}

// ── Katalog am Stück: für die Spiegelung aufs Gerät ──────────────────────────────────────────
// Ein Aufruf statt drei, damit die App im Lager auch bei wackliger Verbindung in einem Zug fertig
// wird. Geloeschte Eintraege bleiben draussen.
router.get('/katalog', authenticate, (req, res) => {
  const db = getDb();
  const kategorien = db.prepare(
    `SELECT ${KAT_FELDER} FROM product_categories WHERE deleted_at IS NULL ORDER BY name`
  ).all();
  const produkte = db.prepare(
    `SELECT p.id, p.name, p.category_id, p.default_unit
       FROM products p WHERE p.deleted_at IS NULL ORDER BY p.name`
  ).all();
  const codes = db.prepare(
    `SELECT b.product_id, b.code FROM product_barcodes b
       JOIN products p ON p.id = b.product_id WHERE p.deleted_at IS NULL`
  ).all();
  const nach = {};
  for (const c of codes) (nach[c.product_id] = nach[c.product_id] || []).push(c.code);
  for (const p of produkte) p.barcodes = nach[p.id] || [];
  res.json({ kategorien, produkte, stand: berlinNow() });
});

// ── Einen Barcode nachschlagen ───────────────────────────────────────────────────────────────
router.get('/barcode/:code', authenticate, (req, res) => {
  const db = getDb();
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Kein Code angegeben' });

  const treffer = db.prepare('SELECT product_id FROM product_barcodes WHERE code = ?').get(code);
  if (!treffer) return res.json({ gefunden: false, code });

  const p = produktMitCodes(db, treffer.product_id);
  // Geloeschtes Produkt: NICHT still wiederherstellen und NICHT still ein Doppel anlegen — beides
  // waere eine Entscheidung, die dem Benutzer gehoert. Die App fragt.
  if (p && p.deleted_at) {
    return res.json({ gefunden: false, code, geloeschtes_produkt: { id: p.id, name: p.name } });
  }
  res.json({ gefunden: true, code, produkt: p });
});

// ── Suche für die Live-Filterung ─────────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const q = vergleichsform(req.query.q);
  const kat = req.query.category_id ? Number(req.query.category_id) : null;
  let sql = `SELECT p.id, p.name, p.category_id, p.default_unit, k.name AS kategorie_name
               FROM products p LEFT JOIN product_categories k ON k.id = p.category_id
              WHERE p.deleted_at IS NULL`;
  const werte = [];
  if (kat) { sql += ' AND p.category_id = ?'; werte.push(kat); }
  sql += ' ORDER BY p.name';
  let produkte = db.prepare(sql).all(...werte);
  // Gefiltert wird in JS ueber die Vergleichsform — SQL LIKE kaeme mit Bindestrichen und
  // Grossschreibung nicht zurecht, und genau daran entstehen die Doppel.
  if (q) produkte = produkte.filter(p => vergleichsform(p.name).includes(q));
  res.json({ produkte });
});

// ── Kategorien ───────────────────────────────────────────────────────────────────────────────
router.get('/kategorien', authenticate, (req, res) => {
  const db = getDb();
  res.json({ kategorien: db.prepare(
    `SELECT ${KAT_FELDER} FROM product_categories WHERE deleted_at IS NULL ORDER BY name`
  ).all() });
});

router.post('/kategorien', authenticate, (req, res) => {
  const db = getDb();
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Namen mit mindestens 2 Zeichen angeben.' });

  const vorhanden = db.prepare('SELECT id, name FROM product_categories WHERE deleted_at IS NULL').all()
    .find(k => vergleichsform(k.name) === vergleichsform(name));
  if (vorhanden) {
    return res.status(409).json({ error: `Die Kategorie „${vorhanden.name}" gibt es schon.`, kategorie: vorhanden });
  }
  const r = db.prepare('INSERT INTO product_categories (name, created_at, created_by) VALUES (?, ?, ?)')
    .run(name, berlinNow(), req.user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_category_create',
    details: `Kategorie angelegt: ${name}`, ip: req.ip });
  broadcast('produkte');
  res.status(201).json({ kategorie: db.prepare(`SELECT ${KAT_FELDER} FROM product_categories WHERE id = ?`).get(r.lastInsertRowid) });
});

// ── Produkt anlegen — NUR MIT BARCODE ────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const name = String(req.body.name || '').trim();
  const code = String(req.body.barcode || '').trim();
  const katId = req.body.category_id ? Number(req.body.category_id) : null;
  const einheit = String(req.body.default_unit || '').trim() || null;

  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Produktnamen mit mindestens 2 Zeichen angeben.' });
  // Die Regel, an der alles haengt: ohne Code kein Katalogeintrag.
  if (!code) {
    return res.status(400).json({
      error: 'Ein Produkt kommt nur mit Barcode ins Verzeichnis. Ohne Code bestellst du wie bisher '
           + 'mit freiem Text — das bleibt möglich und ändert am Verzeichnis nichts.' });
  }
  const belegt = db.prepare(
    `SELECT b.code, p.id, p.name, p.deleted_at FROM product_barcodes b
       JOIN products p ON p.id = b.product_id WHERE b.code = ?`).get(code);
  if (belegt) {
    return res.status(409).json({
      error: `Dieser Barcode gehört bereits zu „${belegt.name}".`,
      produkt: { id: belegt.id, name: belegt.name, geloescht: !!belegt.deleted_at } });
  }
  if (katId && !db.prepare('SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(katId)) {
    return res.status(400).json({ error: 'Kategorie nicht gefunden' });
  }

  const jetzt = berlinNow();
  const r = db.prepare(
    'INSERT INTO products (name, category_id, default_unit, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, katId, einheit, jetzt, req.user.id);
  db.prepare('INSERT INTO product_barcodes (product_id, code, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(r.lastInsertRowid, code, jetzt, req.user.id);

  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_create',
    details: `Produkt angelegt: ${name} (Barcode ${code})`, ip: req.ip });
  broadcast('produkte');

  // Aehnliche Namen mitliefern — als HINWEIS, nicht als Verbot. Wer gleich sieht, dass es
  // „Kabelbinder" schon gibt, legt kein zweites an; verbieten koennte man es nicht, denn zwei
  // aehnlich benannte Produkte duerfen verschieden sein.
  const aehnlich = db.prepare('SELECT id, name FROM products WHERE deleted_at IS NULL AND id != ?')
    .all(r.lastInsertRowid)
    .filter(p => vergleichsform(p.name) === vergleichsform(name));
  res.status(201).json({ produkt: produktMitCodes(db, r.lastInsertRowid), aehnliche: aehnlich });
});

// ── Weiteren Barcode an ein bestehendes Produkt hängen (der Sinn von 1:n) ────────────────────
router.post('/:id/barcodes', authenticate, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const code = String(req.body.code || '').trim();
  const p = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  if (!code) return res.status(400).json({ error: 'Kein Code angegeben' });

  const belegt = db.prepare(
    `SELECT p.id, p.name FROM product_barcodes b JOIN products p ON p.id = b.product_id
      WHERE b.code = ?`).get(code);
  if (belegt) {
    if (belegt.id === id) return res.status(409).json({ error: 'Dieser Barcode hängt bereits an diesem Produkt.' });
    return res.status(409).json({ error: `Dieser Barcode gehört bereits zu „${belegt.name}".`, produkt: belegt });
  }
  db.prepare('INSERT INTO product_barcodes (product_id, code, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(id, code, berlinNow(), req.user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_barcode_add',
    details: `Barcode ${code} an „${p.name}" angelernt`, ip: req.ip });
  broadcast('produkte');
  res.status(201).json({ produkt: produktMitCodes(db, id) });
});

// ── Barcode entfernen — aber nie den letzten ─────────────────────────────────────────────────
router.delete('/:id/barcodes/:code', authenticate, (req, res) => {
  if (!istPfleger(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const id = Number(req.params.id);
  const code = String(req.params.code || '').trim();
  const p = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });

  const codes = db.prepare('SELECT code FROM product_barcodes WHERE product_id = ?').all(id).map(r => r.code);
  if (!codes.includes(code)) return res.status(404).json({ error: 'Dieser Barcode gehört nicht zu diesem Produkt.' });
  if (codes.length <= 1) {
    return res.status(409).json({
      error: 'Das ist der letzte Barcode. Ein Produkt im Verzeichnis muss mindestens einen haben — '
           + 'sonst wäre es weder scannbar noch auffindbar. Wenn es weg soll, lösche das Produkt.' });
  }
  db.prepare('DELETE FROM product_barcodes WHERE product_id = ? AND code = ?').run(id, code);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_barcode_remove',
    details: `Barcode ${code} von „${p.name}" entfernt`, ip: req.ip });
  broadcast('produkte');
  res.json({ produkt: produktMitCodes(db, id) });
});

module.exports = router;
module.exports.vergleichsform = vergleichsform;
