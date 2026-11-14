// Zugangsschlüssel verwalten (Alex, 14.11.2026) — siehe schluessel.js.
//
// Jeder legt Schlüssel nur für SICH an (Entscheidung B): Ein Schlüssel kann nie mehr als das eigene
// Konto. Der Admin sieht alle und kann jeden widerrufen. Mit einem Schlüssel selbst ist hier nichts
// erreichbar — /api/schluessel steht nicht in der Erlaubt-Liste.
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit, berlinNow } = require('../audit');
const { berlinHeute, istDatum } = require('../zeit');
const schluessel = require('../schluessel');
const nurZahl = require('../middleware/nur-zahl');
const push = require('../push');

const router = express.Router();
const NAME_MAX = 60;
const JE_KONTO_MAX = 20;   // aktive Schlüssel je Konto

const SPALTEN = `s.id, s.user_id, u.name AS user_name, s.name, s.recht, s.anzeige, s.ablauf,
  s.angelegt_am, s.widerrufen_am, s.zuletzt_am, s.zuletzt_ip`;
const zustand = (s) => (s.widerrufen_am ? 'widerrufen' : (s.ablauf && berlinHeute() > s.ablauf ? 'abgelaufen' : 'aktiv'));
const mitZustand = (liste) => liste.map(s => ({ ...s, zustand: zustand(s) }));

// Eigene Schlüssel; der Admin mit ?alle=1 die aller Konten
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const alle = req.user.role === 'admin' && req.query.alle === '1';
  const liste = db.prepare(`SELECT ${SPALTEN} FROM api_schluessel s LEFT JOIN users u ON u.id = s.user_id
    ${alle ? '' : 'WHERE s.user_id = ?'} ORDER BY (s.widerrufen_am IS NOT NULL), s.angelegt_am DESC`).all(...(alle ? [] : [req.user.id]));
  res.json({ schluessel: mitZustand(liste), rechte: schluessel.RECHTE });
});

// Anlegen: nur mit dem eigenen Passwort. Der Schlüssel steht genau EINMAL in der Antwort.
router.post('/', authenticate, async (req, res) => {
  const db = getDb();
  const { name, recht, ablauf, passwort } = req.body;
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return res.status(400).json({ error: 'Bitte einen Namen angeben, z. B. „Hermes".' });
  if (n.length > NAME_MAX) return res.status(400).json({ error: `Der Name ist zu lang (höchstens ${NAME_MAX} Zeichen).` });
  if (!schluessel.RECHTE.includes(recht)) return res.status(400).json({ error: 'Unbekanntes Recht.' });
  let bis = null;
  if (ablauf !== undefined && ablauf !== null && ablauf !== '') {
    if (!istDatum(ablauf)) return res.status(400).json({ error: 'Ungültiges Ablaufdatum.' });
    if (ablauf < berlinHeute()) return res.status(400).json({ error: 'Das Ablaufdatum liegt in der Vergangenheit.' });
    bis = ablauf;
  }
  if (typeof passwort !== 'string' || !passwort) return res.status(400).json({ error: 'Bitte zur Bestätigung dein Passwort eingeben.' });
  const reihe = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!reihe || !(await bcrypt.compare(passwort, reihe.password_hash))) {
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'schluessel_anlegen_fehlgeschlagen',
      details: 'Passwort falsch', ip: req.ip });
    // 400, nicht 401 — ein 401 würde den Angemeldeten hinauswerfen (wie beim Passwortwechsel)
    return res.status(400).json({ error: 'Das Passwort stimmt nicht.' });
  }
  const aktiv = db.prepare('SELECT COUNT(*) AS n FROM api_schluessel WHERE user_id = ? AND widerrufen_am IS NULL').get(req.user.id).n;
  if (aktiv >= JE_KONTO_MAX) return res.status(400).json({ error: `Höchstens ${JE_KONTO_MAX} aktive Schlüssel je Konto. Bitte erst einen widerrufen.` });

  const neu = schluessel.erzeugen();
  const r = db.prepare(`INSERT INTO api_schluessel (user_id, name, recht, hash, anzeige, ablauf, angelegt_am, angelegt_von)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, n, recht, neu.hash, neu.anzeige, bis, berlinNow(), req.user.id);
  const eintrag = db.prepare(`SELECT ${SPALTEN} FROM api_schluessel s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(r.lastInsertRowid);
  logAudit(db, { userId: req.user.id, username: req.user.username, action: 'schluessel_angelegt',
    details: `„${n}" (${recht === 'schreiben' ? 'lesen + schreiben' : 'lesen'}${bis ? `, bis ${bis}` : ''})`, ip: req.ip });
  // Wer das nicht selbst war (fremde Sitzung), soll es merken — der Schlüssel überlebt einen Passwortwechsel.
  push.notifyUsers(db, [req.user.id], null, {
    title: 'Neuer Zugangsschlüssel', body: `„${n}" wurde angelegt. Warst du das nicht? Unter „Mein Konto" widerrufen.`, url: '/#/konto',
  });
  res.status(201).json({ schluessel: neu.roh, eintrag: mitZustand([eintrag])[0] });
});

// Widerrufen: der eigene, oder als Admin jeder. Endgültig — ein widerrufener Schlüssel kommt nie zurück.
router.post('/:id/widerrufen', nurZahl('id'), authenticate, (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM api_schluessel WHERE id = ?').get(Number(req.params.id));
  if (!s || (s.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Schlüssel nicht gefunden' });
  if (!s.widerrufen_am) {
    db.prepare('UPDATE api_schluessel SET widerrufen_am = ?, widerrufen_von = ? WHERE id = ?').run(berlinNow(), req.user.id, s.id);
    const besitzer = s.user_id === req.user.id ? '' : ` (Konto ${db.prepare('SELECT username FROM users WHERE id = ?').get(s.user_id)?.username || s.user_id})`;
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'schluessel_widerrufen',
      details: `„${s.name}"${besitzer}`, ip: req.ip });
  }
  res.json({ ok: true });
});

// Zugriffsprotokoll über /mcp — nur Admin. Ohne Inhalte: Zeit, Schlüssel, Werkzeug, Ergebnis, Dauer, Adresse.
router.get('/protokoll', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Keine Berechtigung' });
  const db = getDb();
  const zeilen = db.prepare(`SELECT z.ts, z.methode, z.werkzeug, z.ergebnis, z.dauer_ms, z.ip, s.name AS schluessel, u.name AS user_name
    FROM mcp_zugriffe z LEFT JOIN api_schluessel s ON s.id = z.schluessel_id LEFT JOIN users u ON u.id = s.user_id
    ORDER BY z.id DESC LIMIT 200`).all();
  res.json({ zugriffe: zeilen });
});

module.exports = router;
