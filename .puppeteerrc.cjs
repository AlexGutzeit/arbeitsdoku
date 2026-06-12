// Puppeteer-Browser NICHT automatisch bei `npm install` herunterladen.
// Browser-Tests sind ein optionales Dev-Werkzeug; Chromium wird separat bereitgestellt
// (siehe tests/README.md) und ueber die Umgebungsvariable CHROME_BIN genutzt.
// Wirkung: `npm install` bleibt ueberall schlank und sicher (auch auf Prod via --omit=dev).
module.exports = { skipDownload: true };
