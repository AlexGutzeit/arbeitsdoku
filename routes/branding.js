// Dynamische Branding-Routes: Manifest + index.html mit Settings-Replacements
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/init');

const router = express.Router();

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
const PWA_SIZES = [16, 32, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];

function loadSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasCustomIcons() {
  // app_icon_master ist gesetzt UND uploads/icons/master.png existiert tatsaechlich
  const masterFile = path.join(__dirname, '..', 'uploads', 'icons', 'master.png');
  return fs.existsSync(masterFile);
}

function iconBasePath() {
  return hasCustomIcons() ? '/uploads/icons' : '/icons';
}

// GET /manifest.json — dynamisch aus Settings
router.get('/manifest.json', (req, res) => {
  const s = loadSettings();
  const base = iconBasePath();
  const manifest = {
    name: s.app_name || 'Arbeitsdoku',
    short_name: s.app_short_name || s.app_name || 'Arbeitsdoku',
    description: 'Arbeitszeiterfassung und Dokumentation',
    start_url: '/#/welcome',
    display: 'standalone',
    background_color: s.background_color || '#ffffff',
    theme_color: s.theme_color || '#5DB635',
    orientation: 'any',
    icons: [
      ...PWA_SIZES.map(size => ({
        src: `${base}/icon-${size}x${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
      })),
      {
        src: `${base}/maskable-icon-512x512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(manifest);
});

// GET / und GET /index.html — gerenderte HTML mit Settings-Tokens
function renderIndex(req, res) {
  const s = loadSettings();
  const base = iconBasePath();
  let html;
  try {
    html = fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (e) {
    return res.status(500).send('index.html nicht gefunden');
  }
  const replacements = {
    '{{appName}}': escapeHtml(s.app_name || 'Arbeitsdoku'),
    '{{themeColor}}': escapeHtml(s.theme_color || '#5DB635'),
    '{{bgColor}}': escapeHtml(s.background_color || '#ffffff'),
    '{{iconBase}}': base,
  };
  for (const [k, v] of Object.entries(replacements)) {
    html = html.split(k).join(v);
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Content-Type', 'text/html; charset=UTF-8');
  res.send(html);
}

// GET /api/legal — ÖFFENTLICH (auth-frei, damit Impressum/Datenschutz auch VOR dem Login lesbar sind).
// White-label: fehlende Keys → leer. Rohtext; die sichere Ausgabe (esc + Zeilenumbruch) macht das Frontend.
router.get('/api/legal', (req, res) => {
  const s = loadSettings();
  res.set('Cache-Control', 'no-store');
  res.json({ impressum: s.legal_impressum || '', datenschutz: s.legal_datenschutz || '' });
});

router.get('/', renderIndex);
router.get('/index.html', renderIndex);

module.exports = router;
module.exports.renderIndex = renderIndex;
module.exports.iconBasePath = iconBasePath;
module.exports.hasCustomIcons = hasCustomIcons;
