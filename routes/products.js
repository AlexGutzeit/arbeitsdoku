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
const { darfProduktePflegen } = require('../produktrecht');
const { darfBestellen } = require('../bestellrecht');
const { linkPruefen } = require('../linkpruefung');

const router = express.Router();

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// VERZEICHNIS-PFLEGE (Schritt 5)
//
// Alles hier drin darf nur, wer das Recht hat (produktrecht.js). Anlegen bleibt oben offen.
//
// Der Grundgedanke: Ein Verzeichnis, das im Lager entsteht, wird unordentlich — „Kabelbinder",
// „kabel-binder", „Kabelbinder 200". Das ist kein Bedienfehler, sondern der Normalfall bei
// dreizehn Leuten. Es braucht also kein Verbot beim Anlegen (das umgeht man), sondern ein
// AUFRAEUMEN hinterher.
//
// Was dabei NIE passieren darf: dass eine bereits geschriebene Bestellung ihren Text verliert.
// orders.product ist der massgebliche Text, orders.product_id nur die Verknuepfung. Beim
// Zusammenfuehren wird deshalb die Verknuepfung umgehaengt und der Text nicht angefasst.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const nurPfleger = (req, res, next) =>
  darfProduktePflegen(req.user) ? next() : res.status(403).json({ error: 'Keine Berechtigung' });

/** Findet Namensgleiche (nach Vergleichsform) unter den lebenden Produkten. */
function dublettenGruppen(db) {
  const alle = db.prepare('SELECT id, name FROM products WHERE deleted_at IS NULL ORDER BY name').all();
  const nach = new Map();
  for (const p of alle) {
    const k = vergleichsform(p.name);
    if (!nach.has(k)) nach.set(k, []);
    nach.get(k).push(p);
  }
  return [...nach.values()].filter(g => g.length > 1);
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

// ── Kategorien pflegen ──────────────────────────────────────────────────────────────────────
//
// ACHTUNG REIHENFOLGE: Diese drei Routen muessen VOR `/:id` stehen. Sonst frisst `/:id` den Pfad
// `/kategorien/7` und versucht, ein Produkt mit der Nummer „kategorien" zu aendern — Express
// nimmt die erste passende Route, nicht die genaueste.

router.put('/kategorien/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const k = db.prepare('SELECT id, name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!k) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Kategorienamen mit mindestens 2 Zeichen angeben.' });
  const gleich = db.prepare('SELECT id, name FROM product_categories WHERE deleted_at IS NULL AND id != ?')
    .all(id).find(x => vergleichsform(x.name) === vergleichsform(name));
  if (gleich) return res.status(409).json({
    error: `Es gibt bereits die Kategorie „${gleich.name}". Zum Verschmelzen die Produkte umhängen.`,
    kategorie: gleich });
  db.prepare('UPDATE product_categories SET name = ? WHERE id = ?').run(name, id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_category_update',
    details: `Kategorie „${k.name}" → „${name}"`, ip: req.ip });
  broadcast('produkte');
  res.json({ kategorie: db.prepare(`SELECT ${KAT_FELDER} FROM product_categories WHERE id = ?`).get(id) });
});

// Zusammenlegen: alle Produkte von :id nach nach_id, dann :id weich loeschen.
router.post('/kategorien/:id/zusammenfuehren', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const nachId = Number(req.body.nach_id);
  if (!nachId || nachId === id) return res.status(400).json({ error: 'Bitte zwei verschiedene Kategorien angeben.' });
  const von = db.prepare('SELECT id, name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(id);
  const nach = db.prepare('SELECT id, name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(nachId);
  if (!von || !nach) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  const anzahl = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND deleted_at IS NULL').get(id).c;
  db.prepare('UPDATE products SET category_id = ? WHERE category_id = ?').run(nachId, id);
  db.prepare('UPDATE product_categories SET deleted_at = ? WHERE id = ?').run(berlinNow(), id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_category_merge',
    details: `Kategorie „${von.name}" in „${nach.name}" zusammengeführt (${anzahl} Produkt(e))`, ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true, verschoben: anzahl });
});

// Loeschen: nur wenn leer. Eine Kategorie mit Produkten still zu leeren waere eine Entscheidung,
// die dem Benutzer gehoert — er soll sehen, WIE VIELE dranhaengen, und selbst waehlen.
router.delete('/kategorien/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const k = db.prepare('SELECT id, name FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!k) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  const anzahl = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND deleted_at IS NULL').get(id).c;
  if (anzahl > 0 && !req.body.loesen) return res.status(409).json({
    error: `An dieser Kategorie hängen noch ${anzahl} Produkt(e). Verschiebe sie in eine andere `
         + 'Kategorie oder bestätige, dass sie ohne Kategorie bleiben sollen.', anzahl });
  if (anzahl > 0) db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('UPDATE product_categories SET deleted_at = ? WHERE id = ?').run(berlinNow(), id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_category_delete',
    details: `Kategorie gelöscht: ${k.name}` + (anzahl ? ` (${anzahl} Produkt(e) ohne Kategorie)` : ''), ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true, ohne_kategorie: anzahl });
});

// ── Produkt anlegen — NUR MIT BARCODE ────────────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const db = getDb();
  const name = String(req.body.name || '').trim();
  const code = String(req.body.barcode || '').trim();
  const katId = req.body.category_id ? Number(req.body.category_id) : null;
  const einheit = String(req.body.default_unit || '').trim() || null;

  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Produktnamen mit mindestens 2 Zeichen angeben.' });
  if (!code && !darfProduktePflegen(req.user)) {
    return res.status(400).json({
      error: 'Ein Produkt kommt hier nur mit Barcode ins Verzeichnis. Ohne Code bestellst du wie '
           + 'bisher mit freiem Text — das bleibt möglich und ändert am Verzeichnis nichts. '
           + 'Wer „Lagerdaten pflegen" darf, kann im Produktverzeichnis auch ohne Barcode anlegen.' });
  }
  const belegt = code ? db.prepare(
    `SELECT b.code, p.id, p.name, p.deleted_at FROM product_barcodes b
       JOIN products p ON p.id = b.product_id WHERE b.code = ?`).get(code) : null;
  if (belegt) {
    // Ist das Produkt GELOESCHT, bleibt sein Code trotzdem belegt — und die Meldung muss sagen,
    // wie man da herauskommt. Sonst steht man davor: anlegen geht nicht, anlernen auch nicht.
    return res.status(409).json({
      error: `Dieser Barcode gehört bereits zu „${belegt.name}"`
           + (belegt.deleted_at ? ' — einem gelöschten Produkt. Hol es im Verzeichnis zurück, '
              + 'dann ist der Code wieder benutzbar.' : '.'),
      produkt: { id: belegt.id, name: belegt.name, geloescht: !!belegt.deleted_at } });
  }
  if (katId && !db.prepare('SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(katId)) {
    return res.status(400).json({ error: 'Kategorie nicht gefunden' });
  }

  const jetzt = berlinNow();
  const r = db.prepare(
    'INSERT INTO products (name, category_id, default_unit, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(name, katId, einheit, jetzt, req.user.id);
  if (code) {
    db.prepare('INSERT INTO product_barcodes (product_id, code, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(r.lastInsertRowid, code, jetzt, req.user.id);
  }

  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_create',
    details: `Produkt angelegt: ${name} (${code ? 'Barcode ' + code : 'OHNE Barcode — nur über die Suche findbar'})`,
    ip: req.ip });
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
    // `geloescht` mitgeben — sonst kann die Oberflaeche nicht erklaeren, WARUM der Code belegt
    // ist, obwohl das Produkt nirgends auftaucht. (Beim Anlegen steht es schon drin.)
    const weg = db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(belegt.id);
    return res.status(409).json({
      error: `Dieser Barcode gehört bereits zu „${belegt.name}"`
           + (weg && weg.deleted_at ? ' — einem gelöschten Produkt. Hol es im Verzeichnis zurück, '
              + 'dann ist der Code wieder benutzbar.' : '.'),
      produkt: { ...belegt, geloescht: !!(weg && weg.deleted_at) } });
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
  if (!darfProduktePflegen(req.user)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const id = Number(req.params.id);
  const code = String(req.params.code || '').trim();
  const p = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });

  const codes = db.prepare('SELECT code FROM product_barcodes WHERE product_id = ?').all(id).map(r => r.code);
  if (!codes.includes(code)) return res.status(404).json({ error: 'Dieser Barcode gehört nicht zu diesem Produkt.' });
  // Frueher war das ein hartes Verbot („ein Produkt muss mindestens einen haben"). Seit
  // barcodelose Produkte erlaubt sind, ist es keine Unmoeglichkeit mehr, sondern eine
  // Entscheidung mit Folgen — also nachfragen statt verbieten.
  const trotzdem = req.query.trotzdem || (req.body && req.body.trotzdem);
  if (codes.length <= 1 && !trotzdem) {
    return res.status(409).json({
      error: 'Das ist der letzte Barcode. Ohne ihn lässt sich das Produkt nicht mehr scannen — '
           + 'über die Suche im Bestellformular bleibt es findbar. Bestätige, wenn das so sein soll.' });
  }
  db.prepare('DELETE FROM product_barcodes WHERE product_id = ? AND code = ?').run(id, code);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_barcode_remove',
    details: `Barcode ${code} von „${p.name}" entfernt`, ip: req.ip });
  broadcast('produkte');
  res.json({ produkt: produktMitCodes(db, id) });
});

// ── Alles fuer die Pflege-Ansicht in einem Zug ───────────────────────────────────────────────
router.get('/verzeichnis', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const kategorien = db.prepare(`
    SELECT k.id, k.name,
           (SELECT COUNT(*) FROM products p WHERE p.category_id = k.id AND p.deleted_at IS NULL) AS anzahl
      FROM product_categories k WHERE k.deleted_at IS NULL ORDER BY k.name`).all();
  const produkte = db.prepare(`
    SELECT p.id, p.name, p.category_id, p.default_unit, p.created_at, k.name AS kategorie_name,
           (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id) AS bestellungen
      FROM products p LEFT JOIN product_categories k ON k.id = p.category_id
     WHERE p.deleted_at IS NULL ORDER BY p.name`).all();
  const codes = db.prepare('SELECT product_id, code FROM product_barcodes').all();
  const nach = {};
  for (const c of codes) (nach[c.product_id] = nach[c.product_id] || []).push(c.code);
  for (const p of produkte) p.barcodes = nach[p.id] || [];
  const geloescht = db.prepare(`
    SELECT p.id, p.name, p.deleted_at, p.merged_into, m.name AS aufgegangen_in
      FROM products p LEFT JOIN products m ON m.id = p.merged_into
     WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`).all();
  // Geloeschte Haendler gehoeren MIT in den Papierkorb — sonst waere das Wiederherstellen zwar
  // moeglich, aber unerreichbar.
  const geloeschteHaendler = db.prepare(`
    SELECT s.id, s.name, s.deleted_at,
           (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id) AS eintraege
      FROM suppliers s WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`).all();
  res.json({ kategorien, produkte, geloescht, geloeschteHaendler,
             dubletten: dublettenGruppen(db), stand: berlinNow() });
});

// ── Produkt aendern ─────────────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : p.name;
  if (name.length < 2) return res.status(400).json({ error: 'Bitte einen Produktnamen mit mindestens 2 Zeichen angeben.' });
  const katId = req.body.category_id !== undefined
    ? (req.body.category_id ? Number(req.body.category_id) : null) : p.category_id;
  if (katId && !db.prepare('SELECT id FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(katId))
    return res.status(400).json({ error: 'Kategorie nicht gefunden' });
  const einheit = req.body.default_unit !== undefined
    ? (String(req.body.default_unit).trim() || null) : p.default_unit;

  // Umbenennen auf einen vorhandenen Namen ist ein WARNSIGNAL, kein Verbot — wer wirklich
  // zusammenfuehren will, nimmt den eigenen Weg dafuer; wer zwei aehnliche Produkte fuehren
  // will, darf das. Ohne „trotzdem" wird der Treffer aber erst einmal zurueckgemeldet.
  // Verglichen wird der Name ZEICHENGENAU, nicht in Vergleichsform: „Kabelbinder" → „kabel-binder"
  // ist in Vergleichsform dasselbe, und mit `!==` darauf waere die Warnung genau dann still
  // gewesen, wenn sie gebraucht wird — beim Angleichen zweier Schreibweisen. Zeichengenau heisst:
  // Wer nur die Kategorie speichert, wird nicht behelligt; wer den Namen anfasst, schon.
  if (!req.body.trotzdem && name !== p.name) {
    const gleich = db.prepare('SELECT id, name FROM products WHERE deleted_at IS NULL AND id != ?')
      .all(id).filter(x => vergleichsform(x.name) === vergleichsform(name));
    if (gleich.length) return res.status(409).json({
      error: `Es gibt bereits „${gleich[0].name}". Zusammenführen oder trotzdem so benennen?`,
      aehnliche: gleich });
  }

  db.prepare('UPDATE products SET name = ?, category_id = ?, default_unit = ? WHERE id = ?')
    .run(name, katId, einheit, id);
  const teile = [];
  if (name !== p.name) teile.push(`Name „${p.name}" → „${name}"`);
  if (katId !== p.category_id) teile.push('Kategorie geändert');
  if (einheit !== p.default_unit) teile.push(`Einheit „${p.default_unit || '—'}" → „${einheit || '—'}"`);
  if (teile.length) logAudit(db, { userId: req.user.id, username: req.user.username,
    action: 'product_update', details: teile.join('; '), ip: req.ip });
  broadcast('produkte');
  res.json({ produkt: produktMitCodes(db, id) });
});

// ── Produkt loeschen (weich) ────────────────────────────────────────────────────────────────
// Weich, weil ein alter Scan sonst ins Leere zeigt und niemand mehr sagen kann, was gemeint war.
// Die Barcodes bleiben haengen: Wer den Code spaeter scannt, bekommt „gehoerte zu …" statt
// „unbekannt" — und kann bewusst wiederherstellen.
router.delete('/:id', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const p = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(berlinNow(), id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_delete',
    details: `Produkt gelöscht: ${p.name}`, ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true });
});

router.post('/:id/wiederherstellen', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const p = db.prepare('SELECT id, name, deleted_at, merged_into FROM products WHERE id = ?').get(id);
  if (!p || !p.deleted_at) return res.status(404).json({ error: 'Kein gelöschtes Produkt mit dieser Nummer' });
  // Ein zusammengefuehrtes Produkt zurueckzuholen wuerde die Barcodes doppeln — die haengen
  // inzwischen am Nachfolger. Das ist kein Wiederherstellen, sondern ein neues Produkt.
  if (p.merged_into) return res.status(409).json({
    error: 'Dieses Produkt wurde zusammengeführt, nicht gelöscht. Seine Barcodes hängen am '
         + 'Nachfolger. Wenn es wieder eigenständig sein soll, lege es neu an.' });
  db.prepare('UPDATE products SET deleted_at = NULL WHERE id = ?').run(id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_restore',
    details: `Produkt wiederhergestellt: ${p.name}`, ip: req.ip });
  broadcast('produkte');
  res.json({ produkt: produktMitCodes(db, id) });
});

// ── Zwei Produkte zusammenfuehren ───────────────────────────────────────────────────────────
// :id ueberlebt, von_id geht darin auf. Alle Barcodes wandern mit (Codes sind global eindeutig,
// es kann also nicht kollidieren), die Bestell-Verknuepfungen ebenso. Der Bestelltext bleibt
// unangetastet — er ist das, was der Mensch geschrieben hat.
router.post('/:id/zusammenfuehren', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const vonId = Number(req.body.von_id);
  if (!vonId || vonId === id) return res.status(400).json({ error: 'Bitte zwei verschiedene Produkte angeben.' });
  const ziel = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  const quelle = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(vonId);
  if (!ziel || !quelle) return res.status(404).json({ error: 'Produkt nicht gefunden' });

  const neuerName = req.body.name !== undefined ? String(req.body.name).trim() : ziel.name;
  if (neuerName.length < 2) return res.status(400).json({ error: 'Bitte einen Produktnamen mit mindestens 2 Zeichen angeben.' });

  const codes = db.prepare('SELECT code FROM product_barcodes WHERE product_id = ?').all(vonId).map(r => r.code);
  db.prepare('UPDATE product_barcodes SET product_id = ? WHERE product_id = ?').run(id, vonId);
  const betroffen = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_id = ?').get(vonId).c;
  db.prepare('UPDATE orders SET product_id = ? WHERE product_id = ?').run(id, vonId);

  // Grosshaendler-Angaben mitnehmen. UNIQUE(product_id, supplier_id) laesst nicht zu, dass beide
  // Produkte denselben Haendler behalten — und genau da wuerde ein schlichtes UPDATE eine der
  // beiden Bestellnummern verschlucken. Die hat jemand von Hand abgetippt; still zu loeschen ist
  // die Art Verlust, die erst Monate spaeter beim Bestellen auffaellt.
  //
  // Deshalb: Was das Ziel noch nicht hat, wandert. Was es schon hat, wird an dessen Kommentar
  // ANGEHAENGT, sichtbar gekennzeichnet, und die Quellzeile faellt weg.
  const quellZeilen = db.prepare(
    `SELECT ps.*, s.name AS haendler FROM product_suppliers ps
       JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = ?`).all(vonId);
  let gewandert = 0; const verschmolzen = [];
  for (const z of quellZeilen) {
    const beimZiel = db.prepare('SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?')
      .get(id, z.supplier_id);
    if (!beimZiel) {
      db.prepare('UPDATE product_suppliers SET product_id = ? WHERE id = ?').run(id, z.id);
      gewandert++;
      continue;
    }
    const teile = [];
    if (z.bestellnummer) teile.push('Best.-Nr. ' + z.bestellnummer);
    if (z.link) teile.push(z.link);
    if (z.kommentar) teile.push(z.kommentar);
    if (teile.length) {
      const zusatz = `(aus „${quelle.name}": ${teile.join(', ')})`;
      const neu = beimZiel.kommentar ? beimZiel.kommentar + '\n' + zusatz : zusatz;
      db.prepare('UPDATE product_suppliers SET kommentar = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(neu, berlinNow(), req.user.id, beimZiel.id);
    }
    db.prepare('DELETE FROM product_suppliers WHERE id = ?').run(z.id);
    verschmolzen.push(z.haendler);
  }
  db.prepare('UPDATE products SET deleted_at = ?, merged_into = ? WHERE id = ?').run(berlinNow(), id, vonId);
  if (neuerName !== ziel.name) db.prepare('UPDATE products SET name = ? WHERE id = ?').run(neuerName, id);

  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_merge',
    details: `„${quelle.name}" in „${neuerName}" zusammengeführt `
           + `(${codes.length} Barcode(s): ${codes.join(', ') || '—'}; ${betroffen} Bestellung(en) umgehängt`
           + `; ${gewandert} Händler-Eintrag/-Einträge übernommen`
           + (verschmolzen.length ? `; bei ${verschmolzen.join(', ')} in den Kommentar geschrieben` : '') + ')',
    ip: req.ip });
  broadcast('produkte');
  res.json({ produkt: produktMitCodes(db, id), uebernommene_codes: codes, bestellungen: betroffen,
             haendler_uebernommen: gewandert, haendler_verschmolzen: verschmolzen });
});

// ── Was DIESES Produkt bei DIESEM Händler ist ───────────────────────────────────────────────
// Ansehen darf, wer bestellen darf — das ist der ganze Zweck: Der Chef sieht in der Bestellung
// sofort Bestellnummer und Link. Ändern darf nur, wer pflegt.

router.get('/:id/haendler', authenticate, (req, res) => {
  if (!darfBestellen(req.user) && !darfProduktePflegen(req.user))
    return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const id = Number(req.params.id);
  const p = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  // Alphabetisch (Alex, 08.09.2026: kein Hauptlieferant, alle gleichrangig).
  // Gelöschte Händler bleiben draussen, ihre Einträge aber in der Datenbank stehen.
  const eintraege = db.prepare(`
    SELECT ps.supplier_id, ps.bestellnummer, ps.link, ps.kommentar, ps.updated_at,
           s.name, s.homepage, s.kundennummer, s.ansprechpartner, s.telefon, s.email, s.notiz
      FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
     WHERE ps.product_id = ? AND s.deleted_at IS NULL
     ORDER BY s.name`).all(id);
  res.json({ produkt: { id: p.id, name: p.name }, haendler: eintraege });
});

// Anlegen ODER ändern in einem: Es gibt genau einen Eintrag je Paar, und ob er schon existiert,
// ist für den Benutzer kein Unterschied — er füllt ein Formular aus.
router.put('/:id/haendler/:supplierId', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const sid = Number(req.params.supplierId);
  const p = db.prepare('SELECT id, name FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  const s = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(sid);
  if (!s) return res.status(404).json({ error: 'Großhändler nicht gefunden' });

  const nr = String(req.body.bestellnummer == null ? '' : req.body.bestellnummer).trim() || null;
  if (nr && nr.length > 80) return res.status(400).json({ error: 'Die Bestellnummer ist zu lang (höchstens 80 Zeichen).' });
  const kommentar = String(req.body.kommentar == null ? '' : req.body.kommentar).trim() || null;
  if (kommentar && kommentar.length > 2000) return res.status(400).json({ error: 'Der Kommentar ist zu lang (höchstens 2000 Zeichen).' });
  const l = linkPruefen(req.body.link);
  if (!l.ok) return res.status(400).json({ error: 'Link: ' + l.fehler });

  const jetzt = berlinNow();
  const vorher = db.prepare('SELECT * FROM product_suppliers WHERE product_id = ? AND supplier_id = ?').get(id, sid);
  if (vorher) {
    db.prepare('UPDATE product_suppliers SET bestellnummer=?, link=?, kommentar=?, updated_at=?, updated_by=? WHERE id=?')
      .run(nr, l.wert, kommentar, jetzt, req.user.id, vorher.id);
  } else {
    db.prepare(`INSERT INTO product_suppliers (product_id, supplier_id, bestellnummer, link, kommentar, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, sid, nr, l.wert, kommentar, jetzt, req.user.id);
  }
  logAudit(db, { userId: req.user.id, username: req.user.username,
    action: vorher ? 'product_supplier_update' : 'product_supplier_add',
    details: `„${p.name}" bei „${s.name}": Best.-Nr. ${nr || '—'}${l.wert ? ', Link hinterlegt' : ''}`, ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true });
});

router.delete('/:id/haendler/:supplierId', authenticate, nurPfleger, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id), sid = Number(req.params.supplierId);
  const zeile = db.prepare(`
    SELECT ps.id, p.name AS produkt, s.name AS haendler FROM product_suppliers ps
      JOIN products p ON p.id = ps.product_id JOIN suppliers s ON s.id = ps.supplier_id
     WHERE ps.product_id = ? AND ps.supplier_id = ?`).get(id, sid);
  if (!zeile) return res.status(404).json({ error: 'Für dieses Produkt ist bei diesem Händler nichts hinterlegt.' });
  db.prepare('DELETE FROM product_suppliers WHERE id = ?').run(zeile.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'product_supplier_remove',
    details: `„${zeile.produkt}" bei „${zeile.haendler}" entfernt`, ip: req.ip });
  broadcast('produkte');
  res.json({ ok: true });
});

module.exports = router;
module.exports.vergleichsform = vergleichsform;
