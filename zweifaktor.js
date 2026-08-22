// Regeln der Zwei-Faktor-Anmeldung: Wer muss wie oft einen Code eingeben?
//
// Bewusst getrennt von der Rechnerei (totp.js) und der Verschlüsselung (geheimnis.js): Hier steht
// nur Politik, keine Kryptografie. Die Kernfunktionen sind rein (Uhrzeit wird hereingereicht),
// damit sich jedes Intervall ohne Warten und ohne echte Zeit prüfen lässt.
const { notabschaltung, verschluesseln, entschluesseln } = require('./geheimnis');

// Die Auswahl, die der Admin je Rolle trifft.
const MODI = ['aus', 'immer', 'geraet', 'taeglich', 'woechentlich', 'monatlich'];
const MODUS_TEXT = {
  aus: 'aus',
  immer: 'bei jeder Anmeldung',
  geraet: 'einmal pro Gerät',
  taeglich: 'täglich',
  woechentlich: 'wöchentlich',
  monatlich: 'monatlich',
};
// Wie lange ein bestätigtes Gerät ohne neuen Code auskommt.
const FENSTER_TAGE = { geraet: Infinity, taeglich: 1, woechentlich: 7, monatlich: 30 };

const ROLLEN = ['admin', 'chef', 'buchhalter', 'mitarbeiter'];
const schluesselFuer = (rolle) => 'twofa_' + rolle;

// Kleiner Zwischenspeicher: Der Modus wird bei JEDER Anfrage gebraucht (Middleware), die
// Einstellung ändert sich aber praktisch nie. Fünf Sekunden reichen, damit eine Umstellung
// spürbar sofort greift, ohne dass jede Anfrage die Einstellungen liest.
let _cache = { zeit: 0, werte: null };
const CACHE_MS = 5000;

function _alleModi(db) {
  const jetzt = Date.now();
  if (_cache.werte && jetzt - _cache.zeit < CACHE_MS) return _cache.werte;
  const werte = {};
  for (const rolle of ROLLEN) {
    let wert = 'aus';
    try {
      const reihe = db.prepare('SELECT value FROM settings WHERE key = ?').get(schluesselFuer(rolle));
      if (reihe && MODI.includes(reihe.value)) wert = reihe.value;
    } catch (_) { /* Tabelle fehlt (sehr alter Stand) → 'aus', niemand wird ausgesperrt */ }
    werte[rolle] = wert;
  }
  _cache = { zeit: jetzt, werte };
  return werte;
}

// Der geltende Modus einer Rolle. Der Notfall-Schalter sticht alles — an EINER Stelle, damit ihn
// kein Aufrufer vergessen kann.
function modusFuerRolle(db, rolle) {
  if (notabschaltung()) return 'aus';
  return _alleModi(db)[rolle] || 'aus';
}

function alleModi(db) {
  if (notabschaltung()) return Object.fromEntries(ROLLEN.map(r => [r, 'aus']));
  return { ..._alleModi(db) };
}

function cacheVergessen() { _cache = { zeit: 0, werte: null }; }

// Muss dieser Nutzer die Einrichtung erst nachholen, bevor er weiterarbeiten darf?
function einrichtungNoetig(modus, eingerichtet) {
  return modus !== 'aus' && !eingerichtet;
}

// Ist ein bestätigtes Gerät noch gut, oder muss wieder ein Code her?
//
// Gerechnet wird immer gegen den AKTUELLEN Modus, nicht gegen ein beim Bestätigen gespeichertes
// Ablaufdatum. Dadurch wirkt eine Umstellung von „monatlich" auf „täglich" sofort auf alle
// vorhandenen Geräte — mit gespeichertem Ablauf würde sie das verschlafen.
function geraetGueltig(bestaetigtAm, modus, jetztMs = Date.now()) {
  if (!bestaetigtAm) return false;
  if (modus === 'immer' || modus === 'aus') return false;
  const tage = FENSTER_TAGE[modus];
  if (tage === undefined) return false;
  if (tage === Infinity) return true;
  const dann = Date.parse(String(bestaetigtAm).replace(' ', 'T') + (/[Zz+]/.test(String(bestaetigtAm)) ? '' : 'Z'));
  if (!Number.isFinite(dann)) return false;
  return (jetztMs - dann) < tage * 24 * 60 * 60 * 1000;
}

// Wird beim Anmelden ein Code verlangt?
//
// `modus === 'aus'` und trotzdem eingerichtet: Wer sich freiwillig abgesichert hat, soll das auch
// spüren — sonst wäre die freiwillige Einrichtung wirkungslos. Es gilt dann „einmal pro Gerät",
// die mildeste Stufe.
function codeNoetig({ modus, eingerichtet, geraetBestaetigtAm = null, jetztMs = Date.now() }) {
  if (notabschaltung()) return false;
  if (!eingerichtet) return false;                       // ohne Authenticator kann man nichts abfragen
  const wirksam = (modus === 'aus') ? 'geraet' : modus;
  return !geraetGueltig(geraetBestaetigtAm, wirksam, jetztMs);
}

// ── Datenbank-Seite ────────────────────────────────────────────────────────────────────────────
// Alles hier ist in try/catch gekapselt und antwortet im Zweifel so, dass NIEMAND ausgesperrt wird
// (kein Geheimnis, kein Geraet, keine Pflicht). Fehlt die Tabelle auf einem sehr alten Stand, ist
// 2FA schlicht nicht verfuegbar — die Anmeldung funktioniert weiter.

// Ist der Authenticator dieses Nutzers fertig eingerichtet (also einmal per Code bestaetigt)?
// Ein angelegtes, aber nie bestaetigtes Geheimnis zaehlt bewusst NICHT: Sonst sperrte sich jemand
// aus, der die Einrichtung auf halbem Weg abbricht.
function eingerichtet(db, userId) {
  try {
    const r = db.prepare('SELECT confirmed_at FROM twofa_secrets WHERE user_id = ?').get(userId);
    return !!(r && r.confirmed_at);
  } catch (_) { return false; }
}

function geheimnisLesen(db, userId) {
  try {
    const r = db.prepare('SELECT secret_enc FROM twofa_secrets WHERE user_id = ?').get(userId);
    if (!r || !r.secret_enc) return null;
    return entschluesseln(r.secret_enc, userId);
  } catch (_) { return null; }   // falscher Schluessel o. ae. → wie „nicht eingerichtet"
}

function geheimnisAnlegen(db, userId, base32) {
  db.prepare(`INSERT INTO twofa_secrets (user_id, secret_enc, confirmed_at, last_step)
              VALUES (?, ?, NULL, 0)
              ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc,
                                                 confirmed_at = NULL, last_step = 0`)
    .run(userId, verschluesseln(base32, userId));
}

// Der Replay-Riegel: Ein Code gilt bis zu 90 Sekunden. Wer ihn abfaengt, koennte ihn erneut
// einloesen. Deshalb wird der zuletzt benutzte Zeitschritt gemerkt; alles, was nicht NEUER ist,
// wird abgelehnt. Gibt false zurueck, wenn der Code schon verbraucht war.
function schrittVerbrauchen(db, userId, schritt) {
  try {
    const r = db.prepare('SELECT last_step FROM twofa_secrets WHERE user_id = ?').get(userId);
    if (r && Number(r.last_step) >= Number(schritt)) return false;
    db.prepare('UPDATE twofa_secrets SET last_step = ? WHERE user_id = ?').run(schritt, userId);
    return true;
  } catch (_) { return true; }
}

function bestaetigen(db, userId) {
  db.prepare("UPDATE twofa_secrets SET confirmed_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE user_id = ?").run(userId);
}

function zuruecksetzen(db, userId) {
  try { db.prepare('DELETE FROM twofa_secrets WHERE user_id = ?').run(userId); } catch (_) {}
  try { db.prepare('DELETE FROM twofa_devices WHERE user_id = ?').run(userId); } catch (_) {}
}

// ── Geraete ────────────────────────────────────────────────────────────────────────────────────
// Die Kennung liegt beim Nutzer im Cookie, hier NUR als Hash. Wer die Datenbank liest, kann daraus
// kein Geraet nachbauen. SHA-256 genuegt: Der Wert ist 256 Bit Zufall, kein zu erratendes Passwort.
const geraetKennungErzeugen = () => require('crypto').randomBytes(32).toString('base64url');
const geraetHash = (kennung) => require('crypto').createHash('sha256').update(String(kennung)).digest('hex');

function geraetFinden(db, userId, kennung) {
  if (!kennung) return null;
  try {
    return db.prepare('SELECT * FROM twofa_devices WHERE user_id = ? AND token_hash = ?')
      .get(userId, geraetHash(kennung)) || null;
  } catch (_) { return null; }
}

function geraetMerken(db, userId, kennung, userAgent, ip) {
  try {
    db.prepare(`INSERT INTO twofa_devices (user_id, token_hash, user_agent, last_ip, confirmed_at, last_used_at)
                VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'), strftime('%Y-%m-%d %H:%M:%f','now'))
                ON CONFLICT(token_hash) DO UPDATE SET
                  confirmed_at = strftime('%Y-%m-%d %H:%M:%f','now'),
                  last_used_at = strftime('%Y-%m-%d %H:%M:%f','now'),
                  user_agent = excluded.user_agent, last_ip = excluded.last_ip`)
      .run(userId, geraetHash(kennung), String(userAgent || '').slice(0, 200), String(ip || '').slice(0, 60));
  } catch (_) { /* ohne Tabelle gibt es eben kein Geraetevertrauen */ }
}

function geraetBenutzt(db, id, ip) {
  try {
    db.prepare("UPDATE twofa_devices SET last_used_at = strftime('%Y-%m-%d %H:%M:%f','now'), last_ip = ? WHERE id = ?")
      .run(String(ip || '').slice(0, 60), id);
  } catch (_) {}
}

module.exports = {
  MODI, MODUS_TEXT, FENSTER_TAGE, ROLLEN, schluesselFuer,
  modusFuerRolle, alleModi, cacheVergessen,
  einrichtungNoetig, geraetGueltig, codeNoetig,
  eingerichtet, geheimnisLesen, geheimnisAnlegen, schrittVerbrauchen, bestaetigen, zuruecksetzen,
  geraetKennungErzeugen, geraetHash, geraetFinden, geraetMerken, geraetBenutzt,
};
