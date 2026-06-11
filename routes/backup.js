const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const dbModule = require('../database/init');
const { getDb, saveToFile, reloadFromFile, DB_PATH } = dbModule;
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

const backupDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const uploadsDir = path.join(__dirname, '..', 'uploads');

const upload = multer({
  dest: path.join(backupDir, 'temp'),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// Backup herunterladen (ZIP mit DB + Uploads)
router.get('/download', authenticate, authorize('chef'), (req, res) => {
  saveToFile();

  if (!fs.existsSync(DB_PATH)) {
    return res.status(404).json({ error: 'Datenbank nicht gefunden' });
  }

  logAudit(getDb(), { userId: req.user.id, username: req.user.username, action: 'backup_download', ip: req.ip });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `arbeitsdoku_backup_${timestamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Backup-Archiv Fehler:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Backup fehlgeschlagen' });
  });
  archive.pipe(res);

  // Datenbank hinzufügen
  archive.file(DB_PATH, { name: 'arbeitsdoku.db' });

  // Uploads-Ordner inkl. erlaubter Subordner (icons) rekursiv hinzufuegen
  function walkUploads(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'tmp') continue; // multer-Temp-Ordner ueberspringen
      const full = path.join(dir, entry);
      const rel = prefix + '/' + entry;
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) {
          archive.file(full, { name: rel });
        } else if (stat.isDirectory()) {
          walkUploads(full, rel);
        }
      } catch (_) {}
    }
  }
  walkUploads(uploadsDir, 'uploads');

  archive.finalize();
});

// Backup wiederherstellen (ZIP oder SQLite)
router.post('/restore', authenticate, authorize('chef'), upload.single('backup'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Backup-Datei hochgeladen' });
  }

  try {
    const buffer = fs.readFileSync(req.file.path);
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;

    let dbBuffer;
    let uploadFiles = []; // [{name, data}]

    if (isZip) {
      const zip = new AdmZip(req.file.path);
      const entries = zip.getEntries();

      // DB-Datei finden
      const dbEntry = entries.find(e => e.entryName === 'arbeitsdoku.db' || e.entryName.endsWith('.db'));
      if (!dbEntry) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Keine Datenbank-Datei im Backup gefunden' });
      }
      dbBuffer = new Uint8Array(dbEntry.getData());

      // Upload-Dateien sammeln (mit Path-Traversal-Schutz)
      // Erlaubt: uploads/<file> (root) und uploads/<allowedSubdir>/<file>
      const uploadsResolved = path.resolve(uploadsDir);
      const ALLOWED_SUBDIRS = ['icons'];
      entries.forEach(e => {
        if (!e.entryName.startsWith('uploads/') || e.isDirectory) return;
        const rel = e.entryName.slice('uploads/'.length); // z.B. "logo.jpg" oder "icons/master.png"
        if (rel.includes('..') || rel.startsWith('.') || rel.startsWith('/')) {
          console.warn('Backup-Restore: Eintrag uebersprungen (verdaechtiger Name):', e.entryName);
          return;
        }
        const parts = rel.split('/');
        let safeRel;
        if (parts.length === 1) {
          safeRel = path.basename(parts[0]);
        } else if (parts.length === 2 && ALLOWED_SUBDIRS.includes(parts[0])) {
          const subFile = path.basename(parts[1]);
          if (!subFile || subFile.startsWith('.')) {
            console.warn('Backup-Restore: Eintrag uebersprungen (Subfile-Name verdaechtig):', e.entryName);
            return;
          }
          safeRel = parts[0] + '/' + subFile;
        } else {
          console.warn('Backup-Restore: Eintrag uebersprungen (Subpfad nicht erlaubt):', e.entryName);
          return;
        }
        const finalPath = path.resolve(uploadsDir, safeRel);
        if (!finalPath.startsWith(uploadsResolved + path.sep)) {
          console.warn('Backup-Restore: Eintrag uebersprungen (Pfad ausserhalb uploads):', e.entryName);
          return;
        }
        uploadFiles.push({ name: safeRel, data: e.getData() });
      });
    } else {
      // Reine SQLite-Datei (Abwärtskompatibilität)
      dbBuffer = buffer;
    }

    // DB validieren
    let testDb;
    try {
      const SqlModule = dbModule.SQL;
      testDb = new SqlModule.Database(dbBuffer);
      const tables = [];
      const result = testDb.exec("SELECT name FROM sqlite_master WHERE type='table'");
      if (result.length > 0) {
        result[0].values.forEach(v => tables.push(v[0]));
      }
      if (!tables.includes('users') || !tables.includes('entries')) {
        testDb.close();
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Ungültige Backup-Datei: Erforderliche Tabellen fehlen' });
      }
      testDb.close();
    } catch (e) {
      console.error('DB-Validierung fehlgeschlagen:', e.message);
      if (testDb) testDb.close();
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Backup-Datei ungültig oder beschädigt' });
    }

    // Sicherungs-Backup der aktuellen Daten erstellen
    saveToFile();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyZipPath = path.join(backupDir, `safety_backup_${timestamp}.zip`);

    const safetyArchive = new AdmZip();
    if (fs.existsSync(DB_PATH)) {
      safetyArchive.addLocalFile(DB_PATH, '', 'arbeitsdoku.db');
    }
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      files.forEach(f => {
        const fp = path.join(uploadsDir, f);
        if (fs.statSync(fp).isFile()) safetyArchive.addLocalFile(fp, 'uploads');
      });
    }
    safetyArchive.writeZip(safetyZipPath);

    // DB wiederherstellen
    fs.writeFileSync(DB_PATH, Buffer.from(dbBuffer));

    // Uploads wiederherstellen (Subordner werden bei Bedarf angelegt)
    if (uploadFiles.length > 0) {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      uploadFiles.forEach(f => {
        const target = path.join(uploadsDir, f.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.data);
      });
    }

    fs.unlinkSync(req.file.path);

    // DB neu laden
    reloadFromFile(DB_PATH);

    // Audit in die wiederhergestellte DB schreiben (ensureAuditSchema hat audit_logs garantiert)
    logAudit(getDb(), {
      userId: req.user.id, username: req.user.username, action: 'backup_restore',
      details: `Safety-Backup: ${path.basename(safetyZipPath)}, ${uploadFiles.length} Upload-Datei(en)`,
      ip: req.ip,
    });

    res.json({
      success: true,
      message: `Backup erfolgreich wiederhergestellt (DB + ${uploadFiles.length} Datei${uploadFiles.length !== 1 ? 'en' : ''})`,
      safetyBackup: path.basename(safetyZipPath)
    });
  } catch (error) {
    console.error('Backup-Wiederherstellung fehlgeschlagen:', error);
    res.status(500).json({ error: 'Wiederherstellung fehlgeschlagen' });
  }
});

module.exports = router;
