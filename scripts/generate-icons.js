// Generiert das neutrale AD-Default-Icon-Set aus public/icons/source.svg
// Wird einmalig beim Setup ausgeführt: node scripts/generate-icons.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'public', 'icons', 'source.svg');
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const SIZES = [16, 32, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];

async function run() {
  const svg = fs.readFileSync(SVG_PATH);

  for (const size of SIZES) {
    await sharp(svg).resize(size, size).png().toFile(path.join(OUT_DIR, `icon-${size}x${size}.png`));
  }
  // Spezielle PWA-Datei-Namen (bestehende Bezeichner beibehalten)
  await sharp(svg).resize(192, 192).png().toFile(path.join(OUT_DIR, 'android-chrome-192x192.png'));
  await sharp(svg).resize(512, 512).png().toFile(path.join(OUT_DIR, 'android-chrome-512x512.png'));
  await sharp(svg).resize(180, 180).png().toFile(path.join(OUT_DIR, 'apple-touch-icon.png'));
  await sharp(svg).resize(144, 144).png().toFile(path.join(OUT_DIR, 'mstile-144x144.png'));
  await sharp(svg).resize(16, 16).png().toFile(path.join(OUT_DIR, 'favicon-16x16.png'));
  await sharp(svg).resize(32, 32).png().toFile(path.join(OUT_DIR, 'favicon-32x32.png'));

  // Maskable-Variante: 10% Padding rundherum mit Theme-Color als Hintergrund
  await sharp(svg).resize(410, 410).extend({
    top: 51, bottom: 51, left: 51, right: 51,
    background: { r: 93, g: 182, b: 53, alpha: 1 }
  }).png().toFile(path.join(OUT_DIR, 'maskable-icon-512x512.png'));

  // favicon.ico (Browser akzeptieren PNG unter .ico)
  await sharp(svg).resize(48, 48).png().toFile(path.join(OUT_DIR, 'favicon.ico'));

  console.log('Default-Icons (AD) generiert in ' + OUT_DIR);
}

run().catch(e => { console.error(e); process.exit(1); });
