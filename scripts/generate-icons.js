// Generiert das Default-Icon-Set (Uhr mit Haken auf grünem Verlauf, wie im Werbefilm) aus public/icons/source.svg
// Wird einmalig beim Setup ausgeführt: node scripts/generate-icons.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'public', 'icons', 'source.svg');
const MASKABLE_PATH = path.join(__dirname, '..', 'public', 'icons', 'source-maskable.svg');
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const SIZES = [16, 32, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512];

async function run() {
  const svg = fs.readFileSync(SVG_PATH);
  // Randlos (ohne eigene runde Ecken): iOS rundet selbst ab und füllt durchsichtige Ecken schwarz
  const randlos = Buffer.from(svg.toString().replace(' rx="16"', ''));

  for (const size of SIZES) {
    await sharp(svg).resize(size, size).png().toFile(path.join(OUT_DIR, `icon-${size}x${size}.png`));
  }
  // Spezielle PWA-Datei-Namen (bestehende Bezeichner beibehalten)
  await sharp(svg).resize(192, 192).png().toFile(path.join(OUT_DIR, 'android-chrome-192x192.png'));
  await sharp(svg).resize(512, 512).png().toFile(path.join(OUT_DIR, 'android-chrome-512x512.png'));
  await sharp(randlos).resize(180, 180).flatten({ background: '#1c4a28' }).png().toFile(path.join(OUT_DIR, 'apple-touch-icon.png'));
  await sharp(randlos).resize(144, 144).png().toFile(path.join(OUT_DIR, 'mstile-144x144.png'));
  await sharp(svg).resize(16, 16).png().toFile(path.join(OUT_DIR, 'favicon-16x16.png'));
  await sharp(svg).resize(32, 32).png().toFile(path.join(OUT_DIR, 'favicon-32x32.png'));

  // Maskable-Variante: eigene Vorlage mit Verlauf bis zum Rand, Motiv in der sicheren Mitte
  await sharp(fs.readFileSync(MASKABLE_PATH)).resize(512, 512).png().toFile(path.join(OUT_DIR, 'maskable-icon-512x512.png'));

  // favicon.ico (Browser akzeptieren PNG unter .ico)
  await sharp(svg).resize(48, 48).png().toFile(path.join(OUT_DIR, 'favicon.ico'));

  console.log('Default-Icons generiert in ' + OUT_DIR);
}

run().catch(e => { console.error(e); process.exit(1); });
