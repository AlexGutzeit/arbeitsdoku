const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database/init');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const { logAudit } = require('../audit');
const { passwordPolicyError } = require('./users');
const zf = require('../zweifaktor');
const totp = require('../totp');
const { zustand: zweiFaktorZustand } = require('./twofa');

const router = express.Router();

// Fester Dummy-Hash (Cost 10, wie die echten Hashes), um die Antwortzeit bei unbekanntem
// Benutzer an den bcrypt-Vergleich anzugleichen → keine User-Enumeration über Timing.
// hashSync hier bewusst: laeuft EINMAL beim Serverstart (nicht pro Anfrage), blockiert also nichts.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Login. async + bcrypt.compare (kooperativ): die rechenintensive Passwortpruefung blockiert den
// Event-Loop nicht mehr — der Server bleibt unter vielen gleichzeitigen Logins ansprechbar.
router.post('/login', loginLimiter, async (req, res) => {
 try {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH); // Timing angleichen (Antwortzeit wie bei echtem User)
    logAudit(db, { username, action: 'login_failed', details: 'Benutzer unbekannt', ip: req.ip });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  if (!(await bcrypt.compare(password, user.password_hash))) {
    logAudit(db, { userId: user.id, username, action: 'login_failed', details: 'Falsches Passwort', ip: req.ip });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  // Ausgestellte Mitarbeiter koennen sich nicht mehr anmelden (Daten bleiben erhalten).
  if (user.active === 0) {
    logAudit(db, { userId: user.id, username, action: 'login_failed', details: 'Account ausgestellt', ip: req.ip });
    return res.status(403).json({ error: 'Dieser Account ist ausgestellt. Bitte wende dich an die Verwaltung.' });
  }

  // Zweiter Faktor noetig? Entschieden wird nach Rolle, eingerichtetem Authenticator und dem
  // Geraet, von dem die Anmeldung kommt. Steht die Rolle auf „aus" und ist nichts eingerichtet,
  // laeuft alles wie vor der Zwei-Faktor-Arbeit — das ist der Normalfall nach dem Update.
  const modus = zf.modusFuerRolle(db, user.role);
  const zustand2fa = zf.zustandLesen(db, user.id);
  const hatAuthenticator = zustand2fa.aktiv;
  const geraetKennung = (req.cookies || {}).ad_geraet || null;
  const geraet = zf.geraetFinden(db, user.id, geraetKennung);

  if (zf.codeNoetig({ modus, eingerichtet: hatAuthenticator, eigenModus: zustand2fa.eigen_modus,
    geraetBestaetigtAm: geraet ? geraet.confirmed_at : null })) {
    // Bewusst 200 und nicht 401: Das Passwort war ja richtig. Ein 401 wuerde im Browser ausserdem
    // den automatischen Abmelde-Weg ausloesen (app-1-core.js).
    //
    // Der Zwischen-Token traegt `pending2fa` und wird von authenticate() und /api/events
    // ausdruecklich abgelehnt — er oeffnet also nichts ausser dem zweiten Schritt.
    const zwischenToken = jwt.sign({ userId: user.id, pending2fa: true }, JWT_SECRET, { expiresIn: '5m' });
    logAudit(db, { userId: user.id, username: user.username, action: 'login_2fa_noetig', ip: req.ip });
    // „Geraet merken" ergibt bei „bei jeder Anmeldung" keinen Sinn — egal ob die Rolle das
    // vorgibt oder der Nutzer es sich selbst so gewaehlt hat.
    const wirksam = modus === 'aus' ? (zustand2fa.eigen_modus || 'geraet') : modus;
    return res.json({
      zwei_faktor_erforderlich: true,
      zwischen_token: zwischenToken,
      geraet_merkbar: wirksam !== 'immer',
    });
  }

  if (geraet) zf.geraetBenutzt(db, geraet.id, req.ip);
  logAudit(db, { userId: user.id, username: user.username, action: 'login_success',
    details: geraet ? 'bekanntes Gerät' : undefined, ip: req.ip });
  res.json(anmeldeAntwort(db, user));
 } catch (e) {
  console.error('Login-Fehler:', e.message);
  return res.status(500).json({ error: 'Interner Serverfehler' });
 }
});

// Die Antwort einer geglueckten Anmeldung — an zwei Stellen gebraucht (mit und ohne Code).
function sitzungsStand(db, userId) {
  try {
    const r = db.prepare('SELECT stand FROM user_sitzung WHERE user_id = ?').get(userId);
    return r ? Number(r.stand) : 0;
  } catch (_) { return 0; }
}

function anmeldeAntwort(db, user) {
  return {
    // `sitzung` ist der Stand aus user_sitzung. Wer „ueberall abmelden" drueckt, erhoeht ihn —
    // alle Token mit kleinerem Stand sind damit in derselben Sekunde wertlos.
    token: jwt.sign({ userId: user.id, role: user.role, sitzung: sitzungsStand(db, user.id) },
      JWT_SECRET, { expiresIn: '24h' }),
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      target_hours_per_week: user.target_hours_per_week,
      start_overtime: user.start_overtime || 0,
      can_plan: !!user.can_plan,
      can_plan_all: !!user.can_plan_all,
      can_bulletin: !!user.can_bulletin,
      can_upload: !!user.can_upload,
      can_order: !!user.can_order,
      work_start: user.work_start || null,  // leer = Firmenwert aus den Einstellungen
      birth_date: user.birth_date || null   // leer = Alter unbekannt -> strengerer Jugendschutz
    },
  };
}

// Eigener Zaehler fuer den Code-Schritt: Der Anmelde-Zaehler oben laesst erfolgreiche
// Passwortpruefungen aus (skipSuccessfulRequests) — der sechsstellige Code waere sonst der
// ungebremste Weg. Gezaehlt wird pro Nutzer, nicht pro IP, damit viele Adressen nichts nuetzen.
const zweiFaktorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Code-Versuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    try {
      const d = jwt.verify(String((req.body || {}).zwischen_token || ''), JWT_SECRET);
      if (d && d.userId) return 'u' + d.userId;
    } catch (_) {}
    return rateLimit.ipKeyGenerator(req.ip);
  },
});

// Zweiter Schritt der Anmeldung: Code aus der Authenticator-App.
//
// Der Pfad enthaelt bewusst „/login" — die Ausnahme in app-1-core.js, die bei 401 NICHT automatisch
// abmeldet, prueft auf genau diese Zeichenfolge. Ein falscher Code darf den Nutzer nicht aus der
// Anmeldemaske werfen.
router.post('/login/2fa', zweiFaktorLimiter, (req, res) => {
  try {
    const { zwischen_token, code, geraet_merken } = req.body || {};
    if (!zwischen_token || !code) return res.status(400).json({ error: 'Zwischen-Token und Code erforderlich' });

    let entschluesselt;
    try { entschluesselt = jwt.verify(zwischen_token, JWT_SECRET); }
    catch (_) { return res.status(401).json({ error: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.' }); }
    // Nur der Zwischen-Token darf hier hinein — ein vollwertiger Login-Token nicht, sonst koennte
    // man sich damit ein Geraet als vertrauenswuerdig eintragen lassen.
    if (!entschluesselt || entschluesselt.pending2fa !== true) {
      return res.status(401).json({ error: 'Ungültiger Token' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(entschluesselt.userId);
    if (!user) return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    if (user.active === 0) return res.status(403).json({ error: 'Dieser Account ist ausgestellt. Bitte wende dich an die Verwaltung.' });

    const geheim = zf.geheimnisLesen(db, user.id);
    const schritt = geheim ? totp.pruefe(geheim, code) : null;
    if (schritt === null) {
      logAudit(db, { userId: user.id, username: user.username, action: 'login_2fa_fehlgeschlagen', ip: req.ip });
      return res.status(401).json({ error: 'Der Code stimmt nicht. Prüfe auch die Uhrzeit deines Handys.' });
    }
    if (!zf.schrittVerbrauchen(db, user.id, schritt)) {
      // Eigene Meldung: „Falscher Code" waere hier irrefuehrend, der Nutzer sucht den Fehler sonst
      // bei sich. Tritt auf, wenn man sich binnen 30 Sekunden zweimal anmeldet.
      return res.status(401).json({ error: 'Dieser Code wurde bereits verwendet. Warte auf den nächsten.' });
    }

    // Geraet merken — nur wenn gewuenscht UND die Rolle es zulaesst.
    const modus = zf.modusFuerRolle(db, user.role);
    const eigen = zf.zustandLesen(db, user.id).eigen_modus;
    const wirksam = modus === 'aus' ? (eigen || 'geraet') : modus;
    if (geraet_merken && wirksam !== 'immer') {
      const kennung = (req.cookies || {}).ad_geraet || zf.geraetKennungErzeugen();
      zf.geraetMerken(db, user.id, kennung, req.headers['user-agent'], req.ip);
      // httpOnly: fuer JavaScript unlesbar. Laege die Kennung im localStorage, koennte eine
      // XSS-Luecke Anmelde-Token UND Geraetevertrauen in einem Zug abgreifen.
      // Secure nur bei echtem HTTPS, sonst nimmt der Browser das Cookie in Tests nicht an.
      res.cookie('ad_geraet', kennung, {
        httpOnly: true, sameSite: 'lax', path: '/api/auth',
        maxAge: 400 * 24 * 60 * 60 * 1000, secure: !!req.secure,
      });
    }

    logAudit(db, { userId: user.id, username: user.username, action: 'login_2fa_erfolg', ip: req.ip });
    res.json(anmeldeAntwort(db, user));
  } catch (e) {
    console.error('2FA-Anmeldung fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Aktueller Benutzer
router.get('/me', authenticate, (req, res) => {
  // `zwei_faktor` steht bewusst NEBEN `user` und nicht darin: refreshUser() legt `user` eins zu eins
  // in den localStorage — der 2FA-Zustand hat dort nichts verloren und soll auch nicht veralten.
  res.json({ user: req.user, zwei_faktor: zweiFaktorZustand(getDb(), req.user) });
});

// Eigenes Passwort aendern. Bis hierher konnte das NIEMAND selbst — nur Chef/Admin konnten es
// fuer andere zuruecksetzen (routes/users.js). Ein Mitarbeiter, dessen Passwort jemand mitgelesen
// hat, war darauf angewiesen, dass ein Vorgesetzter Zeit hat.
//
// Das aktuelle Passwort ist Pflicht: Sonst koennte jemand an einem unbeaufsichtigten, noch
// angemeldeten Geraet das Passwort aendern und sich den Zugang dauerhaft sichern.
router.put('/password', authenticate, async (req, res) => {
  try {
    const { aktuell, neu } = req.body || {};
    if (!aktuell || !neu) return res.status(400).json({ error: 'Aktuelles und neues Passwort erforderlich' });

    const db = getDb();
    const reihe = db.prepare('SELECT password_hash, username FROM users WHERE id = ?').get(req.user.id);
    if (!reihe) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    if (!(await bcrypt.compare(aktuell, reihe.password_hash))) {
      logAudit(db, { userId: req.user.id, username: reihe.username, action: 'password_self_change_failed',
        details: 'Aktuelles Passwort falsch', ip: req.ip });
      // 400, NICHT 401 — siehe routes/twofa.js: ein 401 wuerde den Angemeldeten hinauswerfen,
      // statt ihm zu sagen, dass er sich vertippt hat.
      return res.status(400).json({ error: 'Das aktuelle Passwort stimmt nicht' });
    }

    // Dieselbe Regel wie beim Anlegen und beim Zuruecksetzen — eine Quelle der Wahrheit.
    const verstoss = passwordPolicyError(neu, reihe.username);
    if (verstoss) return res.status(400).json({ error: verstoss });
    if (neu === aktuell) return res.status(400).json({ error: 'Das neue Passwort muss sich vom bisherigen unterscheiden' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(neu, 10), req.user.id);
    logAudit(db, { userId: req.user.id, username: reihe.username, action: 'password_self_change', ip: req.ip });
    res.json({ success: true });
  } catch (e) {
    console.error('Passwort aendern fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Auf ALLEN Geräten abmelden. Der Fall dahinter: Handy verloren, Rechner beim Kunden stehen
// gelassen, oder das ungute Gefühl nach einem Passwortwechsel.
//
// Der Aufrufer bekommt sofort ein frisches Token — sonst wuerde er sich mit dem Klick auch selbst
// hinauswerfen, was niemand erwartet.
router.post('/alle-abmelden', authenticate, (req, res) => {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO user_sitzung (user_id, stand, geaendert)
                VALUES (?, 1, strftime('%Y-%m-%d %H:%M:%f','now'))
                ON CONFLICT(user_id) DO UPDATE SET stand = stand + 1,
                  geaendert = strftime('%Y-%m-%d %H:%M:%f','now')`).run(req.user.id);
    // Geraete-Vertrauen der Zwei-Faktor-Anmeldung faellt mit weg — sonst kaeme ein verlorenes
    // Handy weiterhin ohne Code hinein, und der Knopf waere nur die halbe Wahrheit.
    try { require('../zweifaktor').geraeteAlleLoeschen(db, req.user.id); } catch (_) {}
    logAudit(db, { userId: req.user.id, username: req.user.username, action: 'alle_abgemeldet', ip: req.ip });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, ...anmeldeAntwort(db, user) });
  } catch (e) {
    console.error('Alle abmelden fehlgeschlagen:', e.message);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// Abmelden. Bei stateless JWT gibt es serverseitig nichts „abzumelden" — dieser Endpunkt dient
// nur dem Audit-Log. Best effort: der „Abmelden"-Button ruft ihn auf; ein blosses Schliessen des
// Tabs erreicht den Server nicht (der automatische Logout bei abgelaufenem Token wird separat als
// 'session_expired' protokolliert).
router.post('/logout', authenticate, (req, res) => {
  logAudit(getDb(), { userId: req.user.id, username: req.user.username, action: 'logout', details: 'manuell', ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
