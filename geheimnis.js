// Verschlüsselung der TOTP-Geheimnisse (AES-256-GCM) und der Notfall-Schalter für 2FA.
//
// Warum überhaupt verschlüsseln: Das TOTP-Geheimnis ist der zweite Faktor. Wer es liest, kann für
// jeden, dessen Passwort er kennt, gültige Codes erzeugen — der Schutz wäre wertlos. Die Datenbank
// dieser App wird viermal täglich als Sicherung auf zwei Server gelegt; eine dieser Kopien in
// fremden Händen darf nicht reichen.
//
// GCM statt CBC, weil es die Daten nicht nur verschlüsselt, sondern auch merkt, wenn jemand am
// Chiffrat herumgespielt hat (Authentifizierungs-Tag).
const crypto = require('crypto');

const IV_BYTES = 12;    // von GCM empfohlen
const VERSION = 'v1';   // Präfix im Datensatz, damit ein späterer Verfahrenswechsel möglich bleibt

let _schluessel = null;
let _herkunftGemeldet = false;

// Woher der Schlüssel kommt:
//   1. TWOFA_KEY aus der .env — der saubere Weg für den Produktivbetrieb
//   2. sonst abgeleitet aus JWT_SECRET (HKDF-SHA256)
//
// Warum überhaupt ein Rückfall: Dieses Repo ist öffentlich und wird auch von Fremdfirmen betrieben.
// Eine neue PFLICHT-Variable hiesse, dass jeder Bestandsserver beim Update entweder nicht mehr
// startet oder 2FA still kaputt hat. Mit dem Rückfall ist das Geheimnis IMMER verschlüsselt, ohne
// dass jemand etwas tun muss.
//
// Der Preis, und der gehört in die Doku: Wer JWT_SECRET austauscht, macht damit alle
// TOTP-Geheimnisse unlesbar — dann muss der Admin für jeden zurücksetzen. Deshalb steht in
// .env.example die Empfehlung, TWOFA_KEY ausdrücklich zu setzen und wie JWT_SECRET zu sichern.
function schluessel() {
  if (_schluessel) return _schluessel;

  const roh = (process.env.TWOFA_KEY || '').trim();
  if (roh) {
    let buf = null;
    if (/^[0-9a-fA-F]{64}$/.test(roh)) buf = Buffer.from(roh, 'hex');
    else { try { const b = Buffer.from(roh, 'base64'); if (b.length === 32) buf = b; } catch (_) {} }
    if (buf) {
      if (!_herkunftGemeldet) { console.log('2FA: Verschlüsselung nutzt TWOFA_KEY aus der Umgebung.'); _herkunftGemeldet = true; }
      _schluessel = buf;
      return _schluessel;
    }
    // Absichtlich KEIN process.exit: Ein Tippfehler in der .env darf nicht die ganze Firma
    // aussperren. Laut und weiter — der Rückfall greift.
    console.error('2FA: TWOFA_KEY ist unbrauchbar (erwartet 32 Byte als hex oder base64). '
      + 'Es wird ersatzweise aus JWT_SECRET abgeleitet.');
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) throw new Error('Weder TWOFA_KEY noch JWT_SECRET gesetzt — keine Verschlüsselung möglich');
  _schluessel = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(jwtSecret, 'utf8'),
    Buffer.from('arbeitsdoku-2fa-v1', 'utf8'), Buffer.from('totp-geheimnis', 'utf8'), 32));
  if (!_herkunftGemeldet) {
    console.log('2FA: kein TWOFA_KEY gesetzt — Verschlüsselung wird aus JWT_SECRET abgeleitet. '
      + 'Achtung: Ein Wechsel von JWT_SECRET macht alle Authenticator-Einrichtungen ungültig.');
    _herkunftGemeldet = true;
  }
  return _schluessel;
}

// Die Nutzer-Id wird als „zusätzliche authentifizierte Daten" mitgerechnet. Dadurch lässt sich eine
// Geheimnis-Zeile nicht per Datenbank-Bearbeitung von einem Nutzer auf einen anderen umhängen —
// die Entschlüsselung schlägt dann fehl, statt still das falsche Geheimnis zu liefern.
function aad(userId) { return Buffer.from('user:' + String(userId), 'utf8'); }

function verschluesseln(klartext, userId) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  c.setAAD(aad(userId));
  const ct = Buffer.concat([c.update(String(klartext), 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function entschluesseln(datensatz, userId) {
  const teile = String(datensatz || '').split(':');
  if (teile.length !== 4 || teile[0] !== VERSION) throw new Error('Unbekanntes Format des verschlüsselten Geheimnisses');
  const [, ivB64, tagB64, ctB64] = teile;
  const d = crypto.createDecipheriv('aes-256-gcm', schluessel(), Buffer.from(ivB64, 'base64'));
  d.setAAD(aad(userId));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

// Notfall-Schalter. Gesetzt heisst: 2FA wird nirgends verlangt — kein Code beim Anmelden, keine
// erzwungene Einrichtung. Es wird dabei NICHTS gelöscht; Variable entfernen, Neustart, alles greift
// wieder. Das ist der Weg zurück, wenn sich jemand ausgesperrt hat oder der Schlüssel verloren ging.
function notabschaltung() {
  const v = String(process.env.TWOFA_AUS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'ja';
}

// Nur für Tests: zwischengespeicherten Schlüssel vergessen, damit eine geänderte Umgebung greift.
function _schluesselVergessen() { _schluessel = null; _herkunftGemeldet = false; }

module.exports = { verschluesseln, entschluesseln, notabschaltung, schluessel, _schluesselVergessen };
