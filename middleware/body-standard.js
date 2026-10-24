// req.body wie unter Express 4: {} statt undefined, wenn kein Parser einen Body gelesen hat (24.10.2026).
//
// Express 5 lässt req.body ohne Body undefined; viele Routen lesen req.body.x ungeprüft — ein DELETE ohne Body wäre
// sonst ein 500. Eingehängt in server.js direkt nach den Body-Parsern, UND in jedem Test, der sich eine eigene
// Mini-App baut — sonst verhält sich die Route dort anders als im Server (so geschehen in auftrags-kategorien und
// produktpflege). tests/express5-routen.js wacht darüber.
'use strict';

module.exports = (req, res, next) => { if (req.body === undefined) req.body = {}; next(); };
