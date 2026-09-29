// Stellt die Uhr eines Server-Prozesses — NUR für Tests, geladen per `node --require`.
//
//   FESTE_UHR='2026-09-30T22:30:00Z' node --require ./tests/hilfen/uhr-stellen.js server.js
//
// Date.now() und `new Date()` beginnen dann bei diesem Zeitpunkt und laufen normal weiter. Gebraucht für
// Fehler, die nur zu bestimmten Uhrzeiten auftreten (z. B. zwischen 0 und 2 Uhr, wenn UTC noch den Vortag
// zeigt). SQLite rechnet mit seiner eigenen Uhr weiter (datetime('now')) — das bleibt echt.
'use strict';
const ziel = Date.parse(process.env.FESTE_UHR || '');
if (!Number.isNaN(ziel)) {
  const EchtesDate = Date;
  const versatz = ziel - EchtesDate.now();
  class GestellteUhr extends EchtesDate {
    constructor(...args) {
      if (args.length === 0) super(EchtesDate.now() + versatz);
      else super(...args);
    }
    static now() { return EchtesDate.now() + versatz; }
  }
  global.Date = GestellteUhr;
}
