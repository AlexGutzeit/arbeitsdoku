const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');

const router = express.Router();

const PWA_SIZES = [16, 32, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const iconsDir = path.join(__dirname, '..', 'uploads', 'icons');
function ensureIconsDir() {
  if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
}

// Logo-Upload konfigurieren
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'logo' + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Nur PNG und JPG Dateien erlaubt'));
    }
  }
});

// Wetter-Endpunkt: Server holt Geocoding (Nominatim) + Wetter (Open-Meteo)
let weatherCache = { data: null, ts: 0 };
router.get('/weather', authenticate, async (req, res) => {
  const db = getDb();
  const city = db.prepare("SELECT value FROM settings WHERE key = 'company_city'").get()?.value || '';
  const zip = db.prepare("SELECT value FROM settings WHERE key = 'company_zip'").get()?.value || '';
  if (!city && !zip) return res.json({ error: 'Kein Ort konfiguriert', city: '' });

  // Cache: max 15 Minuten
  if (weatherCache.data && (Date.now() - weatherCache.ts) < 15 * 60 * 1000) {
    return res.json(weatherCache.data);
  }

  try {
    // Geocoding via Nominatim (OpenStreetMap)
    const query = zip && city ? `${zip} ${city}` : (city || zip);
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Arbeitsdoku/1.0' } }
    );
    const geoData = await geoRes.json();
    if (!geoData.length) return res.json({ error: 'Ort nicht gefunden', city: city || zip });

    const lat = geoData[0].lat;
    const lon = geoData[0].lon;

    // Wetter via Open-Meteo (aktuell + stündlich + täglich)
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset&timezone=Europe/Berlin&forecast_days=1`);
    const wData = await wRes.json();

    const result = { city: city || zip, current: wData.current, hourly: wData.hourly, daily: wData.daily };
    weatherCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('Weather error:', e.message, e.cause || '');
    res.json({ error: 'Wetterdaten nicht verfügbar', city: city || zip });
  }
});

// Einstellungen abrufen
router.get('/', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json({ settings });
});

// Einstellungen aktualisieren
router.put('/', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const {
    company_name, company_street, company_zip, company_city,
    app_name, app_short_name, theme_color, background_color,
  } = req.body;

  // Validierung Branding-Felder
  if (app_short_name !== undefined && typeof app_short_name === 'string' && app_short_name.length > 12) {
    return res.status(400).json({ error: 'Short-Name darf maximal 12 Zeichen haben' });
  }
  if (app_name !== undefined && typeof app_name === 'string' && app_name.length > 60) {
    return res.status(400).json({ error: 'App-Name darf maximal 60 Zeichen haben' });
  }
  if (theme_color !== undefined && theme_color !== '' && !HEX_RE.test(theme_color)) {
    return res.status(400).json({ error: 'Theme-Color muss Hex-Format #RRGGBB sein' });
  }
  if (background_color !== undefined && background_color !== '' && !HEX_RE.test(background_color)) {
    return res.status(400).json({ error: 'Hintergrund-Color muss Hex-Format #RRGGBB sein' });
  }

  const fields = {
    company_name, company_street, company_zip, company_city,
    app_name, app_short_name, theme_color, background_color,
  };
  const changes = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      const oldVal = cur ? cur.value : '';
      if (String(oldVal) !== String(value)) changes.push(`${key}: "${oldVal}" → "${value}"`);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
  if (changes.length) {
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: changes.join('; '), ip: req.ip });
  }

  // Wetter-Cache leeren, damit neuer Ort sofort wirkt
  weatherCache = { data: null, ts: 0 };

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json({ settings });
});

// Logo hochladen
router.post('/logo', authenticate, authorize('chef'), upload.single('logo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  }

  const db = getDb();
  const logoPath = '/uploads/' + req.file.filename;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('company_logo', logoPath);

  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: 'Firmen-Logo gesetzt', ip: req.ip });
  res.json({ logo: logoPath });
});

// Logo löschen
router.delete('/logo', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const logo = db.prepare('SELECT value FROM settings WHERE key = ?').get('company_logo');

  if (logo && logo.value) {
    const filePath = path.join(__dirname, '..', logo.value);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('company_logo', '');
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: 'Firmen-Logo entfernt', ip: req.ip });
  res.json({ success: true });
});

// App-Icon-Upload: Master in uploads/icons/master.png speichern, alle PWA-Groessen generieren
const iconUpload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'tmp'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Nur PNG und JPG Dateien erlaubt'));
  },
});

router.post('/app-icon', authenticate, authorize('chef'), (req, res) => {
  iconUpload.single('icon')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen' });
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    try {
      // Mindestgroesse pruefen
      const meta = await sharp(req.file.path).metadata();
      if (!meta.width || !meta.height || meta.width < 256 || meta.height < 256) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(400).json({ error: 'Icon zu klein, mindestens 256x256 Pixel' });
      }
      ensureIconsDir();
      const masterPath = path.join(iconsDir, 'master.png');
      await sharp(req.file.path).resize(512, 512, { fit: 'cover' }).png().toFile(masterPath);
      // Alle PWA-Groessen aus master generieren
      for (const size of PWA_SIZES) {
        await sharp(masterPath).resize(size, size).png().toFile(path.join(iconsDir, `icon-${size}x${size}.png`));
      }
      // Maskable mit 10% Padding (transparent)
      await sharp(masterPath).resize(410, 410).extend({
        top: 51, bottom: 51, left: 51, right: 51,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      }).png().toFile(path.join(iconsDir, 'maskable-icon-512x512.png'));
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('app_icon_master', '/uploads/icons/master.png');
      logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: 'App-Icon gesetzt', ip: req.ip });
      res.json({ success: true, master: '/uploads/icons/master.png' });
    } catch (e) {
      console.error('Icon-Upload fehlgeschlagen:', e.message);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      res.status(400).json({ error: 'Bild ungueltig oder kann nicht verarbeitet werden' });
    }
  });
});

// App-Icon zuruecksetzen: alle Custom-Icons loeschen, app_icon_master entfernen
router.delete('/app-icon', authenticate, authorize('chef'), (req, res) => {
  try {
    if (fs.existsSync(iconsDir)) {
      for (const f of fs.readdirSync(iconsDir)) {
        try { fs.unlinkSync(path.join(iconsDir, f)); } catch (_) {}
      }
    }
  } catch (e) { console.error('Icon-Reset fehlgeschlagen:', e.message); }
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'app_icon_master'").run();
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: 'App-Icon zurückgesetzt', ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
