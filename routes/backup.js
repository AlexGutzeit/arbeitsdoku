const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const dbModule = require('../database/init');
const { getDb, setDb, saveToFile, datenbankVorbereiten, writeFileAtomic, DB_PATH } = dbModule;
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { abgerechnetBis } = require('../abschluss');
const krypto = require('../backup-krypto');
const { berlinJetzt } = require('../zeit');

const router = express.Router();

const backupDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const APP = path.join(__dirname, '..');
const uploadsDir = path.join(APP, 'uploads');
const documentsDir = path.join(APP, 'storage', 'documents');
const avatarDir = path.join(APP, 'storage', 'avatare');

// Was in eine Sicherung gehoert — EINE Liste fuer den Download und fuer die Sicherheitskopie vor
// dem Zurueckspielen. Vorher standen die Teile doppelt, und die Sicherheitskopie hatte Dokumente,
// Profilbilder und App-Icons vergessen (R3). scripts/make-backup.js packt dieselben Teile, laeuft
// aber absichtlich als eigener Prozess ohne diese Datei (s. dort).
//
// Uebersprungen: die multer-Zwischenablage `tmp` und Arbeitsordner eines laufenden Zurueckspielens.
function sicherungsDateien() {
  const liste = [{ quelle: DB_PATH, name: 'arbeitsdoku.db' }];
  const lauf = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const eintrag of fs.readdirSync(dir)) {
      if (eintrag === 'tmp' || eintrag.startsWith(ARBEITSORDNER)) continue;
      const voll = path.join(dir, eintrag);
      try {
        const st = fs.statSync(voll);
        if (st.isFile()) liste.push({ quelle: voll, name: prefix + '/' + eintrag });
        else if (st.isDirectory()) lauf(voll, prefix + '/' + eintrag);
      } catch (_) { /* waehrend des Laufs verschwunden: ueberspringen */ }
    }
  };
  lauf(uploadsDir, 'uploads');
  lauf(documentsDir, 'documents');
  // Ohne die Profilbilder faenden sich nach einem Restore alle Gesichter durch Initialen ersetzt —
  // die Datenbank wuesste noch von den Bildern, die Dateien waeren aber weg.
  lauf(avatarDir, 'avatare');
  return liste;
}

// Wo die naechtlichen Sicherungen liegen — dieselbe Regel wie in scripts/make-backup.js (ohne
// Aufrufargument, so ruft cron es auf): BACKUP_OUT relativ zur App, sonst ../arbeitsdoku-backups.
// Die Sicherheitskopie vor dem Zurueckspielen kommt DORTHIN (Alex, 25.09.2026): Dann raeumt die
// naechtliche Sicherung sie mit auf, und der Mini-PC holt sie mit ab.
function sicherungsOrdner() {
  return process.env.BACKUP_OUT ? path.resolve(APP, process.env.BACKUP_OUT)
                                : path.join(path.dirname(APP), 'arbeitsdoku-backups');
}

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

  // Datenbank, Uploads (samt icons/), Dokumente, Profilbilder
  for (const d of sicherungsDateien()) archive.file(d.quelle, { name: d.name });
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

// ── Zurueckspielen (R3, 25.09.2026) ───────────────────────────────────────────────────────────
//
// Vorher: DB-Datei ersetzen → Dateien einzeln schreiben → erst am Ende neu laden. Brach es
// dazwischen ab (volle Platte), meldete die App „fehlgeschlagen", auf der Platte lag die NEUE
// Datenbank, im Speicher die ALTE, und die Dateien waren halb ersetzt. Welcher Stand danach galt,
// entschied der Zufall: speicherte die App zuerst (Autosave), die alte — startete der Server
// zuerst neu, die neue.
//
// Jetzt fuenf Schritte. Alles, was scheitern kann, kommt VOR dem ersten Eingriff:
//   1. Pruefen        — die Datenbank aus der Sicherung vollstaendig oeffnen und hochziehen
//   2. Sicherheitskopie — vollstaendig, verschluesselt wie die naechtliche; ohne sie kein Weiter
//   3. Bereitlegen    — alle neuen Dateien schreiben, NEBEN ihr Ziel (volle Platte scheitert hier)
//   4. Einsetzen      — nur noch Umbenennen; jede Aktion wird notiert und bei Fehler rueckwaerts
//                       zurueckgenommen, die Datenbank im Speicher wird erst ganz am Ende getauscht
//   5. Aufraeumen
// Schritte 3–5 laufen ohne `await` am Stueck — dazwischen kann keine andere Anfrage und kein
// Autosave etwas schreiben.
//
// Dateien, die NICHT in der Sicherung stehen, bleiben liegen (wie bisher). Wer eine alte Sicherung
// ohne documents/ zurueckspielt, soll dadurch nicht seine ganze Dokumentenablage verlieren.

const ARBEITSORDNER = '.rueckspielen-';
let rueckspielenLaeuft = false;

// Datei-Fehler fuer Menschen. Der Rohtext („ENOSPC: no space left on device, open '/home/…'")
// ist englisch und nennt Serverpfade (vgl. R9) — er gehoert ins Protokoll, nicht in die Meldung.
function dateiFehlerText(e) {
  const code = e && e.code;
  if (code === 'ENOSPC') return 'kein Speicherplatz mehr frei';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'fehlende Schreibrechte';
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'der Sicherungsordner ist kein Ordner (BACKUP_OUT prüfen)';
  return 'unerwarteter Fehler — Einzelheiten im Server-Protokoll';
}

// Zeitstempel wie in scripts/make-backup.js — nur dann sortiert die Aufraeum-Regel dort die
// Sicherheitskopie richtig zwischen die naechtlichen Sicherungen ein.
function sicherungsZeitstempel(n = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

// 2. Sicherheitskopie des JETZIGEN Stands — so vollstaendig und so verschluesselt wie die
// naechtliche Sicherung, im selben Ordner, mit derselben Namensregel (plus „_vor-rueckspielen").
// Die `.env` kommt nach derselben harten Regel wie dort NUR in die verschluesselte Fassung.
// Liefert den Dateinamen; wirft, wenn sie nicht vollstaendig geschrieben werden konnte.
function sicherheitskopieAnlegen(db) {
  return new Promise((erfuellen, ablehnen) => {
    let empfaenger;
    try { empfaenger = aktuelleEmpfaenger(db); } catch (e) { e.empfaenger = true; return ablehnen(e); }
    const verschluesselt = empfaenger.length > 0;
    let ziel, tmp;
    try {
      saveToFile();
      const ordner = sicherungsOrdner();
      fs.mkdirSync(ordner, { recursive: true });
      ziel = path.join(ordner, `arbeitsdoku_backup_${sicherungsZeitstempel()}_vor-rueckspielen.${verschluesselt ? 'adbk' : 'zip'}`);
      tmp = ziel + '.part';
    } catch (e) { return ablehnen(e); }

    let erledigt = false;
    const fehler = (e) => {
      if (erledigt) return;
      erledigt = true;
      try { fs.unlinkSync(tmp); } catch (_) {}
      ablehnen(e);
    };
    const ausgabe = fs.createWriteStream(tmp);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', fehler);
    ausgabe.on('error', fehler);
    ausgabe.on('close', () => {
      if (erledigt) return;
      erledigt = true;
      try { fs.renameSync(tmp, ziel); erfuellen(path.basename(ziel)); }   // erst vollstaendig sichtbar
      catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} ablehnen(e); }
    });
    if (verschluesselt) {
      const schloss = krypto.verschluesselnStream(empfaenger);
      schloss.on('error', fehler);
      archive.pipe(schloss).pipe(ausgabe);
    } else {
      archive.pipe(ausgabe);
    }
    for (const d of sicherungsDateien()) archive.file(d.quelle, { name: d.name });
    const envPfad = path.join(APP, '.env');
    if (verschluesselt && fs.existsSync(envPfad)) archive.file(envPfad, { name: '.env' });
    archive.finalize();
  });
}

// 3.–5. Bereitlegen, Einsetzen, Aufraeumen — synchron, am Stueck.
//
// Bereitgelegt wird NEBEN dem Ziel, in einem Arbeitsordner im selben Verzeichnis: Nur innerhalb
// eines Dateisystems ist Umbenennen atomar und braucht keinen Platz. Liegen storage/ und die App
// auf verschiedenen Platten (z. B. ein eingehaengtes Volume), schlaege ein Umbenennen quer
// darueber fehl — und zwar erst beim Einsetzen.
//
// Wirft bei Fehler einen Error mit `.zurueckgerollt` (true: alles wie vorher; false: Zurueckrollen
// unvollstaendig, Arbeitsordner bleiben liegen, weil darin die einzigen alten Fassungen stecken).
function einsetzen(neueDb, dbPuffer, dateien) {
  const marke = ARBEITSORDNER + Date.now() + '-' + process.pid;
  const arbeitsordner = new Set();
  const zwischen = (ziel, art) => {
    const ordner = path.join(path.dirname(ziel), marke);
    arbeitsordner.add(ordner);
    return path.join(ordner, art, path.basename(ziel));
  };
  const aufraeumen = () => {
    for (const o of arbeitsordner) {
      try { fs.rmSync(o, { recursive: true, force: true }); }
      catch (e) { console.error('Zurückspielen: Arbeitsordner nicht entfernt:', o, e.message); }
    }
  };

  // 3. Bereitlegen — hier scheitert eine volle Platte, bevor am Bestand etwas passiert ist.
  try {
    for (const d of dateien) {
      d.bereit = zwischen(d.ziel, 'neu');
      fs.mkdirSync(path.dirname(d.bereit), { recursive: true });
      fs.writeFileSync(d.bereit, d.data);
    }
  } catch (e) {
    aufraeumen();
    e.zurueckgerollt = true;
    e.schritt = 'bereitlegen';
    throw e;
  }

  // 4. Einsetzen — jede Aktion kommt ins Protokoll, damit sie rueckwaerts zurueckgenommen werden kann.
  saveToFile();
  const altDbPuffer = fs.readFileSync(DB_PATH);
  const erledigt = [];
  try {
    writeFileAtomic(DB_PATH, dbPuffer);
    erledigt.push({ art: 'db' });
    for (const d of dateien) {
      if (fs.existsSync(d.ziel)) {
        const weg = zwischen(d.ziel, 'alt');
        fs.mkdirSync(path.dirname(weg), { recursive: true });
        fs.renameSync(d.ziel, weg);
        erledigt.push({ art: 'weggelegt', ziel: d.ziel, weg });
      }
      fs.mkdirSync(path.dirname(d.ziel), { recursive: true });
      fs.renameSync(d.bereit, d.ziel);
      erledigt.push({ art: 'eingesetzt', ziel: d.ziel });
    }
  } catch (e) {
    const offen = [];
    for (const s of erledigt.reverse()) {
      try {
        if (s.art === 'eingesetzt') fs.unlinkSync(s.ziel);
        else if (s.art === 'weggelegt') fs.renameSync(s.weg, s.ziel);
        else if (s.art === 'db') writeFileAtomic(DB_PATH, altDbPuffer);
      } catch (e2) {
        offen.push(s);
        console.error('Zurückspielen: Zurückrollen unvollständig bei', s, e2.message);
      }
    }
    // Die Datenbank im Speicher ist noch die alte — getauscht wird erst unten. Das Autosave
    // schreibt also, wenn ueberhaupt, den alten Stand.
    e.zurueckgerollt = offen.length === 0;
    e.schritt = 'einsetzen';
    if (e.zurueckgerollt) aufraeumen();
    throw e;
  }

  // Ab hier kann nichts mehr scheitern: die Datenbank im Speicher tauschen.
  setDb(neueDb);

  // 5. Aufraeumen — in den Arbeitsordnern liegen nur noch die alten Fassungen (die stecken
  // vollstaendig in der Sicherheitskopie).
  aufraeumen();
}

// Nur ein Zurueckspielen zur Zeit: Waehrend das erste an der Sicherheitskopie schreibt, darf kein
// zweites dazwischen einsetzen.
router.post('/restore', authenticate, authorize('chef'), restoreUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Backup-Datei hochgeladen' });
  }
  if (rueckspielenLaeuft) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(409).json({ error: 'Es wird gerade schon eine Sicherung zurückgespielt. Bitte warten, bis das fertig ist.' });
  }
  rueckspielenLaeuft = true;
  try {
    await rueckspielen(req, res);
  } catch (error) {
    console.error('Backup-Wiederherstellung fehlgeschlagen:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Wiederherstellung fehlgeschlagen' });
  } finally {
    rueckspielenLaeuft = false;
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}
  }
});

async function rueckspielen(req, res) {
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
        console.warn('Backup-Restore: Eintrag übersprungen (verdächtiger Name):', e.entryName);
        return;
      }
      const parts = rel.split('/');
      let safeRel;
      if (parts.length === 1) {
        safeRel = path.basename(parts[0]);
      } else if (parts.length === 2 && ALLOWED_SUBDIRS.includes(parts[0])) {
        const subFile = path.basename(parts[1]);
        if (!subFile || subFile.startsWith('.')) {
          console.warn('Backup-Restore: Eintrag übersprungen (Subfile-Name verdächtig):', e.entryName);
          return;
        }
        safeRel = parts[0] + '/' + subFile;
      } else {
        console.warn('Backup-Restore: Eintrag übersprungen (Subpfad nicht erlaubt):', e.entryName);
        return;
      }
      const finalPath = path.resolve(uploadsDir, safeRel);
      if (!finalPath.startsWith(uploadsResolved + path.sep)) {
        console.warn('Backup-Restore: Eintrag übersprungen (Pfad ausserhalb uploads):', e.entryName);
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
        console.warn('Backup-Restore: Dokument übersprungen (verdächtiger Name):', e.entryName);
        return;
      }
      const safeName = path.basename(rel);
      const finalPath = path.resolve(documentsDir, safeName);
      if (!finalPath.startsWith(docsResolved + path.sep)) {
        console.warn('Backup-Restore: Dokument übersprungen (Pfad ausserhalb storage):', e.entryName);
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
        console.warn('Backup-Restore: Profilbild übersprungen (verdächtiger Name):', e.entryName);
        return;
      }
      const safeName = path.basename(rel);
      const finalPath = path.resolve(avatarDir, safeName);
      if (!finalPath.startsWith(avatarResolved + path.sep)) {
        console.warn('Backup-Restore: Profilbild übersprungen (Pfad ausserhalb storage):', e.entryName);
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

  // 1. Pruefen: die Datenbank so oeffnen, wie sie gleich laufen soll — inklusive Hochziehen auf
  //    den aktuellen Stand. Frueher geschah das erst NACH dem Ersetzen der Datei.
  let neueDb;
  try {
    neueDb = datenbankVorbereiten(dbBuffer);
  } catch (e) {
    console.error('Zurückspielen: Datenbank aus der Sicherung nicht nutzbar:', e);
    return res.status(400).json({ error: 'Die Datenbank aus der Sicherung lässt sich nicht öffnen. Es wurde nichts verändert.' });
  }

  // 2. Sicherheitskopie — ohne sie wird nicht zurueckgespielt.
  let kopie;
  try {
    kopie = await sicherheitskopieAnlegen(getDb());
  } catch (e) {
    console.error('Zurückspielen: Sicherheitskopie fehlgeschlagen:', e);
    neueDb._db.close();
    const grund = e.empfaenger ? 'die Schlüssel für verschlüsselte Sicherungen sind falsch hinterlegt' : dateiFehlerText(e);
    return res.status(500).json({ error: `Die Sicherheitskopie des jetzigen Stands ließ sich nicht anlegen (${grund}). `
      + 'Ohne sie wird nicht zurückgespielt — es wurde nichts verändert.' });
  }

  // 3.–5. Bereitlegen, Einsetzen, Aufraeumen
  const dateien = [
    ...uploadFiles.map(f => ({ ziel: path.join(uploadsDir, f.name), data: f.data })),
    ...documentFiles.map(f => ({ ziel: path.join(documentsDir, f.name), data: f.data })),
    ...avatarFiles.map(f => ({ ziel: path.join(avatarDir, f.name), data: f.data })),
  ];
  try {
    einsetzen(neueDb, Buffer.from(dbBuffer), dateien);
  } catch (e) {
    console.error(`Zurückspielen abgebrochen (${e.schritt}), zurückgerollt: ${e.zurueckgerollt}:`, e);
    neueDb._db.close();
    if (e.zurueckgerollt) {
      return res.status(500).json({ error: `Das Zurückspielen wurde abgebrochen (${dateiFehlerText(e)}). `
        + 'Es gilt weiterhin der Stand von vorher — es wurde nichts verändert.' });
    }
    return res.status(500).json({ error: `Das Zurückspielen wurde abgebrochen (${dateiFehlerText(e)}), und der vorherige `
      + `Stand ließ sich nicht vollständig wiederherstellen. Bitte nichts mehr ändern und die Sicherheitskopie „${kopie}" zurückspielen.` });
  }

  // Audit in die wiederhergestellte DB schreiben (ensureAuditSchema hat audit_logs garantiert)
  logAudit(getDb(), {
    userId: req.user.id, username: req.user.username, action: 'backup_restore',
    // Ersetzt die komplette Datenbank — ein Abrechnungs-Stichtag kann das nicht abfangen.
    // Deshalb hier wenigstens festhalten, ob abgerechnete Zeitraeume betroffen waren.
    details: `Sicherheitskopie: ${kopie}, ${uploadFiles.length} Upload-Datei(en), ${documentFiles.length} Dokument(e), ${avatarFiles.length} Profilbild(er)`
      + (abgerechnetBis(getDb()) ? ` — BETRIFFT ABGERECHNETE ZEITRÄUME (bis ${abgerechnetBis(getDb())})` : ''),
    ip: req.ip,
  });

  res.json({
    success: true,
    message: `Backup erfolgreich wiederhergestellt (DB + ${uploadFiles.length} Datei${uploadFiles.length !== 1 ? 'en' : ''} + ${documentFiles.length} Dokument${documentFiles.length !== 1 ? 'e' : ''})`,
    safetyBackup: kopie
  });
}

module.exports = router;
