// Routen-Parameter, die eine Zahl sein müssen — Ersatz für „/:id(\\d+)", das Express 5 nicht mehr kennt (24.10.2026).
//
//   router.get('/:id', nurZahl('id'), authenticate, …)
//
// Ist der Wert keine Zahl, gilt die Route als nicht getroffen: next('route') reicht an die nächste passende weiter.
// So landet z. B. GET /api/meldungen/regeln weiter bei '/regeln', obwohl '/:id' davor steht — wie vorher mit dem
// Regex. Deshalb VOR authenticate einhängen: Eine Nicht-Zahl soll die Route gar nicht erst betreten.
'use strict';

module.exports = (...namen) => (req, res, next) =>
  (namen.every(n => /^\d+$/.test(req.params[n])) ? next() : next('route'));
