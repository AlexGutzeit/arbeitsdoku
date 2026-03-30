const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const dbModule = require('../database/init');
const { getDb, saveToFile, reloadFromFile, DB_PATH } = dbModule;
const { authenticate, authorize } = require('../middleware/auth');

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

  // Uploads-Ordner hinzufügen (Logo etc.)
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    files.forEach(f => {
      const filePath = path.join(uploadsDir, f);
      if (fs.statSync(filePath).isFile()) {
        archive.file(filePath, { name: 'uploads/' + f });
      }
    });
  }

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

      // Upload-Dateien sammeln
      entries.forEach(e => {
        if (e.entryName.startsWith('uploads/') && !e.isDirectory) {
          uploadFiles.push({ name: e.entryName.replace('uploads/', ''), data: e.getData() });
        }
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
      return res.status(400).json({ error: 'Ungültige SQLite-Datei: ' + e.message });
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

    // Uploads wiederherstellen
    if (uploadFiles.length > 0) {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      uploadFiles.forEach(f => {
        fs.writeFileSync(path.join(uploadsDir, f.name), f.data);
      });
    }

    fs.unlinkSync(req.file.path);

    // DB neu laden
    reloadFromFile(DB_PATH);

    res.json({
      success: true,
      message: `Backup erfolgreich wiederhergestellt (DB + ${uploadFiles.length} Datei${uploadFiles.length !== 1 ? 'en' : ''})`,
      safetyBackup: path.basename(safetyZipPath)
    });
  } catch (error) {
    console.error('Backup-Wiederherstellung fehlgeschlagen:', error);
    res.status(500).json({ error: 'Fehler bei der Wiederherstellung: ' + error.message });
  }
});

module.exports = router;
