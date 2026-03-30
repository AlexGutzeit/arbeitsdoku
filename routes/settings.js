const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

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
  const { company_name, company_street, company_zip, company_city } = req.body;

  const fields = { company_name, company_street, company_zip, company_city };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
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
  res.json({ success: true });
});

module.exports = router;
