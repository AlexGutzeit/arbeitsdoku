// Zeitbasierte Einmal-Codes (TOTP, RFC 6238) für die Zwei-Faktor-Anmeldung.
//
// Warum selbst gebaut statt Paket: Das Verfahren ist ein HMAC-SHA1 über einen Zähler und ein
// bisschen Bit-Schieberei — node:crypto kann alles davon. Entscheidend ist aber etwas anderes:
// Der RFC liefert offizielle Testvektoren mit. Dieser Code lässt sich damit GEGEN DIE NORM
// beweisen (tests/totp-rfc.js), nicht nur gegen sich selbst. Bei einer Fremdbibliothek müsste man
// glauben, dass sie stimmt — und hätte eine Lieferkette mehr in einem öffentlichen Repo, das auch
// Fremdfirmen betreiben.
//
// Kompatibel mit Google Authenticator, Aegis, 2FAS, Microsoft Authenticator:
// SHA-1, 6 Stellen, 30-Sekunden-Fenster. Das sind die Vorgabewerte, die alle Apps annehmen, wenn
// die otpauth-URI nichts anderes sagt.
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // RFC 4648
const SCHRITT_SEK = 30;
const STELLEN = 6;

// --- Base32 ------------------------------------------------------------------------------------
// Authenticator-Apps erwarten den Schlüssel in Base32, nicht in Hex oder Base64.

function base32Encode(buf) {
  let bits = 0, wert = 0, aus = '';
  for (const byte of buf) {
    wert = (wert << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      aus += BASE32_ALPHABET[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) aus += BASE32_ALPHABET[(wert << (5 - bits)) & 31];
  return aus;   // bewusst ohne '='-Auffüllung: Authenticator-Apps stört sie, der Standard erlaubt beides
}

// Beim Lesen grosszuegig sein: Nutzer tippen den Schluessel ab, mit Leerzeichen, klein, mit '='.
function base32Decode(text) {
  const sauber = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!sauber) throw new Error('Leerer Base32-Schlüssel');
  let bits = 0, wert = 0;
  const bytes = [];
  for (const zeichen of sauber) {
    const idx = BASE32_ALPHABET.indexOf(zeichen);
    if (idx === -1) throw new Error('Ungültiges Zeichen im Base32-Schlüssel: ' + zeichen);
    wert = (wert << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((wert >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// --- Code-Berechnung ---------------------------------------------------------------------------

function geheimnisErzeugen(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));   // 160 Bit, wie im RFC empfohlen
}

// HOTP (RFC 4226): HMAC-SHA1 über den Zähler, dann „dynamic truncation".
function hotp(schluessel, zaehler, stellen = STELLEN) {
  // Der RFC schreibt einen 8-Byte-Zähler in Big-Endian vor. `writeBigUInt64BE` ist die
  // wortgetreue Umsetzung und trägt bis zum Jahr 6053 (dann erst überschreitet T/30 die 32 Bit).
  // Nachgemessen, weil ich es zuerst falsch behauptet hatte: Der grösste RFC-Vektor
  // T = 20000000000 liegt zwar jenseits von 2^32, sein ZÄHLER (T/30 = 666.666.666) aber nicht —
  // der Vektor beweist also nicht die 64-Bit-Behandlung, sondern nur, dass die Zeit selbst
  // nirgends auf 32 Bit gestutzt wird. Was die Vektoren sehr wohl absichern: dass der Zähler in
  // den HINTEREN vier Bytes steht (an Position 0 fallen alle sechs um).
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(BigInt(zaehler));
  const hmac = crypto.createHmac('sha1', schluessel).update(block).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const zahl = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(zahl % 10 ** stellen).padStart(stellen, '0');
}

function schrittFuer(zeitpunktMs, schrittSek = SCHRITT_SEK) {
  return Math.floor(zeitpunktMs / 1000 / schrittSek);
}

function code(geheimBase32, zeitpunktMs = Date.now(), { stellen = STELLEN, schrittSek = SCHRITT_SEK } = {}) {
  return hotp(base32Decode(geheimBase32), schrittFuer(zeitpunktMs, schrittSek), stellen);
}

// Prüft eine Eingabe und gibt den passenden ZEITSCHRITT zurück (oder null).
//
// Warum der Schritt und nicht nur wahr/falsch: Ein Code gilt bis zu 90 Sekunden. Wer ihn abfängt,
// könnte ihn erneut einlösen. Der Aufrufer merkt sich deshalb den zuletzt benutzten Schritt und
// lehnt alles ab, was nicht NEUER ist (Replay-Riegel in routes/auth.js).
//
// `fenster = 1` erlaubt den vorigen und den nächsten Schritt — deckt eine Uhrenabweichung von
// bis zu 30 Sekunden zwischen Handy und Server ab.
function pruefe(geheimBase32, eingabe, { jetztMs = Date.now(), fenster = 1, stellen = STELLEN, schrittSek = SCHRITT_SEK } = {}) {
  const getippt = String(eingabe || '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${stellen}}$`).test(getippt)) return null;
  const schluessel = base32Decode(geheimBase32);
  const jetzt = schrittFuer(jetztMs, schrittSek);
  for (let v = -fenster; v <= fenster; v++) {
    const erwartet = hotp(schluessel, jetzt + v, stellen);
    // Zeitgleicher Vergleich: verrät über die Antwortzeit nicht, wie viele Stellen stimmen.
    const a = Buffer.from(erwartet), b = Buffer.from(getippt);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return jetzt + v;
  }
  return null;
}

// --- Einrichtung -------------------------------------------------------------------------------

// otpauth-URI für den QR-Code. Der Anzeigename in der App wird „Aussteller (Konto)".
function otpauthUri(geheimBase32, konto, aussteller = 'Arbeitsdoku') {
  const kennung = encodeURIComponent(`${aussteller}:${konto}`);
  const p = new URLSearchParams({
    secret: geheimBase32,
    issuer: aussteller,
    algorithm: 'SHA1',
    digits: String(STELLEN),
    period: String(SCHRITT_SEK),
  });
  return `otpauth://totp/${kennung}?${p.toString()}`;
}

module.exports = {
  base32Encode, base32Decode, geheimnisErzeugen, hotp, code, pruefe, otpauthUri,
  schrittFuer, SCHRITT_SEK, STELLEN,
};
