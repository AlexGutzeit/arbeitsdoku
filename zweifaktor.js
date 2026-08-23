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
function codeNoetig({ modus, eingerichtet, eigenModus = null, geraetBestaetigtAm = null, jetztMs = Date.now() }) {
  if (notabschaltung()) return false;
  if (!eingerichtet) return false;                       // ohne Authenticator kann man nichts abfragen
  // Schreibt die Rolle etwas vor, gewinnt sie. Sonst gilt der eigene Wunsch — und ohne den
  // weiterhin „einmal pro Geraet", die mildeste Stufe.
  const wirksam = (modus === 'aus') ? (EIGENE_MODI.includes(eigenModus) ? eigenModus : 'geraet') : modus;
  return !geraetGueltig(geraetBestaetigtAm, wirksam, jetztMs);
}

// ── Datenbank-Seite ────────────────────────────────────────────────────────────────────────────
// Alles hier ist in try/catch gekapselt und antwortet im Zweifel so, dass NIEMAND ausgesperrt wird
// (kein Geheimnis, kein Geraet, keine Pflicht). Fehlt die Tabelle auf einem sehr alten Stand, ist
// 2FA schlicht nicht verfuegbar — die Anmeldung funktioniert weiter.

// Der Zustand eines Nutzers in einem Rutsch. Drei Stufen, die man auseinanderhalten muss:
//
//   nichts        — es gibt keinen Schluessel
//   stillgelegt   — es gibt einen bestaetigten Schluessel, aber er wird gerade nicht verlangt
//   aktiv         — Schluessel bestaetigt und in Benutzung
//
// „Stillgelegt" gibt es, weil Abschalten den Schluessel NICHT loeschen darf: Wer 2FA freiwillig
// abschaltet und spaeter (oder per Anordnung) wieder einschaltet, soll dieselbe Authenticator-App
// weiterbenutzen koennen, ohne neu einzulernen (Alex, 22.08.2026). Geloescht wird nur beim
// Zuruecksetzen durch Chef/Admin (verlorenes Handy) und wenn jemand bewusst einen neuen
// Schluessel wuerfelt.
function zustandLesen(db, userId) {
  try {
    const r = db.prepare('SELECT secret_enc, pending_enc, aktiv, confirmed_at, last_step, eigen_modus FROM twofa_secrets WHERE user_id = ?').get(userId);
    if (!r) return { vorhanden: false, bestaetigt: false, aktiv: false, wartend: false, eigen_modus: null };
    return {
      vorhanden: true,
      bestaetigt: !!r.confirmed_at,
      aktiv: !!r.confirmed_at && (r.aktiv === null || r.aktiv === undefined || Number(r.aktiv) === 1),
      wartend: !!r.pending_enc,
      last_step: Number(r.last_step || 0),
      // Eigener Wunsch, nur gueltig solange die Rolle nichts vorschreibt. Unbekannte Werte
      // werden verworfen — dann gilt wieder die mildeste Stufe.
      eigen_modus: EIGENE_MODI.includes(r.eigen_modus) ? r.eigen_modus : null,
    };
  } catch (_) { return { vorhanden: false, bestaetigt: false, aktiv: false, wartend: false, eigen_modus: null }; }
}

// Was ein freiwillig abgesicherter Nutzer fuer sich waehlen darf. „aus" steht bewusst NICHT
// darin: Ganz abschalten ist etwas anderes und hat seinen eigenen Weg (POST /2fa/aus), samt
// Sperre, wenn die Rolle es verlangt.
const EIGENE_MODI = MODI.filter(m => m !== 'aus');

function eigenenModusSetzen(db, userId, modus) {
  if (!EIGENE_MODI.includes(modus)) return false;
  try {
    const r = db.prepare('UPDATE twofa_secrets SET eigen_modus = ? WHERE user_id = ?').run(modus, userId);
    return !!(r && (r.changes === undefined || r.changes > 0));
  } catch (_) { return false; }
}

// „Eingerichtet" im Sinne der Anmeldung heisst: bestaetigt UND aktiv.
function eingerichtet(db, userId) { return zustandLesen(db, userId).aktiv; }

// Ein bestaetigter, aber stillgelegter Schluessel — dann bietet die Oberflaeche
// „wieder aktivieren" statt „einrichten" an.
function stillgelegt(db, userId) {
  const z = zustandLesen(db, userId);
  return z.bestaetigt && !z.aktiv;
}

// Liest den GUELTIGEN Schluessel (nicht den wartenden).
function geheimnisLesen(db, userId) {
  try {
    const r = db.prepare('SELECT secret_enc FROM twofa_secrets WHERE user_id = ?').get(userId);
    if (!r || !r.secret_enc) return null;
    return entschluesseln(r.secret_enc, userId);
  } catch (_) { return null; }   // falscher Schluessel o. ae. → wie „nicht eingerichtet"
}

// Liest den WARTENDEN Schluessel (frisch gewuerfelt, noch nicht bestaetigt).
function wartendesGeheimnisLesen(db, userId) {
  try {
    const r = db.prepare('SELECT pending_enc FROM twofa_secrets WHERE user_id = ?').get(userId);
    if (!r || !r.pending_enc) return null;
    return entschluesseln(r.pending_enc, userId);
  } catch (_) { return null; }
}

// Einen neuen Schluessel als WARTEND ablegen. Der bisherige bleibt unangetastet und gilt weiter,
// bis der neue bestaetigt ist — sonst koennte man sich beim Wechsel aufs neue Handy aussperren.
function wartendesGeheimnisAnlegen(db, userId, base32) {
  const verschluesselt = verschluesseln(base32, userId);
  const da = db.prepare('SELECT user_id FROM twofa_secrets WHERE user_id = ?').get(userId);
  if (da) {
    db.prepare('UPDATE twofa_secrets SET pending_enc = ? WHERE user_id = ?').run(verschluesselt, userId);
  } else {
    // Noch gar nichts vorhanden: secret_enc darf nicht NULL sein (Spalte ist NOT NULL), deshalb
    // steht der wartende Schluessel zunaechst in beiden Feldern. Ohne confirmed_at gilt er nicht.
    db.prepare(`INSERT INTO twofa_secrets (user_id, secret_enc, pending_enc, aktiv, confirmed_at, last_step)
                VALUES (?, ?, ?, 1, NULL, 0)`).run(userId, verschluesselt, verschluesselt);
  }
}

// Der wartende Schluessel wurde bestaetigt → er wird der gueltige.
function wartendesUebernehmen(db, userId) {
  db.prepare(`UPDATE twofa_secrets
              SET secret_enc = pending_enc, pending_enc = NULL, aktiv = 1,
                  confirmed_at = strftime('%Y-%m-%d %H:%M:%f','now')
              WHERE user_id = ? AND pending_enc IS NOT NULL`).run(userId);
}

// Stilllegen: Schluessel bleibt liegen, Geraete-Vertrauen faellt weg.
function stilllegen(db, userId) {
  try { db.prepare('UPDATE twofa_secrets SET aktiv = 0 WHERE user_id = ?').run(userId); } catch (_) {}
  try { db.prepare('DELETE FROM twofa_devices WHERE user_id = ?').run(userId); } catch (_) {}
}

function wiederAktivieren(db, userId) {
  db.prepare("UPDATE twofa_secrets SET aktiv = 1, confirmed_at = COALESCE(confirmed_at, strftime('%Y-%m-%d %H:%M:%f','now')) WHERE user_id = ?").run(userId);
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

// Vollstaendig entfernen — nur beim Zuruecksetzen durch Chef/Admin (verlorenes Handy).
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

function geraeteAlleLoeschen(db, userId) {
  try { db.prepare('DELETE FROM twofa_devices WHERE user_id = ?').run(userId); } catch (_) {}
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
  zustandLesen, eingerichtet, stillgelegt, EIGENE_MODI, eigenenModusSetzen,
  geheimnisLesen, wartendesGeheimnisLesen, wartendesGeheimnisAnlegen, wartendesUebernehmen,
  stilllegen, wiederAktivieren, schrittVerbrauchen, zuruecksetzen,
  geraetKennungErzeugen, geraetHash, geraetFinden, geraetMerken, geraetBenutzt, geraeteAlleLoeschen,
};
