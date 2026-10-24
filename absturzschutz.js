// Absturz-Schutz (R2, 29.09.2026).
//
// Express 4 fing keine Fehler aus async-Routen: Warf `async (req, res) => { await …; … }` nach dem ersten
// Warten, wurde daraus eine unbehandelte Promise-Ablehnung — und Node beendete sich daran. systemd startet
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

// Punkt 1 erledigt seit Express 5 (24.10.2026) der Router selbst: Layer.handleRequest im Paket `router` reicht
// ein scheiterndes Promise an next(err) weiter — genau das, was hier vorher für Express 4 nachgerüstet war
// (express/lib/router/layer gibt es in 5 nicht mehr). Übrig bleibt ein Wächter: Liefe je wieder ein Express ohne
// diese Behandlung, bricht der Start laut ab, statt still ungeschützt weiterzulaufen.
function asyncRoutenAbsichern() {
  const version = require('express/package.json').version;
  if (Number(version.split('.')[0]) < 5) {
    throw new Error(`Express ${version}: Fehler aus async-Routen würden den Server beenden — erwartet wird Express 5 oder neuer.`);
  }
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
