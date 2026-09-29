// Absturz-Schutz (R2, 29.09.2026).
//
// Express 4 fängt keine Fehler aus async-Routen: Wirft `async (req, res) => { await …; … }` nach dem ersten
// Warten, wird daraus eine unbehandelte Promise-Ablehnung — und Node beendet sich daran. systemd startet
// nach 5 s neu, aber alle Verbindungen brechen ab, und bis zu 5 s noch nicht gespeicherter Änderungen
// (Autosave-Takt) sind weg. Nachgemessen war am 24.09. kein Auslöser erreichbar; das hier ist das Netz für
// künftige Fehler:
//   1. async-Routen: Ein Fehler geht an die Fehlerbehandlung von Express (500 „Interner Serverfehler"), wie
//      bei gewöhnlichen Routen — die Anfrage bekommt eine Antwort, der Server läuft weiter.
//   2. Unbehandelte Ablehnung anderswo (Zeitplaner, Rückrufe): protokollieren, sichern, weiterlaufen.
//   3. Unerwartete Ausnahme (echter Programmfehler, Zustand ungewiss): ERST die Daten sichern — offene
//      Live-Notizen und die Datenbank —, dann beenden. systemd startet neu. Weiterzulaufen wäre hier
//      gefährlicher als der Neustart.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';

// Wie Express' eigenes Layer.handle_request — nur dass ein zurückgegebenes Promise, das scheitert, ebenfalls
// an next(err) geht (dasselbe tut das verbreitete Paket express-async-errors).
function asyncRoutenAbsichern() {
  const Layer = require('express/lib/router/layer');
  if (Layer.prototype._absturzschutz) return;
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();   // Fehler-Middleware (4 Argumente) — wie im Original
    try {
      const erg = fn(req, res, next);
      if (erg && typeof erg.then === 'function') {
        erg.then(null, (err) => next(err || new Error('Route ohne Grund abgebrochen')));
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype._absturzschutz = true;
}

let _eingerichtet = false;
function prozessWaechter({ sichern }) {
  if (_eingerichtet) return;
  _eingerichtet = true;
  const sicher = (wofuer) => {
    try { sichern(); } catch (e) { console.error(`[absturzschutz] Sichern (${wofuer}) fehlgeschlagen:`, e && e.message); }
  };
  process.on('unhandledRejection', (grund) => {
    console.error('[absturzschutz] unbehandelte Ablehnung — Server läuft weiter:', (grund && grund.stack) || grund);
    sicher('Ablehnung');
  });
  process.on('uncaughtException', (err) => {
    console.error('[absturzschutz] unerwartete Ausnahme — Daten werden gesichert, dann Neustart:', (err && err.stack) || err);
    sicher('Ausnahme');
    process.exit(1);
  });
}

module.exports = { asyncRoutenAbsichern, prozessWaechter };
