// Gäste in Notizen — die Wege (Etappe C, 27.09.2026). Die Regeln stehen in notiz-gaeste.js.
//
//   verwaltung  (unter /api/notes, nur der Eigentümer):  GET/POST /:id/gaeste,
//               PUT /:id/gaeste/:gid, PUT /:id/gaeste/:gid/passwort, DELETE /:id/gaeste/:gid
//   gast        (unter /api/gast, OHNE Mitarbeiter-Anmeldung): POST /anmelden, GET /notiz, GET /ticket,
//               GET /live, POST /live/aenderung, POST /live/anwesenheit, GET /export/:format
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { broadcast } = require('../sse');
const push = require('../push');
const gaeste = require('../notiz-gaeste');
const live = require('../notizen-live');
const projektNotiz = require('../projekt-notiz');

// ─── Verwaltung ──────────────────────────────────────────────────────────────────────────────

const verwaltung = express.Router();

function eigeneNotiz(req, res) {
  const db = getDb();
  const note = db.prepare('SELECT id, user_id, title, projekt_notiz_fuer FROM notes WHERE id = ?').get(req.params.id);
  if (!note) { res.status(404).json({ error: 'Notiz nicht gefunden' }); return null; }
  // Projektnotiz: Gäste laden Chef und Admin ein (Alex, 28.09.2026); Projekt im Papierkorb → wie weg
  if (note.projekt_notiz_fuer) {
    if (projektNotiz.zugriff(db, note, req.user.id) === undefined) { res.status(404).json({ error: 'Notiz nicht gefunden' }); return null; }
    if (!projektNotiz.darfGaeste(req.user)) { res.status(403).json({ error: 'Gäste in eine Projektnotiz laden Chef und Admin ein.' }); return null; }
    return { db, note };
  }
  if (note.user_id !== req.user.id) { res.status(403).json({ error: 'Nur der Eigentümer kann Gäste verwalten.' }); return null; }
  return { db, note };
}
// Name beginnt mit „audit": So findet tests/audit-beschriftungen.js die Aktionen und prüft ihre Beschriftung.
const auditGast = (req, action, details) => logAudit(getDb(), { userId: req.user.id, username: req.user.username, action, details, ip: req.ip });

verwaltung.get('/:id/gaeste', authenticate, (req, res) => {
  const e = eigeneNotiz(req, res); if (!e) return;
  res.json({ erlaubt: gaeste.erlaubt(e.db), passwortMin: gaeste.PASSWORT_MIN, gaeste: gaeste.liste(e.db, e.note.id) });
});

verwaltung.post('/:id/gaeste', authenticate, async (req, res) => {
  const e = eigeneNotiz(req, res); if (!e) return;
  if (!gaeste.erlaubt(e.db)) return res.status(403).json({ code: 'GAESTE_AUS', error: 'Gastzugänge sind in den Einstellungen abgeschaltet.' });
  const { name, permission, passwort, ablauf } = req.body || {};
  const r = await gaeste.anlegen(e.db, e.note.id, { name, permission, passwort, ablauf }, req.user.id);
  if (r.status !== 201) return res.status(r.status).json({ error: r.fehler });
  const recht = r.gast.permission === 'write' ? 'Schreiben' : 'Lesen';   // eigene Zeile: der Audit-Test liest Zeichenketten in der Aufrufzeile als Aktionen
  auditGast(req, 'notiz_gast_angelegt', `Notiz ${e.note.id} „${e.note.title}": Gast „${r.gast.name}" (${recht}${r.gast.ablauf ? ', bis ' + r.gast.ablauf : ''})`);
  broadcast('notes', req.headers['x-tab-id']);
  res.status(201).json({ gast: r.gast });
});

verwaltung.put('/:id/gaeste/:gid', authenticate, (req, res) => {
  const e = eigeneNotiz(req, res); if (!e) return;
  const { name, permission, ablauf } = req.body || {};
  const r = gaeste.aendern(e.db, e.note.id, Number(req.params.gid), { name, permission, ablauf });
  if (r.status !== 200) return res.status(r.status).json({ error: r.fehler });
  const was = [];
  if (r.vorher.name !== r.gast.name) was.push(`Name „${r.vorher.name}" → „${r.gast.name}"`);
  const RECHT = { read: 'Lesen', write: 'Schreiben' };
  if (r.vorher.permission !== r.gast.permission) was.push(`Recht ${RECHT[r.vorher.permission]} → ${RECHT[r.gast.permission]}`);
  if ((r.vorher.ablauf || null) !== (r.gast.ablauf || null)) was.push(`Ablauf ${r.vorher.ablauf || 'ohne'} → ${r.gast.ablauf || 'ohne'}`);
  if (was.length) auditGast(req, 'notiz_gast_geaendert', `Notiz ${e.note.id}: Gast „${r.gast.name}": ${was.join(', ')}`);
  live.zugriffAbgleichen(e.note.id);   // Schreiben ↔ Lesen gilt sofort; abgelaufen → raus
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ gast: r.gast });
});

verwaltung.put('/:id/gaeste/:gid/passwort', authenticate, async (req, res) => {
  const e = eigeneNotiz(req, res); if (!e) return;
  const r = await gaeste.passwortSetzen(e.db, e.note.id, Number(req.params.gid), (req.body || {}).passwort);
  if (r.status !== 200) return res.status(r.status).json({ error: r.fehler });
  auditGast(req, 'notiz_gast_passwort', `Notiz ${e.note.id}: neues Passwort für Gast „${r.gast.name}"`);
  live.gastRauswerfen(r.gast.id, 'passwort-geaendert');   // nur DIESER Gast
  res.json({ gast: r.gast });
});

verwaltung.delete('/:id/gaeste/:gid', authenticate, (req, res) => {
  const e = eigeneNotiz(req, res); if (!e) return;
  const r = gaeste.entfernen(e.db, e.note.id, Number(req.params.gid));
  if (r.status !== 200) return res.status(r.status).json({ error: r.fehler });
  auditGast(req, 'notiz_gast_entfernt', `Notiz ${e.note.id} „${e.note.title}": Gast „${r.vorher.name}" entfernt`);
  live.gastRauswerfen(r.vorher.id, 'gast-entfernt');
  broadcast('notes', req.headers['x-tab-id']);
  res.json({ success: true });
});

// ─── Der Gast ────────────────────────────────────────────────────────────────────────────────

const gast = express.Router();

// Je Adresse: gegen Durchprobieren vieler Links. Die Sperre JE GAST (5 falsche Passwörter) steht in
// notiz-gaeste.js — sie greift auch, wenn jemand von vielen Adressen aus probiert.
const anmeldeBremse = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  message: { error: 'Zu viele Anmeldeversuche. Bitte in einer Viertelstunde erneut versuchen.' },
});

gast.post('/anmelden', anmeldeBremse, async (req, res) => {
  const db = getDb();
  const { token, passwort } = req.body || {};
  const r = await gaeste.anmelden(db, token, passwort);
  const wer = r.gast ? `Gast „${r.gast.name}" (Notiz ${r.gast.note_id})` : 'Gast (unbekannter Link)';
  if (r.status !== 200) {
    if (r.code === 'GAST_PASSWORT_FALSCH' || r.gesperrt) logAudit(db, { username: wer, action: r.gesperrt ? 'notiz_gast_gesperrt' : 'notiz_gast_login_failed', details: r.fehler, ip: req.ip });
    if (r.gesperrt) {
      // Der Eigentümer soll wissen, dass jemand an SEINEM Zugang probiert (Alex, 26.09.2026)
      const n = db.prepare('SELECT user_id, title FROM notes WHERE id = ?').get(r.gast.note_id);
      if (n) push.notifyUsers(db, [n.user_id], 'notes', {
        title: 'Gastzugang gesperrt',
        body: `${gaeste.FEHLVERSUCHE_BIS_SPERRE} falsche Passwörter für „${r.gast.name}" (Notiz „${n.title}") — für ${gaeste.SPERRE_MS / 60000} Minuten gesperrt.`,
        url: '/#/notes',
        ziel: { art: 'notiz', id: r.gast.note_id },
      });
    }
    return res.status(r.status).json({ error: r.fehler, code: r.code });
  }
  logAudit(db, { username: wer, action: 'notiz_gast_login', details: '', ip: req.ip });
  const titel = (db.prepare('SELECT title FROM notes WHERE id = ?').get(r.gast.note_id) || {}).title || '';
  res.json({ token: r.token, name: r.gast.name, zugriff: r.zugriff, titel });
});

/** Bearer-Anmeldung eines Gasts prüfen. Setzt req.gast / req.gastZugriff. */
function gastAuth(req, res, next) {
  const kopf = req.headers.authorization || '';
  const r = gaeste.pruefen(getDb(), kopf.startsWith('Bearer ') ? kopf.slice(7) : '');
  if (!r.gast) return res.status(r.status).json({ error: r.fehler, code: r.code });
  req.gast = r.gast; req.gastZugriff = r.zugriff;
  next();
}

gast.get('/notiz', gastAuth, (req, res) => {
  const n = getDb().prepare('SELECT title FROM notes WHERE id = ?').get(req.gast.note_id);
  res.json({ titel: n ? n.title : '', name: req.gast.name, zugriff: req.gastZugriff });
});

gast.get('/ticket', gastAuth, (req, res) => res.json({ ticket: gaeste.ticket(req.gast) }));

gast.get('/live', (req, res) => {
  const db = getDb();
  const r = gaeste.pruefen(db, req.query.ticket, 'ticket');
  if (!r.gast) return res.status(r.status).json({ error: r.fehler, code: r.code });
  db.prepare("UPDATE note_gaeste SET zuletzt_da = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(r.gast.id);
  const status = live.verbinden(r.gast.note_id, { gast: r.gast.id, name: r.gast.name }, req, res);
  if (status === 404) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (status === 403) return res.status(403).json({ error: 'Kein Zugang' });
});

const { liveAntwort, exportSenden } = require('./notes');

gast.post('/live/aenderung', gastAuth, (req, res) => {
  const { verbindung, update } = req.body || {};
  liveAntwort(res, live.aenderung(req.gast.note_id, 'g' + req.gast.id, verbindung, update));
});

gast.post('/live/anwesenheit', gastAuth, (req, res) => {
  const { verbindung, update } = req.body || {};
  liveAntwort(res, live.anwesenheit(req.gast.note_id, 'g' + req.gast.id, verbindung, update));
});

// Gäste dürfen drucken und herunterladen (Alex, 26.09.2026)
gast.get('/export/:format', gastAuth, async (req, res) => {
  await exportSenden(res, getDb(), req.gast.note_id, req.params.format);
});

module.exports = { verwaltung, gast };
