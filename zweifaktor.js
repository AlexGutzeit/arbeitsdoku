// Regeln der Zwei-Faktor-Anmeldung: Wer muss wie oft einen Code eingeben?
//
// Bewusst getrennt von der Rechnerei (totp.js) und der Verschlüsselung (geheimnis.js): Hier steht
// nur Politik, keine Kryptografie. Die Kernfunktionen sind rein (Uhrzeit wird hereingereicht),
// damit sich jedes Intervall ohne Warten und ohne echte Zeit prüfen lässt.
const { notabschaltung } = require('./geheimnis');

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

module.exports = {
  MODI, MODUS_TEXT, FENSTER_TAGE, ROLLEN, schluesselFuer,
  modusFuerRolle, alleModi, cacheVergessen,
  einrichtungNoetig, geraetGueltig, codeNoetig,
};
