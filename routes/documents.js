const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { berlinNow } = require('../audit');

const router = express.Router();

// Darf Dokumente verwalten (hochladen, Ordner/Dateien anlegen/aendern/loeschen):
// Admin, Chef oder ein Benutzer mit explizitem Upload-Recht (can_upload).
function canManageDocs(req, res, next) {
  const u = req.user;
  if (u && (u.role === 'admin' || u.role === 'chef' || u.can_upload)) return next();
  return res.status(403).json({ error: 'Keine Berechtigung' });
}

const storageDir = path.join(__dirname, '..', 'storage', 'documents');
function ensureStorageDir() { if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true }); }

const ALLOWED_EXT = ['.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.txt', '.csv', '.md'];
const MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
};
const NAME_MAX = 120;
const DEFAULT_STORAGE_LIMIT = 500 * 1024 * 1024;       // Standard, falls nichts eingestellt (500 MB)
const MAX_STORAGE_LIMIT = 1024 * 1024 * 1024 * 1024;   // Obergrenze (1 TB) als Sanity-Schutz

function totalUsedBytes(db) {
  return db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM documents').get().total || 0;
}
// Konfigurierbares Gesamt-Speicherlimit aus den Settings (Admin), mit Fallback auf 500 MB
function getStorageLimit(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'doc_storage_limit_bytes'").get();
  const n = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STORAGE_LIMIT;
  return Math.min(n, MAX_STORAGE_LIMIT);
}

// Upload direkt nach storage/documents/ mit generiertem UUID-Namen (kein User-Pfad)
const storage = multer.diskStorage({
  destination: (req, file, cb) => { ensureStorageDir(); cb(null, storageDir); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Dateiformat nicht erlaubt (erlaubt: PDF, Word/Excel/PowerPoint, OpenDocument (odt/ods/odp), PNG, JPG, TXT, CSV, Markdown)'));
  },
});

// Inhaltspruefung (Magic Bytes): pruefen, ob der echte Dateiinhalt zur Endung passt.
// Faengt umbenannte Dateien ab (z.B. .exe → .pdf), die den reinen Extension-Filter umgehen wuerden.
function headBytes(filePath, n) {
  const buf = Buffer.alloc(n);
  let read = 0;
  const fd = fs.openSync(filePath, 'r');
  try { read = fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
  return buf.subarray(0, read);
}
function startsWith(head, sig) {
  if (head.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[i] !== sig[i]) return false;
  return true;
}
function isLikelyText(filePath) {
  // Heuristik: erste 8 KB ohne Null-Byte → Text; ein Null-Byte deutet auf Binaerdatei (z.B. .exe) hin
  const head = headBytes(filePath, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
  return true;
}
function contentMatchesExt(filePath, ext) {
  const head = headBytes(filePath, 16);
  switch (ext) {
    case '.pdf':  return startsWith(head, [0x25, 0x50, 0x44, 0x46]); // %PDF
    case '.png':  return startsWith(head, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    case '.jpg':
    case '.jpeg': return startsWith(head, [0xFF, 0xD8, 0xFF]);
    // docx/xlsx/pptx (Office Open XML) UND odt/ods/odp (OpenDocument) sind ZIP-Container → PK-Signatur
    case '.docx':
    case '.xlsx':
    case '.pptx':
    case '.odt':
    case '.ods':
    case '.odp':  return startsWith(head, [0x50, 0x4B, 0x03, 0x04])
                      || startsWith(head, [0x50, 0x4B, 0x05, 0x06])
                      || startsWith(head, [0x50, 0x4B, 0x07, 0x08]);
    case '.txt':
    case '.csv':
    case '.md':   return isLikelyText(filePath);
    default:      return false;
  }
}

function folderRow(db, id) {
  return db.prepare('SELECT id, name, parent_id FROM doc_folders WHERE id = ?').get(id);
}
// Breadcrumb von Wurzel bis zum aktuellen Ordner
function buildBreadcrumb(db, folderId) {
  const crumbs = [];
  let cur = folderId ? folderRow(db, folderId) : null;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    crumbs.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? folderRow(db, cur.parent_id) : null;
  }
  return crumbs;
}

// Inhalt eines Ordners (oder Wurzel) — alle eingeloggten Nutzer
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const folderId = req.query.folder_id ? Number(req.query.folder_id) : null;
  if (folderId && !folderRow(db, folderId)) {
    return res.status(404).json({ error: 'Ordner nicht gefunden' });
  }
  const folders = db.prepare(`
    SELECT f.id, f.name, f.parent_id, f.created_at, u.name as created_by_name,
           (SELECT COUNT(*) FROM doc_folders sf WHERE sf.parent_id = f.id) as subfolder_count,
           (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) as document_count
    FROM doc_folders f LEFT JOIN users u ON f.created_by = u.id
    WHERE f.parent_id IS ?
    ORDER BY f.name COLLATE NOCASE
  `).all(folderId);
  const documents = db.prepare(`
    SELECT d.id, d.folder_id, d.original_name, d.title, d.mime, d.size, d.uploaded_at,
           u.name as uploaded_by_name
    FROM documents d LEFT JOIN users u ON d.uploaded_by = u.id
    WHERE d.folder_id IS ?
    ORDER BY COALESCE(NULLIF(d.title,''), d.original_name) COLLATE NOCASE
  `).all(folderId);
  res.json({
    folder: folderId ? folderRow(db, folderId) : null,
    breadcrumb: buildBreadcrumb(db, folderId),
    folders, documents,
    storage: { used: totalUsedBytes(db), limit: getStorageLimit(db) },
  });
});

// Alle Ordner flach (fuer den Verschieben-Auswahlbaum) — alle eingeloggten Nutzer
router.get('/folders/all', authenticate, (req, res) => {
  const db = getDb();
  const folders = db.prepare('SELECT id, name, parent_id FROM doc_folders ORDER BY name COLLATE NOCASE').all();
  res.json({ folders });
});

// Ordner anlegen (chef + admin)
router.post('/folders', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: `Name zu lang (max. ${NAME_MAX})` });
  if (parentId && !folderRow(db, parentId)) return res.status(400).json({ error: 'Übergeordneter Ordner nicht gefunden' });
  const r = db.prepare('INSERT INTO doc_folders (name, parent_id, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(name, parentId, req.user.id, berlinNow());
  res.status(201).json({ folder: folderRow(db, r.lastInsertRowid) });
});

// Ordner umbenennen (chef + admin)
router.put('/folders/:id', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const folder = folderRow(db, req.params.id);
  if (!folder) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: `Name zu lang (max. ${NAME_MAX})` });
  db.prepare('UPDATE doc_folders SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ folder: folderRow(db, req.params.id) });
});

// Ordner verschieben (chef + admin) — mit Schutz gegen Verschieben in sich selbst/Unterordner
router.put('/folders/:id/move', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const folder = folderRow(db, req.params.id);
  if (!folder) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  const target = req.body.parent_id ? Number(req.body.parent_id) : null;
  if (target) {
    if (!folderRow(db, target)) return res.status(400).json({ error: 'Zielordner nicht gefunden' });
    const subtree = collectFolderIds(db, folder.id); // Ordner + alle Nachkommen
    if (subtree.includes(target)) {
      return res.status(400).json({ error: 'Ordner kann nicht in sich selbst oder einen Unterordner verschoben werden' });
    }
  }
  db.prepare('UPDATE doc_folders SET parent_id = ? WHERE id = ?').run(target, folder.id);
  res.json({ success: true });
});

// Alle Ordner-IDs eines Teilbaums (inkl. Wurzel) sammeln
function collectFolderIds(db, rootId) {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const ph = frontier.map(() => '?').join(',');
    const children = db.prepare(`SELECT id FROM doc_folders WHERE parent_id IN (${ph})`).all(...frontier).map(r => r.id);
    frontier = children;
    ids.push(...children);
  }
  return ids;
}

// Ordner rekursiv löschen (chef + admin) — inkl. Unterordner, Dokumente und Dateien
router.delete('/folders/:id', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const folder = folderRow(db, req.params.id);
  if (!folder) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  const ids = collectFolderIds(db, folder.id);
  const ph = ids.map(() => '?').join(',');
  const files = db.prepare(`SELECT stored_name FROM documents WHERE folder_id IN (${ph})`).all(...ids);
  for (const f of files) { try { fs.unlinkSync(path.join(storageDir, f.stored_name)); } catch (_) {} }
  db.prepare(`DELETE FROM documents WHERE folder_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM doc_folders WHERE id IN (${ph})`).run(...ids);
  res.json({ success: true });
});

// Datei hochladen (chef + admin)
router.post('/upload', authenticate, canManageDocs, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen' });
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    const db = getDb();
    const ext = path.extname(req.file.originalname).toLowerCase();
    // Inhaltspruefung: Dateiinhalt muss zur Endung passen (faengt getarnte Dateien ab)
    if (!contentMatchesExt(req.file.path, ext)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: 'Dateiinhalt passt nicht zum Format — Datei abgelehnt' });
    }
    // Gesamt-Speicherlimit der Ablage pruefen (konfigurierbar)
    const limitBytes = getStorageLimit(db);
    const used = totalUsedBytes(db);
    if (used + req.file.size > limitBytes) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      const limitMb = (limitBytes / (1024 * 1024)).toFixed(limitBytes % (1024 * 1024) ? 1 : 0);
      const freeMb = Math.max(0, (limitBytes - used) / (1024 * 1024));
      return res.status(400).json({ error: `Speicherlimit der Dokumenten-Ablage erreicht (${limitMb} MB). Noch frei: ${freeMb.toFixed(1)} MB.` });
    }
    const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
    if (folderId && !folderRow(db, folderId)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: 'Ordner nicht gefunden' });
    }
    let title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (title.length > NAME_MAX) title = title.slice(0, NAME_MAX);
    const r = db.prepare(`
      INSERT INTO documents (folder_id, original_name, stored_name, mime, size, title, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(folderId, req.file.originalname.slice(0, 255), req.file.filename, MIME[ext] || 'application/octet-stream',
      req.file.size, title, req.user.id, berlinNow());
    const doc = db.prepare('SELECT id, folder_id, original_name, title, mime, size, uploaded_at FROM documents WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ document: doc });
  });
});

// Gesamt-Speicherlimit setzen (nur Admin). MUSS vor PUT '/:id' stehen.
router.put('/storage-limit', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  let value = req.body.value;
  // "," und "." gleich behandeln
  if (typeof value === 'string') value = parseFloat(value.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Bitte eine gültige Zahl größer 0 eingeben' });
  const unit = req.body.unit === 'GB' ? 'GB' : 'MB';
  const factor = unit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024;
  let bytes = Math.round(value * factor);
  if (bytes < 1024 * 1024) bytes = 1024 * 1024;            // min. 1 MB
  if (bytes > MAX_STORAGE_LIMIT) return res.status(400).json({ error: 'Limit zu groß (max. 1024 GB)' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('doc_storage_limit_bytes', ?)").run(String(bytes));
  res.json({ limit: bytes, used: totalUsedBytes(db) });
});

// Dokument umbenennen / Metadaten ändern (chef + admin)
// Beim Umbenennen bleibt die urspruengliche Dateiendung erhalten (kein Format-Umtarnen moeglich).
router.put('/:id', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokument nicht gefunden' });

  let newOriginal = doc.original_name;
  if (typeof req.body.name === 'string') {
    const ext = path.extname(doc.original_name); // Original-Endung beibehalten
    let base = path.basename(req.body.name.trim(), path.extname(req.body.name.trim()));
    base = base.replace(/[\\/\r\n\t"]/g, '').trim().slice(0, 200);
    if (!base) return res.status(400).json({ error: 'Name erforderlich' });
    newOriginal = base + ext;
  }
  let title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, NAME_MAX) : doc.title;
  db.prepare('UPDATE documents SET original_name = ?, title = ? WHERE id = ?').run(newOriginal, title, req.params.id);
  res.json({ document: db.prepare('SELECT id, folder_id, original_name, title, mime, size, uploaded_at FROM documents WHERE id = ?').get(req.params.id) });
});

// Dokument in anderen Ordner verschieben (chef + admin)
router.put('/:id/move', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  const target = req.body.folder_id ? Number(req.body.folder_id) : null;
  if (target && !folderRow(db, target)) return res.status(400).json({ error: 'Zielordner nicht gefunden' });
  db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(target, req.params.id);
  res.json({ success: true });
});

// Dokument löschen (chef + admin)
router.delete('/:id', authenticate, canManageDocs, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  try { fs.unlinkSync(path.join(storageDir, doc.stored_name)); } catch (_) {}
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Datei herunterladen (alle eingeloggten Nutzer) — immer als Attachment, nie inline
router.get('/:id/download', authenticate, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Dokument nicht gefunden' });
  const filePath = path.resolve(storageDir, doc.stored_name);
  if (!filePath.startsWith(path.resolve(storageDir) + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Datei nicht gefunden' });
  }
  // Anzeigename bereinigen (keine Quotes/Steuerzeichen im Header)
  const safeName = (doc.original_name || 'dokument').replace(/[\r\n"\\]/g, '_');
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.original_name || 'dokument')}`);
  res.setHeader('Content-Length', doc.size || fs.statSync(filePath).size);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
