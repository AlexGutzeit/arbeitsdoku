const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { istUhrzeit } = require('../zeit');
const zf = require('../zweifaktor');
const totp = require('../totp');
const { MODI, cacheVergessen } = require('../zweifaktor');

const router = express.Router();

const PWA_SIZES = [16, 32, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const iconsDir = path.join(__dirname, '..', 'uploads', 'icons');
function ensureIconsDir() {
  if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
}

// Admin-konfigurierbare max. Dateigröße für Logo UND App-Icon (Default 5 MB), Setting-Key
// `branding_file_limit_bytes`. Clamp 1 MB … 50 MB (Bilder brauchen realistisch nicht mehr).
const BRANDING_DEFAULT = 5 * 1024 * 1024;
const BRANDING_MIN = 1 * 1024 * 1024;
const BRANDING_MAX = 50 * 1024 * 1024;
function getBrandingFileLimit(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'branding_file_limit_bytes'").get();
  const n = row ? parseInt(row.value, 10) : NaN;
  const base = (!Number.isFinite(n) || n <= 0) ? BRANDING_DEFAULT : n;
  return Math.max(BRANDING_MIN, Math.min(base, BRANDING_MAX));
}
const brandingFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.png', '.jpg', '.jpeg'].includes(ext)) cb(null, true);
  else cb(new Error('Nur PNG und JPG Dateien erlaubt'));
};

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

// Logo-Upload: Per-Request-Multer mit aktuellem (konfigurierbarem) Limit + klarer Fehlermeldung.
function logoUpload(req, res, next) {
  const limit = getBrandingFileLimit(getDb());
  const m = multer({ storage, limits: { fileSize: limit }, fileFilter: brandingFileFilter }).single('logo');
  m(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Datei zu groß (max. ${Math.round(limit / (1024 * 1024))} MB)` });
      return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen' });
    }
    next();
  });
}

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

    // Wetter via Open-Meteo (aktuell + stündlich + täglich). forecast_days=7: eine Woche — so weit rechnen die
    // hochauflösenden Modelle, also sind für alle gezeigten Tage echte Stundenwerte verfügbar. Tagesverlauf und
    // früh/mittag/abend-Vorschau kommen aus denselben stündlichen Daten.
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset&timezone=Europe/Berlin&forecast_days=7`);
    const wData = await wRes.json();

    const result = { city: city || zip, current: wData.current, hourly: wData.hourly, daily: wData.daily };
    weatherCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('Weather error:', e.message, e.cause || '');
    // Auch Fehlschläge kurz cachen: Sonst löst JEDER Aufruf der Willkommensseite eine neue Geocoding-Anfrage
    // aus, während der Dienst gestört ist — Nominatim erlaubt ~1 Anfrage/s und sperrt sonst die Server-IP.
    const errResult = { error: 'Wetterdaten nicht verfügbar', city: city || zip };
    weatherCache = { data: errResult, ts: Date.now() - (15 * 60 * 1000) + (2 * 60 * 1000) }; // ~2 Min gültig
    res.json(errResult);
  }
});

// Arbeitszeit-Vorgaben mit Rueckfall. EINE Stelle, damit Zeiteintrag, Planung und Mitarbeiter-Dialog
// nie auseinanderlaufen. Die Vorgaben entsprechen dem, was bisher fest im Code stand (07:00-15:30,
// 30 min Pause) — solange nichts umgestellt wird, aendert sich fuer niemanden etwas.
function arbeitszeitVorgaben(db) {
  const lies = (k) => { try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value; } catch (_) { return undefined; } };
  const beginn = lies('work_start_default');
  const stunden = Number(String(lies('work_hours_per_day') ?? '').replace(',', '.'));
  const pause = parseInt(lies('break_minutes_default'), 10);
  return {
    work_start_default: istUhrzeit(beginn) ? beginn : '07:00',
    work_hours_per_day: (stunden > 0 && stunden <= 24) ? stunden : 8,
    break_minutes_default: (Number.isFinite(pause) && pause >= 0 && pause <= 480) ? pause : 30,
  };
}

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

// Arbeitszeit-Vorgaben der Firma — fuer JEDEN Angemeldeten lesbar.
// Bewusst ein eigener, schmaler Endpunkt statt GET '/' (das ist Chef/Admin-only und liefert alles,
// inklusive Branding und Rechtstexten). Ein Mitarbeiter braucht nur diese drei Werte, damit sein
// Zeiteintrags-Formular und die Planung richtig vorbelegt werden.
router.get('/arbeitszeit', authenticate, (req, res) => {
  res.json({ arbeitszeit: arbeitszeitVorgaben(getDb()) });
});

// Einstellungen aktualisieren
router.put('/', authenticate, authorize('chef'), (req, res) => {
  const db = getDb();
  const {
    company_name, company_street, company_zip, company_city,
    app_name, app_short_name, theme_color, background_color,
    legal_impressum, legal_datenschutz,
    work_start_default, work_hours_per_day, break_minutes_default,
    twofa_admin, twofa_chef, twofa_buchhalter, twofa_mitarbeiter,
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
  // Rechtstexte (Freitext) — nur Längenbegrenzung, damit die DB nicht missbräuchlich aufgebläht wird.
  for (const [k, label] of [['legal_impressum', 'Impressum'], ['legal_datenschutz', 'Datenschutzerklärung']]) {
    const v = req.body[k];
    if (v !== undefined && typeof v === 'string' && v.length > 50000) {
      return res.status(400).json({ error: `${label} darf maximal 50 000 Zeichen haben` });
    }
  }

  // Arbeitszeit-Vorgaben pruefen, bevor sie gespeichert werden — sonst stuende spaeter eine
  // unmoegliche Vorbelegung im Formular.
  if (work_start_default !== undefined && work_start_default !== '' && !istUhrzeit(work_start_default)) {
    return res.status(400).json({ error: 'Arbeitsbeginn: erwartet HH:MM (00:00 bis 23:59)' });
  }
  if (work_hours_per_day !== undefined && work_hours_per_day !== '') {
    const h = Number(String(work_hours_per_day).replace(',', '.'));
    if (!(h > 0 && h <= 24)) return res.status(400).json({ error: 'Arbeitszeit pro Tag: erwartet eine Zahl zwischen 0 und 24' });
  }
  if (break_minutes_default !== undefined && break_minutes_default !== '') {
    const m = Number(break_minutes_default);
    if (!Number.isInteger(m) || m < 0 || m > 480) return res.status(400).json({ error: 'Pause pro Tag: erwartet ganze Minuten zwischen 0 und 480' });
  }

  // Zwei-Faktor-Pflicht je Rolle
  const zweiFaktorFelder = { twofa_admin, twofa_chef, twofa_buchhalter, twofa_mitarbeiter };
  for (const [key, wert] of Object.entries(zweiFaktorFelder)) {
    if (wert === undefined) continue;
    if (!MODI.includes(wert)) {
      return res.status(400).json({ error: `Zwei-Faktor-Einstellung „${key}": erwartet eines von ${MODI.join(', ')}` });
    }
  }
  // Die Pflicht fuer die ADMIN-Rolle darf nur ein Admin aendern. Sonst koennte ein Chef —
  // PUT /api/settings steht auf authorize('chef') — ausgerechnet die Absicherung des staerksten
  // Kontos abschalten. Gleiche Ueberlegung wie beim Passwort-Zuruecksetzen in routes/users.js.
  if (twofa_admin !== undefined && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Die Zwei-Faktor-Pflicht für Administratoren kann nur ein Administrator ändern.' });
  }

  // SCHARFSCHALTEN NUR MIT GUELTIGEM CODE (Alex, 23.08.2026).
  //
  // Wer eine Rolle von „aus" auf eine Pflicht stellt, sperrt damit potenziell Menschen aus — sich
  // selbst zuerst. Deshalb muss er vorher beweisen, dass sein eigener Generator wirklich laeuft:
  // eingerichteter Authenticator UND ein frischer, gueltiger Code. Ein QR-Code, den jemand
  // eingescannt zu haben glaubt, oder eine falsch gestellte Handy-Uhr fallen damit VOR dem
  // Scharfschalten auf, nicht danach.
  //
  // Bewusst nur in DIESE Richtung. Das Abschalten und der Wechsel zwischen zwei Pflicht-Stufen
  // bleiben ohne Code — sonst baute man eine Falle: Ein Admin ohne eigenen Authenticator koennte
  // die Pflicht fuer die Mitarbeiter nicht mehr zuruecknehmen, und ein verlorenes Handy waere
  // nicht mehr durch Abschalten zu heilen. Der gefaehrliche Weg ist das Anziehen, nicht das Loesen.
  const scharfGeschaltet = [];
  for (const [key, wert] of Object.entries(zweiFaktorFelder)) {
    if (wert === undefined || wert === 'aus') continue;
    const bisher = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const alt = (bisher && bisher.value) || 'aus';
    if (alt === 'aus') scharfGeschaltet.push(key);
  }
  if (scharfGeschaltet.length) {
    if (!zf.eingerichtet(db, req.user.id)) {
      return res.status(400).json({
        code: 'ZWEI_FAKTOR_SELBST_NOETIG',
        error: 'Bevor du die Zwei-Faktor-Anmeldung vorschreibst, richte sie bitte für dich selbst ein '
             + '(Mein Konto). Sonst schreibst du etwas vor, von dem niemand weiß, ob es funktioniert.',
      });
    }
    const code = String((req.body || {}).twofa_code || '').trim();
    if (!code) {
      return res.status(400).json({
        code: 'ZWEI_FAKTOR_CODE_NOETIG',
        error: 'Zum Scharfschalten bitte einen aktuellen Code aus deiner Authenticator-App eingeben.',
      });
    }
    const geheim = zf.geheimnisLesen(db, req.user.id);
    const schritt = geheim ? totp.pruefe(geheim, code) : null;
    if (schritt === null) {
      logAudit(db, { userId: req.user.id, username: req.user.username,
        action: 'twofa_scharf_code_falsch', details: scharfGeschaltet.join(', '), ip: req.ip });
      return res.status(400).json({
        code: 'ZWEI_FAKTOR_CODE_FALSCH',
        error: 'Der Code stimmt nicht. Prüfe auch die Uhrzeit deines Handys.',
      });
    }
    if (!zf.schrittVerbrauchen(db, req.user.id, schritt)) {
      return res.status(400).json({
        code: 'ZWEI_FAKTOR_CODE_VERBRAUCHT',
        error: 'Dieser Code wurde bereits verwendet. Warte auf den nächsten.',
      });
    }
  }

  const fields = {
    company_name, company_street, company_zip, company_city,
    app_name, app_short_name, theme_color, background_color,
    legal_impressum, legal_datenschutz,
    work_start_default, work_hours_per_day, break_minutes_default,
    ...zweiFaktorFelder,
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
  // Zwei-Faktor-Modi werden bei jeder Anfrage gebraucht und deshalb kurz zwischengespeichert —
  // nach einer Umstellung muss dieser Speicher weg, sonst greift sie erst Sekunden spaeter.
  cacheVergessen();

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json({ settings });
});

// Logo hochladen
router.post('/logo', authenticate, authorize('chef'), logoUpload, (req, res) => {
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

// Max. Dateigröße für Logo + App-Icon setzen (Admin). Wert+Einheit (MB/GB), "," und "." erlaubt.
router.put('/branding-limit', authenticate, authorize('admin'), (req, res) => {
  const db = getDb();
  const raw = typeof req.body.fileValue === 'string' ? parseFloat(req.body.fileValue.replace(',', '.')) : req.body.fileValue;
  if (!Number.isFinite(raw) || raw <= 0) {
    return res.status(400).json({ error: 'Bitte eine gültige Zahl größer 0 eingeben' });
  }
  let bytes = Math.round(raw * (req.body.fileUnit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024));
  bytes = Math.max(BRANDING_MIN, Math.min(bytes, BRANDING_MAX));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('branding_file_limit_bytes', ?)").run(String(bytes));
  const mb = (bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'settings_update', details: `Logo/Icon max. Dateigröße: ${mb} MB`, ip: req.ip });
  res.json({ brandingFileLimit: bytes });
});

// App-Icon-Upload: Master in uploads/icons/master.png speichern, alle PWA-Groessen generieren.
// Per-Request-Multer mit dem (konfigurierbaren) Branding-Limit.
router.post('/app-icon', authenticate, authorize('chef'), (req, res) => {
  const limit = getBrandingFileLimit(getDb());
  const iconUpload = multer({ dest: path.join(__dirname, '..', 'uploads', 'tmp'), limits: { fileSize: limit }, fileFilter: brandingFileFilter });
  iconUpload.single('icon')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Datei zu groß (max. ${Math.round(limit / (1024 * 1024))} MB)` });
      return res.status(400).json({ error: err.message || 'Upload fehlgeschlagen' });
    }
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
