// Zwei-Faktor-Anmeldung: Einrichten, Bestätigen, Abschalten, Geräte verwalten.
// Gemountet unter /api/auth/2fa (server.js). Der zweistufige ANMELDE-Weg selbst steht in
// routes/auth.js — hier geht es nur um das, was ein angemeldeter Nutzer mit seinem Konto tut.
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode-svg');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../audit');
const totp = require('../totp');
const zf = require('../zweifaktor');
const { notabschaltung } = require('../geheimnis');

const router = express.Router();

// Eigener Zähler fürs Bestätigen. Ohne ihn wäre das der ungebremste Weg, einen sechsstelligen Code
// durchzuprobieren — der Anmelde-Zähler greift hier nicht.
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? 'u' + req.user.id : rateLimit.ipKeyGenerator(req.ip)),
});

function firmenname(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
    return (r && r.value) ? r.value : 'Arbeitsdoku';
  } catch (_) { return 'Arbeitsdoku'; }
}

function zustand(db, user) {
  const modus = zf.modusFuerRolle(db, user.role);
  const fertig = zf.eingerichtet(db, user.id);
  return {
    eingerichtet: fertig,
    modus,
    modus_text: zf.MODUS_TEXT[modus] || modus,
    pflicht: modus !== 'aus',
    einrichtung_noetig: zf.einrichtungNoetig(modus, fertig),
    notabschaltung: notabschaltung(),
    // Abschalten darf nur, wen die Rolle nicht dazu verpflichtet.
    abschaltbar: fertig && modus === 'aus',
  };
}

// Zustand — die Oberfläche fragt das bei jedem Aufruf von „Mein Konto" ab.
router.get('/status', authenticate, (req, res) => {
  res.json({ zwei_faktor: zustand(getDb(), req.user) });
});

// Einrichtung beginnen: neues Geheimnis + QR-Code. Noch NICHT bestätigt — erst der richtige Code
// im nächsten Schritt macht es scharf. Wer hier abbricht, hat sich nichts verbaut.
router.post('/setup', authenticate, (req, res) => {
  try {
    const db = getDb();
    if (zf.eingerichtet(db, req.user.id)) {
      return res.status(409).json({ error: 'Es ist bereits ein Authenticator eingerichtet. Zum Wechseln zuerst abschalten oder vom Admin zurücksetzen lassen.' });
    }
    const geheim = totp.geheimnisErzeugen();
    zf.geheimnisAnlegen(db, req.user.id, geheim);
    const uri = totp.otpauthUri(geheim, req.user.username, firmenname(db));
    // Als eingebettetes SVG, nicht als Bild-Datei: Die Sicherheitsrichtlinie der App erlaubt Bilder
    // nur von der eigenen Herkunft (img-src 'self'), ein data:-Bild würde stumm verworfen.
    const qr = new QRCode({ content: uri, width: 220, height: 220, padding: 2, join: true, xmlDeclaration: false }).svg();
    res.json({ qr_svg: qr, geheim, otpauth: uri });
  } catch (e) {
    console.error('2FA-Einrichtung fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Einrichtung nicht möglich' });
  }
});

// Ersten Code bestätigen → ab jetzt gilt der Authenticator.
router.post('/verify', authenticate, codeLimiter, (req, res) => {
  try {
    const db = getDb();
    const geheim = zf.geheimnisLesen(db, req.user.id);
    if (!geheim) return res.status(400).json({ error: 'Keine Einrichtung begonnen' });

    const schritt = totp.pruefe(geheim, (req.body || {}).code);
    if (schritt === null) {
      logAudit(db, { userId: req.user.id, username: req.user.username, action: 'twofa_verify_failed', ip: req.ip });
      return res.status(401).json({ error: 'Der Code stimmt nicht. Prüfe auch die Uhrzeit deines Handys.' });
    }
    if (!zf.schrittVerbrauchen(db, req.user.id, schritt)) {
      return res.status(401).json({ error: 'Dieser Code wurde bereits verwendet. Warte auf den nächsten.' });
    }

    zf.bestaetigen(db, req.user.id);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'twofa_aktiviert', ip: req.ip });
    res.json({ success: true, zwei_faktor: zustand(db, req.user) });
  } catch (e) {
    console.error('2FA-Bestätigung fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Abschalten — nur wenn die eigene Rolle es nicht verlangt, und nur mit gültigem Code.
// Der Code ist Pflicht, damit ein unbeaufsichtigtes angemeldetes Gerät die Absicherung nicht
// einfach wieder ausknipsen kann.
router.post('/aus', authenticate, codeLimiter, (req, res) => {
  try {
    const db = getDb();
    const z = zustand(db, req.user);
    if (!z.eingerichtet) return res.status(400).json({ error: 'Es ist nichts eingerichtet' });
    if (z.pflicht) {
      return res.status(403).json({ error: `Für deine Rolle ist die Zwei-Faktor-Anmeldung vorgeschrieben (${z.modus_text}). Abschalten kann nur ein Administrator.` });
    }
    const geheim = zf.geheimnisLesen(db, req.user.id);
    const schritt = geheim ? totp.pruefe(geheim, (req.body || {}).code) : null;
    if (schritt === null) return res.status(401).json({ error: 'Der Code stimmt nicht' });

    zf.zuruecksetzen(db, req.user.id);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'twofa_deaktiviert', ip: req.ip });
    res.json({ success: true, zwei_faktor: zustand(db, req.user) });
  } catch (e) {
    console.error('2FA-Abschalten fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Geräte ─────────────────────────────────────────────────────────────────────────────────────
// Ohne diese Liste wäre ein verlorenes Handy bei „einmal pro Gerät" dauerhaft berechtigt.

router.get('/geraete', authenticate, (req, res) => {
  try {
    const db = getDb();
    const eigenes = req.cookies ? req.cookies.ad_geraet : null;
    const eigenerHash = eigenes ? zf.geraetHash(eigenes) : null;
    const reihen = db.prepare(
      'SELECT id, user_agent, last_ip, confirmed_at, last_used_at, token_hash FROM twofa_devices WHERE user_id = ? ORDER BY last_used_at DESC'
    ).all(req.user.id);
    res.json({
      geraete: reihen.map(r => ({
        id: r.id,
        bezeichnung: geraetName(r.user_agent),
        bestaetigt_am: r.confirmed_at,
        zuletzt_benutzt: r.last_used_at,
        dieses_geraet: !!eigenerHash && r.token_hash === eigenerHash,
      })),
    });
  } catch (_) { res.json({ geraete: [] }); }
});

// Aus der Browserkennung etwas machen, das man wiedererkennt („Chrome auf Android").
function geraetName(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} auf ${system}` : browser;
}

router.delete('/geraete/:id', authenticate, (req, res) => {
  try {
    const db = getDb();
    // Immer mit user_id in der Bedingung — ein fremdes Gerät ist darüber nicht erreichbar.
    const r = db.prepare('DELETE FROM twofa_devices WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Gerät nicht gefunden' });
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'twofa_geraet_entzogen', ip: req.ip });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Interner Serverfehler' }); }
});

router.post('/geraete/alle-entziehen', authenticate, (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare('DELETE FROM twofa_devices WHERE user_id = ?').run(req.user.id);
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'twofa_geraete_entzogen',
      details: `${r.changes} Gerät(e)`, ip: req.ip });
    res.json({ success: true, entzogen: r.changes });
  } catch (e) { res.status(500).json({ error: 'Interner Serverfehler' }); }
});

module.exports = router;
module.exports.zustand = zustand;
