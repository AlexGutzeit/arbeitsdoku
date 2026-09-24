const jwt = require('jsonwebtoken');
const { getDb } = require('../database/init');
const zweiFaktor = require('../zweifaktor');
const { logAudit } = require('../audit');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET ist nicht gesetzt oder zu kurz (min. 32 Zeichen). Server-Start abgebrochen.');
  process.exit(1);
}

// ── Sitzungsdauer (Alex, 24.09.2026) ───────────────────────────────────────────────────────────
// Frueher galt jede Anmeldung fest 24 Stunden ab dem Anmelden. Gemessen im Betrieb (Prod-Kopie,
// 30 Tage): 218 Ablauf-Abmeldungen bei 11 Personen, 197 davon mit Neuanmeldung binnen 3 Minuten —
// die Leute flogen MITTEN in der Arbeit heraus, rund 90 % aller Anmeldungen waren erzwungen.
//
// Jetzt gleitend: Wer die App benutzt, bekommt unterwegs still ein frisches Token (Kopfzeile
// `X-Neues-Token`). Abgemeldet wird erst nach LEERLAUF ohne jede Aktivitaet, und spaetestens nach
// HOECHSTDAUER seit dem Anmelden ist das Passwort wieder faellig — sonst liesse sich ein einmal
// erbeutetes Token durch blosses Benutzen endlos verlaengern.
//
// Unveraendert und weiterhin SOFORT wirksam: „Auf allen Geraeten abmelden" (user_sitzung) und das
// Ausstellen. Ein widerrufenes Token wird nie erneuert — die Pruefung laeuft VOR dem Erneuern.
const LEERLAUF_S = 3 * 24 * 3600;
const HOECHSTDAUER_S = 30 * 24 * 3600;
const ERNEUERN_NACH_S = 3600;   // hoechstens stuendlich ein neues Token, nicht bei jedem Klick

/**
 * Wie lange darf DIESE Sitzung hoechstens laufen (Sekunden)? 30 Tage — oder kuerzer, wenn die Stufe
 * des zweiten Faktors oefter nach dem Code fragt (zweifaktor.js, sitzungsGrenzeTage).
 */
function hoechstdauerFuer(db, user) {
  let tage = null;
  try { tage = zweiFaktor.sitzungsGrenzeTage(db, user); } catch (_) {}
  return Math.min(HOECHSTDAUER_S, tage ? tage * 24 * 3600 : Infinity);
}

/** Das einzige Zugangs-Token der App. `anmeldung` = Zeitpunkt der echten Anmeldung (Sekunden). */
function tokenAusstellen({ userId, role, sitzung, anmeldung, hoechstS }) {
  const jetzt = Math.floor(Date.now() / 1000);
  const seit = Number(anmeldung) || jetzt;
  const bis = Math.min(jetzt + LEERLAUF_S, seit + (Number(hoechstS) || HOECHSTDAUER_S));
  return jwt.sign({ userId, role, sitzung: Number(sitzung) || 0, anmeldung: seit },
    JWT_SECRET, { expiresIn: Math.max(1, bis - jetzt) });
}

// Warum ein 401? Die Oberflaeche braucht den GRUND, nicht nur die Tatsache: Ist die Sitzung bloss
// abgelaufen, meldet sich gleich derselbe Mensch wieder an — seine ungespeicherten Eingaben bleiben
// dann erhalten. Wurde sie dagegen auf allen Geraeten beendet (typisch: Handy verloren) oder das
// Konto ausgestellt, muss alles weg. Vorher sahen alle Faelle gleich aus.
const GRUND = {
  NICHT_ANGEMELDET: 'NICHT_ANGEMELDET',
  ABGELAUFEN: 'SITZUNG_ABGELAUFEN',
  BEENDET: 'SITZUNG_BEENDET',
  AUSGESTELLT: 'KONTO_AUSGESTELLT',
  GELOESCHT: 'KONTO_GELOESCHT',
  UNGUELTIG: 'TOKEN_UNGUELTIG',
};
const abweisen = (res, code, error) => res.status(401).json({ error, code });

// Abgelaufenes Token → automatischer Logout. Einmal pro Nutzer als 'session_expired'
// protokollieren, mit kurzer Sperre (5 Min), damit mehrere Folge-Requests/SSE-Reconnects mit
// demselben abgelaufenen Token das Audit-Log nicht zuspammen.
const _expiredLoggedAt = new Map();
function logSessionExpired(token, ip) {
  try {
    const decoded = jwt.decode(token);
    const userId = decoded && decoded.userId;
    if (!userId) return;
    const now = Date.now();
    if (now - (_expiredLoggedAt.get(userId) || 0) < 5 * 60 * 1000) return;
    _expiredLoggedAt.set(userId, now);
    const db = getDb();
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    logAudit(db, { userId, username: u ? u.username : '', action: 'session_expired', details: 'Sitzung abgelaufen (3 Tage ohne Aktivität oder 30 Tage seit Anmeldung)', ip });
  } catch (_) { /* Audit darf den Request nie stoeren */ }
}

// Was auch ohne eingerichteten zweiten Faktor erreichbar bleiben MUSS — sonst kaeme der Nutzer
// gar nicht erst zur Einrichtung. Bewusst kurz gehalten: keine Datenrouten, kein SSE.
const GATE_FREI = [
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/password',
  '/api/auth/2fa',        // alles darunter
  // Die uebrigen Karten der Seite „Mein Konto". Ohne sie stuende der Nutzer, den wir gerade zur
  // Einrichtung zwingen, vor einer halb kaputten Seite: Profilbild, Geburtstag, Stammdaten und
  // Benachrichtigungen wuerden mit 403 abgewiesen.
  // Alles hier sind EIGENE Daten und aendert nichts an der Absicherung — die Datenrouten
  // (Zeiten, Planung, Auftraege, SSE) bleiben gesperrt.
  '/api/avatare',
  '/api/users/meine-stammdaten',
  '/api/users/geburtstag-freigabe',
  '/api/push',
];
function gateFrei(url) {
  const pfad = String(url || '').split('?')[0];
  return GATE_FREI.some(p => pfad === p || pfad.startsWith(p + '/'));
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return abweisen(res, GRUND.NICHT_ANGEMELDET, 'Nicht angemeldet');
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Sonder-Token sind KEINE Zugangs-Token. Bis hierher wurde nur die Unterschrift geprueft und
    // `userId` gelesen — jedes mit demselben Geheimnis signierte Token kam damit ueberall durch.
    // Betroffen war schon bisher das 60-Sekunden-SSE-Ticket (`sse: true`, server.js): Es taugte
    // eine Minute lang als vollwertiger Bearer-Token. Dazu kommt der Zwischen-Token der
    // Zwei-Faktor-Anmeldung (`pending2fa`), der sonst genau die Huerde umgehen wuerde, die er
    // aufstellt.
    //
    // ACHTUNG bei Erweiterungen: Das ist eine Verbotsliste. Wer kuenftig einen weiteren
    // Sonder-Token einfuehrt und ihn hier NICHT eintraegt, reisst die Luecke wieder auf.
    if (decoded.sse || decoded.pending2fa) {
      return abweisen(res, GRUND.UNGUELTIG, 'Ungültige Anmeldung');
    }

    const db = getDb();
    const user = db.prepare("SELECT id, username, name, role, target_hours_per_week, start_overtime, can_plan, can_plan_all, can_bulletin, can_upload, can_order, can_products_edit, can_products_add, work_start, birth_date, COALESCE(active,1) AS active FROM users WHERE id = ?").get(decoded.userId);
    if (!user) return abweisen(res, GRUND.GELOESCHT, 'Dieses Konto gibt es nicht mehr.');
    // Ausgestellte (active=0) Nutzer werden sofort ausgesperrt — auch wenn ihr Token noch nicht abgelaufen ist.
    // Prüfung läuft live gegen die DB: Wiedereinstellen (active=1) lässt dasselbe Token wieder greifen.
    // COALESCE(active,1): alte DBs ohne gesetztes Flag gelten als aktiv ([[feedback_abwaertskompatibilitaet]]).
    if (user.active === 0) return abweisen(res, GRUND.AUSGESTELLT, 'Dieses Konto ist ausgestellt. Bitte wende dich an die Verwaltung.');

    // „Ueberall abmelden": Passt der Sitzungs-Stand im Token nicht mehr zum gespeicherten, ist das
    // Token widerrufen. Fehlender Anspruch gilt als 0 — Token aus der Zeit vor dieser Aenderung
    // bleiben also gueltig, solange niemand den Knopf gedrueckt hat.
    // Komplett in try/catch: Faellt die Pruefung aus, wird NICHT ausgesperrt.
    try {
      const stand = db.prepare('SELECT stand FROM user_sitzung WHERE user_id = ?').get(user.id);
      if (stand && Number(stand.stand) > Number(decoded.sitzung || 0)) {
        return abweisen(res, GRUND.BEENDET, 'Diese Anmeldung wurde beendet. Bitte neu anmelden.');
      }
    } catch (_) { /* Tabelle fehlt (Altstand) → nichts widerrufen */ }

    req.user = user;

    // Hoechstdauer — 30 Tage oder kuerzer, wenn die Stufe des zweiten Faktors oefter fragt. Ist die
    // Sitzung aelter, gilt sie als ABGELAUFEN (Entwuerfe bleiben, bei der Neuanmeldung kommt der
    // Code). Sofort und nicht erst beim naechsten Token-Ablauf: Stellt der Chef eine Rolle von
    // „monatlich" auf „taeglich", soll das nicht bis zu drei Tage lang verschlafen werden.
    // Tokens von vor dieser Aenderung tragen kein `anmeldung`; dann zaehlt ihr Ausstellungszeitpunkt
    // — so fliegt nach dem Deploy niemand heraus.
    const jetzt = Math.floor(Date.now() / 1000);
    const seit = Number(decoded.anmeldung) || Number(decoded.iat) || jetzt;
    const hoechstS = hoechstdauerFuer(db, user);
    if (jetzt - seit >= hoechstS) {
      logSessionExpired(token, req.ip);
      return abweisen(res, GRUND.ABGELAUFEN, 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.');
    }

    // Gleitende Sitzung: aelter als eine Stunde → frisches Token mitgeben.
    // Ein Fehler hier darf niemals den Zugang kosten.
    try {
      if (jetzt - Number(decoded.iat || 0) >= ERNEUERN_NACH_S) {
        res.setHeader('X-Neues-Token', tokenAusstellen({
          userId: user.id, role: user.role, sitzung: decoded.sitzung, anmeldung: seit, hoechstS,
        }));
      }
    } catch (_) { /* ohne Erneuerung weiter — das alte Token gilt ja noch */ }

    // Einrichtungs-Zwang: Verlangt die Rolle einen zweiten Faktor und ist noch keiner eingerichtet,
    // geht ausser den Konto-Endpunkten nichts mehr. Das Frontend leitet zwar auch um, aber das ist
    // Bequemlichkeit — verlassen kann man sich nur auf die Pruefung hier.
    //
    // 403 und NICHT 401: Ein 401 wuerde im Browser den automatischen Abmelde-Weg ausloesen
    // (app-1-core.js) — der Nutzer flaege raus, statt zur Einrichtung geleitet zu werden.
    //
    // Komplett in try/catch, und die Abfrage laeuft nur, wenn die Rolle ueberhaupt betroffen ist.
    // Ein Fehler hier darf niemals den Zugang kosten: im Zweifel durchlassen.
    try {
      const modus = zweiFaktor.modusFuerRolle(db, user.role);
      if (modus !== 'aus' && !gateFrei(req.originalUrl || req.url) && !zweiFaktor.eingerichtet(db, user.id)) {
        return res.status(403).json({
          error: 'Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.',
          code: 'ZWEI_FAKTOR_EINRICHTUNG',
        });
      }
    } catch (_) { /* 2FA ausgefallen → normal weiterarbeiten */ }

    next();
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      logSessionExpired(token, req.ip);
      return abweisen(res, GRUND.ABGELAUFEN, 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.');
    }
    return abweisen(res, GRUND.UNGUELTIG, 'Ungültige Anmeldung');
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Nicht authentifiziert' });
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Keine Berechtigung' });
  };
}

module.exports = { authenticate, authorize, JWT_SECRET, GATE_FREI, gateFrei,
  tokenAusstellen, hoechstdauerFuer, GRUND, LEERLAUF_S, HOECHSTDAUER_S, ERNEUERN_NACH_S };
