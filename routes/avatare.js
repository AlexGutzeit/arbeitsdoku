// Profilbilder. Gemountet unter /api/avatare (server.js).
//
// Ein Gesichtsfoto ist ein personenbezogenes Datum — die Bilder liegen deshalb NICHT im öffentlich
// ausgelieferten `uploads/`-Verzeichnis wie das Firmenlogo, sondern unter `storage/avatare/` und
// werden nur an Angemeldete herausgegeben. Wer die App verlässt, kommt auch nicht mehr an die
// Bilder der Kollegen.
//
// Alle Bilder werden beim Hochladen auf ein quadratisches WebP von 256 px gerechnet (sharp, ist
// für Logo und App-Symbol ohnehin schon im Einsatz). Damit ist die Dateigröße unabhängig davon,
// was jemand hochlädt — ein 12-MB-Handyfoto landet als ~15 kB auf der Platte.
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

const bilderDir = path.join(__dirname, '..', 'storage', 'avatare');
function verzeichnisSichern() { if (!fs.existsSync(bilderDir)) fs.mkdirSync(bilderDir, { recursive: true }); }
// ZWEI Groessen je Person, aus demselben Original gerechnet — wie beim App-Symbol:
//   klein (96 px)  fuer Kopfzeile, Spaltenkoepfe, Listen. Das ist der Alltagsfall; bei 24-32 px
//                  Anzeige reicht 96 auch auf hochaufloesenden Handys dreifach.
//   gross (512 px) fuer die Vorschau auf „Mein Konto" und eine spaetere Kollegen-Profilansicht.
// Das grosse Bild ist zugleich das Original im Bestand: Braucht man spaeter eine dritte Groesse,
// laesst sie sich daraus rechnen, ohne dass jemand neu hochladen muss.
const GROESSEN = { klein: 96, gross: 512 };
const dateiFuer = (userId, groesse = 'klein') =>
  path.join(bilderDir, `${Number(userId)}${groesse === 'gross' ? '-gross' : ''}.webp`);

// Grosszuegig beim Hochladen (Handyfotos sind gross), streng beim Ablegen: sharp rechnet alles auf
// dieselbe kleine Kantenlaenge herunter.
const EINGANG_MAX = 12 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: EINGANG_MAX } });

const ERLAUBT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'];

function standFuer(db, userId) {
  try {
    const r = db.prepare('SELECT updated_at FROM user_avatars WHERE user_id = ?').get(userId);
    return r ? r.updated_at : null;
  } catch (_) { return null; }
}

// Wer hat ein Bild? Eine Abfrage für die ganze Mannschaft — die Oberfläche braucht das beim
// Aufbau jeder Liste und soll dafür nicht pro Person nachfragen müssen.
router.get('/', authenticate, (req, res) => {
  try {
    const reihen = getDb().prepare('SELECT user_id, updated_at FROM user_avatars').all();
    const stand = {};
    for (const r of reihen) stand[r.user_id] = r.updated_at;
    res.json({ stand });
  } catch (_) { res.json({ stand: {} }); }
});

// Bild ausliefern. Nur für Angemeldete — deshalb hier und nicht als statische Datei.
router.get('/:id', authenticate, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  // ?g=gross liefert die hohe Aufloesung; ohne Angabe die kleine (der Alltagsfall).
  const groesse = req.query.g === 'gross' ? 'gross' : 'klein';
  let datei = dateiFuer(id, groesse);
  // Rueckfall auf die andere Groesse, falls ein Bild aus einer aelteren Fassung nur einmal vorliegt.
  if (!fs.existsSync(datei)) datei = dateiFuer(id, groesse === 'gross' ? 'klein' : 'gross');
  if (!fs.existsSync(datei)) return res.status(404).json({ error: 'Kein Bild' });
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Privat zwischenspeichern: Das Bild gehört zu einer Person, es hat in keinem gemeinsamen
  // Zwischenspeicher (Proxy) etwas verloren. Die Frischemarke steckt in der Adresse (?stand=…).
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(datei).pipe(res);
});

// Eigenes Bild setzen. Bewusst OHNE Nutzer-Kennung im Pfad: Man kann darüber nur das eigene ändern.
router.post('/', authenticate, (req, res) => {
  upload.single('bild')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `Bild zu groß (max. ${Math.round(EINGANG_MAX / 1024 / 1024)} MB).` });
      }
      return res.status(400).json({ error: 'Upload fehlgeschlagen' });
    }
    if (!req.file) return res.status(400).json({ error: 'Kein Bild hochgeladen' });
    if (!ERLAUBT.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Dateiformat nicht erlaubt (JPG, PNG, WebP, GIF, HEIC).' });
    }
    try {
      verzeichnisSichern();
      // `cover` schneidet mittig zu — ein Hochformat-Foto wird also zum Quadrat, ohne zu verzerren.
      // `rotate()` ohne Argument wertet die Ausrichtung aus dem Foto aus; ohne das lägen
      // Handyfotos quer.
      // `cover` schneidet mittig zu, `position: attention` sucht dabei den interessantesten
      // Bildausschnitt — bei Portraits landet damit das Gesicht im Kreis und nicht die Schulter.
      for (const [name, kante] of Object.entries(GROESSEN)) {
        const bild = await sharp(req.file.buffer)
          .rotate()
          .resize(kante, kante, { fit: 'cover', position: 'attention' })
          .webp({ quality: name === 'gross' ? 86 : 80 })
          .toBuffer();
        fs.writeFileSync(dateiFuer(req.user.id, name), bild);
      }

      const db = getDb();
      const jetzt = new Date().toISOString();
      db.prepare(`INSERT INTO user_avatars (user_id, updated_at) VALUES (?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(req.user.id, jetzt);
      logAudit(db, { userId: req.user.id, username: req.user.username, action: 'avatar_gesetzt', ip: req.ip });
      res.json({ success: true, stand: jetzt });
    } catch (e) {
      // sharp wirft bei allem, was kein Bild ist — das ist zugleich die Inhaltsprüfung.
      console.error('Avatar verarbeiten fehlgeschlagen:', e.message);
      res.status(400).json({ error: 'Das Bild konnte nicht verarbeitet werden.' });
    }
  });
});

router.delete('/', authenticate, (req, res) => {
  try {
    for (const name of Object.keys(GROESSEN)) {
      try { fs.unlinkSync(dateiFuer(req.user.id, name)); } catch (_) { /* schon weg */ }
    }
    const db = getDb();
    db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(req.user.id);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'avatar_entfernt', ip: req.ip });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Interner Serverfehler' }); }
});

module.exports = router;
module.exports.standFuer = standFuer;
module.exports.dateiFuer = dateiFuer;
module.exports.GROESSEN = GROESSEN;
