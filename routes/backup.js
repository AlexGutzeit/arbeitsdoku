const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const dbModule = require('../database/init');
const { getDb, saveToFile, reloadFromFile, writeFileAtomic, DB_PATH } = dbModule;
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { abgerechnetBis } = require('../abschluss');
const krypto = require('../backup-krypto');
const { berlinJetzt } = require('../zeit');

const router = express.Router();

const backupDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const uploadsDir = path.join(__dirname, '..', 'uploads');
const documentsDir = path.join(__dirname, '..', 'storage', 'documents');
const avatarDir = path.join(__dirname, '..', 'storage', 'avatare');

// Das Restore-Upload-Limit muss zum möglichen Backup-Volumen passen: ein Backup-Zip bündelt DB + uploads
// (Logo/Icons) + die KOMPLETTE Dokumenten-Ablage. Darum dynamisch = konfiguriertes Dokumenten-Speicherlimit
// + Reserve (DB bleibt realistisch im einstelligen MB-Bereich, dazu Icons + Zip-Overhead). Sonst könnte man
// ein selbst erzeugtes Backup nicht mehr einspielen, sobald die Ablage größer als ein fixes Limit wird.
const DEFAULT_STORAGE_LIMIT = 500 * 1024 * 1024;       // wie routes/documents.js
const MAX_STORAGE_LIMIT = 1024 * 1024 * 1024 * 1024;   // 1 TB
const RESTORE_HEADROOM = 128 * 1024 * 1024;            // Reserve für DB + uploads/icons + Zip-Overhead
function restoreLimitBytes(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'doc_storage_limit_bytes'").get();
  const n = row ? parseInt(row.value, 10) : NaN;
  const storage = (!Number.isFinite(n) || n <= 0) ? DEFAULT_STORAGE_LIMIT : Math.min(n, MAX_STORAGE_LIMIT);
  return storage + RESTORE_HEADROOM;
}
// Per-Request-Multer mit aktuellem Limit + klarer Fehlermeldung (statt generischem Crash) bei Übergröße.
function restoreUpload(req, res, next) {
  const limit = restoreLimitBytes(getDb());
  const m = multer({ dest: path.join(backupDir, 'temp'), limits: { fileSize: limit } }).single('backup');
  m(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(limit / (1024 * 1024));
        return res.status(413).json({ error: `Backup-Datei zu groß (max. ${mb} MB). Erhöhe ggf. das Dokumenten-Speicherlimit in den Einstellungen.` });
      }
      return res.status(400).json({ error: 'Upload fehlgeschlagen' });
    }
    next();
  });
}

// ── Empfänger verschlüsselter Sicherungen ──────────────────────────────────────────────────────
//
// Zwei Quellen, die gleichzeitig gelten: BACKUP_EMPFAENGER aus der Umgebung (fest, hängt an der
// Maschine, über die Oberfläche nicht erreichbar) und die Tabelle backup_empfaenger, die hier
// gepflegt wird. Ohne diese Tabelle konnte die Verschlüsselung nur einschalten, wer SSH-Zugang
// zur .env hat — für die meisten Betreiber hiess das: gar nicht.

function empfaengerAusDb(db) {
  const zeilen = db.prepare(krypto.EMPFAENGER_SQL).all();
  return krypto.empfaengerAusZeilen(zeilen, (name, grund) => {
    console.error(`backup_empfaenger: „${name}" wird übersprungen — ${grund}`);
  });
}

// Die Liste, die wirklich zum Verschlüsseln benutzt wird. Wirft, wenn die UMGEBUNG kaputt ist —
// dort kann niemand über die Oberfläche gegensteuern, also darf das nicht stillschweigend
// durchlaufen. Eine kaputte Zeile in der Datenbank wird dagegen übersprungen und protokolliert.
function aktuelleEmpfaenger(db) {
  return krypto.empfaengerZusammen(krypto.empfaengerAusUmgebung(), empfaengerAusDb(db));
}

// Wer darf was (Entscheidung Alex, 25.08.2026):
//   sehen   — Chef und Admin, wie die ganze Backup-Karte
//   ändern  — NUR Admin. Wer diese Liste ändert, entscheidet, wer den gesamten Datenbestand lesen
//             kann — und könnte im Vorbeigehen die Notfall-Umschaltung stilllegen, indem er den
//             Schlüssel der Zweitanlage herausnimmt. Das soll nicht nebenbei passieren.
//   prüfen  — Chef und Admin: Der Beweis, den eigenen Schlüssel zu besitzen, ändert nichts daran,
//             wer lesen darf, und ist genau das Verhalten, das man fördern will.
//
// Öffentliche Schlüssel sind nicht geheim, die Liste bleibt trotzdem hinter der Anmeldung.
router.get('/empfaenger', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  let ausUmgebung = [];
  let umgebungsFehler = null;
  try { ausUmgebung = krypto.empfaengerAusUmgebung(); }
  catch (e) { umgebungsFehler = e.message; }

  const zeilen = db.prepare('SELECT id, name, pubkey, created_at, geprueft_am FROM backup_empfaenger ORDER BY LOWER(name)').all();
  const liste = [
    ...ausUmgebung.map(e => ({
      id: null, name: e.name, fest: true,
      fingerabdruck: krypto.fingerabdruck(e.b64), geprueft_am: null,
    })),
    ...zeilen.map(z => {
      let fingerabdruck = null, fehler = null;
      try { fingerabdruck = krypto.schluesselPruefen(z.pubkey).fingerabdruck; }
      catch (e) { fehler = e.message; }
      return {
        id: z.id, name: z.name, fest: false, fingerabdruck, fehler,
        angelegt_am: z.created_at, geprueft_am: z.geprueft_am,
      };
    }),
  ];
  res.json({ empfaenger: liste, umgebungsFehler, verschluesselt: liste.some(e => !e.fehler) });
});

router.post('/empfaenger', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  let name, geprueft;
  try {
    name = krypto.namePruefen((req.body || {}).name);
    geprueft = krypto.schluesselPruefen((req.body || {}).pubkey);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // Namen aus der Umgebung sind belegt — zwei gleichnamige Einträge im Kopf der Datei wären
  // beim Entschlüsseln nicht auseinanderzuhalten.
  try {
    for (const e of krypto.empfaengerAusUmgebung()) {
      if (e.name.toLowerCase() === name.toLowerCase()) {
        return res.status(409).json({ error: `Der Name „${name}" ist bereits in der Server-Konfiguration vergeben.` });
      }
      if (e.b64 === geprueft.b64) {
        return res.status(409).json({ error: `Dieser Schlüssel ist bereits als „${e.name}" in der Server-Konfiguration hinterlegt.` });
      }
    }
  } catch (_) { /* kaputte Umgebung meldet schon GET /empfaenger */ }

  const nameDa = db.prepare('SELECT name FROM backup_empfaenger WHERE LOWER(name) = LOWER(?)').get(name);
  if (nameDa) return res.status(409).json({ error: `Es gibt bereits einen Empfänger namens „${nameDa.name}".` });
  const keyDa = db.prepare('SELECT name FROM backup_empfaenger WHERE pubkey = ?').get(geprueft.b64);
  if (keyDa) return res.status(409).json({ error: `Dieser Schlüssel ist bereits als „${keyDa.name}" hinterlegt.` });

  const r = db.prepare('INSERT INTO backup_empfaenger (name, pubkey, created_by) VALUES (?, ?, ?)')
    .run(name, geprueft.b64, req.user.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'backup_empfaenger_add',
    details: `${name} (${geprueft.fingerabdruck})`, ip: req.ip });
  saveToFile();
  res.status(201).json({ empfaenger: { id: r.lastInsertRowid, name, fingerabdruck: geprueft.fingerabdruck } });
});

// Umbenennen. Den Schlüssel einer bestehenden Zeile zu tauschen ist bewusst nicht vorgesehen:
// Das ist löschen und neu anlegen — nur unübersichtlicher, und die Prüfung müsste ohnehin neu.
router.put('/empfaenger/:id', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM backup_empfaenger WHERE id = ?').get(req.params.id);
  if (!zeile) return res.status(404).json({ error: 'Empfänger nicht gefunden' });
  let name;
  try { name = krypto.namePruefen((req.body || {}).name); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const clash = db.prepare('SELECT id FROM backup_empfaenger WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, zeile.id);
  if (clash) return res.status(409).json({ error: `Es gibt bereits einen Empfänger namens „${name}".` });
  try {
    if (krypto.empfaengerAusUmgebung().some(e => e.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `Der Name „${name}" ist bereits in der Server-Konfiguration vergeben.` });
    }
  } catch (_) {}

  db.prepare('UPDATE backup_empfaenger SET name = ? WHERE id = ?').run(name, zeile.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'backup_empfaenger_rename',
    details: `${zeile.name} → ${name}`, ip: req.ip });
  saveToFile();
  res.json({ empfaenger: { id: zeile.id, name } });
});

router.delete('/empfaenger/:id', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM backup_empfaenger WHERE id = ?').get(req.params.id);
  if (!zeile) return res.status(404).json({ error: 'Empfänger nicht gefunden' });
  db.prepare('DELETE FROM backup_empfaenger WHERE id = ?').run(zeile.id);
  let fingerabdruck = '?';
  try { fingerabdruck = krypto.fingerabdruck(zeile.pubkey); } catch (_) {}
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'backup_empfaenger_remove',
    details: `${zeile.name} (${fingerabdruck})`, ip: req.ip });
  saveToFile();
  // Wie viele bleiben? Bei 0 laufen kuenftige Sicherungen wieder im Klartext — das muss die
  // Oberflaeche sagen koennen, ohne es zu raten.
  let verbleibend = 0;
  try { verbleibend = aktuelleEmpfaenger(db).length; } catch (_) {}
  res.json({ ok: true, verbleibend });
});

// ── Beweis, dass jemand den passenden privaten Schlüssel wirklich hat ──────────────────────────
//
// Ein Schlüssel in der Liste, dessen privaten Teil niemand mehr besitzt, ist die gefährlichste
// Störung dieses Verfahrens: Die Sicherungen laufen weiter und sind unlesbar — das merkt man
// erst, wenn man sie braucht.
//
// Deshalb würfelt der SERVER die Probe und vergleicht selbst. Ein Browser, der bloss „hat
// geklappt" meldet, würde nichts beweisen. Herausgereicht werden dabei nur Zufallszahlen.
const proben = new Map();   // id -> { erwartet, bis }
const PROBE_GUELTIG_MS = 10 * 60 * 1000;

function probenAufraeumen() {
  const jetzt = Date.now();
  for (const [k, v] of proben) if (v.bis < jetzt) proben.delete(k);
}

router.post('/empfaenger/:id/probe', authenticate, authorize('chef'), async (req, res) => {
  probenAufraeumen();
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM backup_empfaenger WHERE id = ?').get(req.params.id);
  if (!zeile) return res.status(404).json({ error: 'Empfänger nicht gefunden' });
  let geprueft;
  try { geprueft = krypto.schluesselPruefen(zeile.pubkey); }
  catch (e) { return res.status(400).json({ error: 'Der hinterlegte Schlüssel ist unbrauchbar: ' + e.message }); }

  const erwartet = crypto.randomBytes(32);
  const container = await krypto.verschluesselnPuffer(erwartet, [{ name: zeile.name, schluessel: geprueft.schluessel }]);
  proben.set(String(zeile.id), { erwartet: erwartet.toString('base64'), bis: Date.now() + PROBE_GUELTIG_MS });
  res.json({ probe: container.toString('base64') });
});

router.post('/empfaenger/:id/probe/bestaetigen', authenticate, authorize('chef'), (req, res) => {
  probenAufraeumen();
  const db = getDb();
  const zeile = db.prepare('SELECT * FROM backup_empfaenger WHERE id = ?').get(req.params.id);
  if (!zeile) return res.status(404).json({ error: 'Empfänger nicht gefunden' });
  const offen = proben.get(String(zeile.id));
  if (!offen) return res.status(410).json({ error: 'Die Probe ist abgelaufen. Bitte noch einmal auf „prüfen" gehen.' });

  const gegeben = String((req.body || {}).klartext || '');
  // Zeitgleicher Vergleich ist hier nicht noetig (Zufallszahlen ohne Bedeutung), aber die Probe
  // ist einmalig: Sie wird IMMER verbraucht, damit niemand raten kann.
  proben.delete(String(zeile.id));
  if (gegeben !== offen.erwartet) {
    return res.status(400).json({ error: 'Mit diesem Schlüssel liess sich die Probe nicht öffnen — er gehört nicht zu diesem Eintrag.' });
  }
  const jetzt = berlinJetzt().slice(0, 16);
  db.prepare('UPDATE backup_empfaenger SET geprueft_am = ?, geprueft_von = ? WHERE id = ?').run(jetzt, req.user.id, zeile.id);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'backup_empfaenger_geprueft',
    details: zeile.name, ip: req.ip });
  saveToFile();
  res.json({ ok: true, geprueft_am: jetzt });
});

// Backup herunterladen (ZIP mit DB + Uploads)
router.get('/download', authenticate, authorize('chef'), (req, res) => {
  saveToFile();

  if (!fs.existsSync(DB_PATH)) {
    return res.status(404).json({ error: 'Datenbank nicht gefunden' });
  }

  logAudit(getDb(), { userId: req.user.id, username: req.user.username, action: 'backup_download', ip: req.ip });

  // Sind Empfaenger hinterlegt, geht die Sicherung verschluesselt hinaus. Sonst wie bisher als
  // Zip — dieses Repo wird auch von Fremdfirmen betrieben, die nichts konfiguriert haben, und
  // deren Sicherung darf durch ein Update nicht stillschweigend aufhoeren zu funktionieren.
  let empfaenger = [];
  try { empfaenger = aktuelleEmpfaenger(getDb()); }
  catch (e) {
    // Lieber gar keine Sicherung als eine, von der niemand weiss, ob sie lesbar ist.
    console.error('BACKUP_EMPFAENGER unbrauchbar:', e.message);
    return res.status(500).json({ error: 'Die Empfänger für verschlüsselte Sicherungen sind falsch hinterlegt: ' + e.message });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `arbeitsdoku_backup_${timestamp}` + (empfaenger.length ? '.adbk' : '.zip');

  res.setHeader('Content-Type', empfaenger.length ? 'application/octet-stream' : 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Backup-Archiv Fehler:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Backup fehlgeschlagen' });
  });
  if (empfaenger.length) {
    const schloss = krypto.verschluesselnStream(empfaenger);
    schloss.on('error', (err) => {
      console.error('Backup-Verschlüsselung fehlgeschlagen:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Backup fehlgeschlagen' });
    });
    archive.pipe(schloss).pipe(res);
  } else {
    archive.pipe(res);
  }

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

  // Dokumenten-Ablage zusaetzlich sichern (Prefix 'documents/'); uploads bleibt unveraendert
  walkUploads(documentsDir, 'documents');
  // Profilbilder (Prefix 'avatare/'). Ohne diese Zeile faenden sich nach einem Restore alle
  // Gesichter durch Initialen ersetzt — die Datenbank wuesste noch von den Bildern, die Dateien
  // waeren aber weg.
  walkUploads(avatarDir, 'avatare');

  archive.finalize();
});

// Das Hilfsprogramm fuer den Ernstfall herausgeben — eine einzelne, in sich geschlossene Datei.
//
// Sie wird hier zusammengesetzt statt fertig im Repo zu liegen: Die Entschluesselung steht in
// public/js/sicherung-krypto.js und wird von der Einstellungsseite GENAUSO benutzt. Gaebe es zwei
// Fassungen, waere die selten benutzte irgendwann die kaputte — und genau die braucht man dann.
router.get('/entschluesseler', authenticate, authorize('chef'), (req, res) => {
  try {
    const huelle = path.join(__dirname, '..', 'werkzeuge', 'sicherung-entschluesseln.html');
    const kryptoJs = path.join(__dirname, '..', 'public', 'js', 'sicherung-krypto.js');
    let html = fs.readFileSync(huelle, 'utf8');
    const marke = '<script src="../public/js/sicherung-krypto.js"></script><!--KRYPTO-EINBETTEN-->';
    if (!html.includes(marke)) {
      // Lieber laut scheitern als eine Datei ausliefern, die im Ernstfall nichts tut.
      throw new Error('Einbettungsstelle im Hilfsprogramm nicht gefunden');
    }
    html = html.replace(marke, '<script>\n' + fs.readFileSync(kryptoJs, 'utf8') + '\n</script>');
    logAudit(getDb(), { userId: req.user.id, username: req.user.username, action: 'backup_werkzeug', ip: req.ip });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sicherung-entschluesseln.html"');
    res.send(html);
  } catch (e) {
    console.error('Entschlüsseler ausliefern fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Das Hilfsprogramm konnte nicht erzeugt werden.' });
  }
});

// Backup wiederherstellen (ZIP oder SQLite)
router.post('/restore', authenticate, authorize('chef'), restoreUpload, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Backup-Datei hochgeladen' });
  }

  try {
    const buffer = fs.readFileSync(req.file.path);

    // Eine verschluesselte Sicherung kann der Server NICHT oeffnen — das ist der Zweck der
    // Uebung, nicht ein Mangel. Normalerweise entschluesselt die Oberflaeche vorher im Browser;
    // landet die Datei trotzdem hier (aelterer Browser, Skript), erklaert die Meldung den Weg,
    // statt einen unverstaendlichen Fehler zu werfen.
    if (krypto.istContainer(buffer)) {
      const namen = krypto.empfaengerNamen(buffer);
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        code: 'SICHERUNG_VERSCHLUESSELT',
        empfaenger: namen,
        error: 'Diese Sicherung ist verschlüsselt. Der Server kann sie absichtlich nicht öffnen — '
             + 'bitte oben den Schlüssel eingeben, dann entschlüsselt dein Browser sie selbst. '
             + (namen.length ? `Hinterlegte Schlüssel: ${namen.join(', ')}.` : ''),
      });
    }

    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;

    let dbBuffer;
    let uploadFiles = []; // [{name, data}]
    let documentFiles = []; // [{name, data}] — Dokumenten-Ablage (storage/documents/)
    let avatarFiles = [];   // [{name, data}] — Profilbilder (storage/avatare/)

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

      // Dokumenten-Ablage sammeln: documents/<basename> (flach, Path-Traversal-Schutz)
      const docsResolved = path.resolve(documentsDir);
      entries.forEach(e => {
        if (!e.entryName.startsWith('documents/') || e.isDirectory) return;
        const rel = e.entryName.slice('documents/'.length);
        if (!rel || rel.includes('/') || rel.includes('..') || rel.startsWith('.')) {
          console.warn('Backup-Restore: Dokument uebersprungen (verdaechtiger Name):', e.entryName);
          return;
        }
        const safeName = path.basename(rel);
        const finalPath = path.resolve(documentsDir, safeName);
        if (!finalPath.startsWith(docsResolved + path.sep)) {
          console.warn('Backup-Restore: Dokument uebersprungen (Pfad ausserhalb storage):', e.entryName);
          return;
        }
        documentFiles.push({ name: safeName, data: e.getData() });
      });

      // Profilbilder sammeln — gleiches Muster, gleicher Schutz gegen Pfad-Tricks.
      // Fehlt der Ordner im Zip (Sicherung von vor diesem Feature), passiert hier schlicht nichts.
      const avatarResolved = path.resolve(avatarDir);
      entries.forEach(e => {
        if (!e.entryName.startsWith('avatare/') || e.isDirectory) return;
        const rel = e.entryName.slice('avatare/'.length);
        if (!rel || rel.includes('/') || rel.includes('..') || rel.startsWith('.')) {
          console.warn('Backup-Restore: Profilbild uebersprungen (verdaechtiger Name):', e.entryName);
          return;
        }
        const safeName = path.basename(rel);
        const finalPath = path.resolve(avatarDir, safeName);
        if (!finalPath.startsWith(avatarResolved + path.sep)) {
          console.warn('Backup-Restore: Profilbild uebersprungen (Pfad ausserhalb storage):', e.entryName);
          return;
        }
        avatarFiles.push({ name: safeName, data: e.getData() });
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

    // DB wiederherstellen (atomar, damit ein Abbruch die bestehende DB nicht zerstoert)
    writeFileAtomic(DB_PATH, Buffer.from(dbBuffer));

    // Uploads wiederherstellen (Subordner werden bei Bedarf angelegt)
    if (uploadFiles.length > 0) {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      uploadFiles.forEach(f => {
        const target = path.join(uploadsDir, f.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.data);
      });
    }

    // Dokumenten-Ablage wiederherstellen
    if (documentFiles.length > 0) {
      if (!fs.existsSync(documentsDir)) fs.mkdirSync(documentsDir, { recursive: true });
      documentFiles.forEach(f => {
        fs.writeFileSync(path.join(documentsDir, f.name), f.data);
      });
    }

    // Profilbilder wiederherstellen
    if (avatarFiles.length > 0) {
      if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
      avatarFiles.forEach(f => {
        fs.writeFileSync(path.join(avatarDir, f.name), f.data);
      });
    }

    fs.unlinkSync(req.file.path);

    // DB neu laden
    reloadFromFile(DB_PATH);

    // Audit in die wiederhergestellte DB schreiben (ensureAuditSchema hat audit_logs garantiert)
    logAudit(getDb(), {
      userId: req.user.id, username: req.user.username, action: 'backup_restore',
      // Ersetzt die komplette Datenbank — ein Abrechnungs-Stichtag kann das nicht abfangen.
      // Deshalb hier wenigstens festhalten, ob abgerechnete Zeitraeume betroffen waren.
      details: `Safety-Backup: ${path.basename(safetyZipPath)}, ${uploadFiles.length} Upload-Datei(en), ${documentFiles.length} Dokument(e), ${avatarFiles.length} Profilbild(er)`
        + (abgerechnetBis(getDb()) ? ` — BETRIFFT ABGERECHNETE ZEITRÄUME (bis ${abgerechnetBis(getDb())})` : ''),
      ip: req.ip,
    });

    res.json({
      success: true,
      message: `Backup erfolgreich wiederhergestellt (DB + ${uploadFiles.length} Datei${uploadFiles.length !== 1 ? 'en' : ''} + ${documentFiles.length} Dokument${documentFiles.length !== 1 ? 'e' : ''})`,
      safetyBackup: path.basename(safetyZipPath)
    });
  } catch (error) {
    console.error('Backup-Wiederherstellung fehlgeschlagen:', error);
    res.status(500).json({ error: 'Wiederherstellung fehlgeschlagen' });
  }
});

module.exports = router;
