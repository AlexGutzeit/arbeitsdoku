// Verschlüsselte Sicherungen im BROWSER öffnen — dasselbe Format wie backup-krypto.js in Node.
//
// Warum im Browser und nicht auf dem Server: Der Server soll Sicherungen NICHT lesen können, das
// ist der ganze Zweck. Also muss der Schlüssel dort bleiben, wo er hingehört — beim Menschen. Er
// wird hier eingefügt, benutzt und danach vergessen; er verlässt das Gerät nie.
//
// Diese Datei wird an ZWEI Stellen eingebunden:
//   1. Einstellungen → Backup in der App (der Normalfall)
//   2. werkzeuge/sicherung-entschluesseln.html, das Hilfsprogramm für den Ernstfall
// Beide nutzen denselben Code. Sonst driften zwei Fassungen auseinander, und ausgerechnet die,
// die man im Ernstfall braucht, ist die nie benutzte.
//
// Alles hier steht in jedem Browser zur Verfügung (WebCrypto) — auch in einer Seite, die per
// Doppelklick von der Festplatte geöffnet wurde. Nachgemessen, nicht angenommen.
(function () {
  'use strict';

  const MAGIC = [0x41, 0x44, 0x42, 0x4b, 0x31, 0x0a];   // "ADBK1\n"
  const TAG_BYTES = 16;
  const INFO = new TextEncoder().encode('arbeitsdoku-sicherung-v1');

  const b64zuBytes = (b64) => {
    const roh = atob(String(b64).replace(/\s+/g, ''));
    const a = new Uint8Array(roh.length);
    for (let i = 0; i < roh.length; i++) a[i] = roh.charCodeAt(i);
    return a;
  };
  const zusammen = (...teile) => {
    const laenge = teile.reduce((s, t) => s + t.length, 0);
    const raus = new Uint8Array(laenge);
    let i = 0;
    for (const t of teile) { raus.set(t, i); i += t.length; }
    return raus;
  };

  function istContainer(bytes) {
    if (!bytes || bytes.length < MAGIC.length) return false;
    return MAGIC.every((b, i) => bytes[i] === b);
  }

  function kopfLesen(bytes) {
    if (!istContainer(bytes)) {
      const e = new Error('Das ist keine verschlüsselte Sicherung.');
      e.kennung = 'KEIN_CONTAINER';
      throw e;
    }
    if (bytes.length < MAGIC.length + 4) throw new Error('Die Datei ist abgeschnitten.');
    const sicht = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const laenge = sicht.getUint32(MAGIC.length, false);
    const anfang = MAGIC.length + 4;
    if (laenge <= 0 || laenge > 1024 * 1024 || anfang + laenge + TAG_BYTES > bytes.length) {
      throw new Error('Die Datei ist beschädigt (unplausibler Kopf).');
    }
    const rohKopf = bytes.subarray(anfang, anfang + laenge);
    let kopf;
    try { kopf = JSON.parse(new TextDecoder().decode(rohKopf)); }
    catch (_) { throw new Error('Die Datei ist beschädigt (Kopf unlesbar).'); }
    if (kopf.v !== 1) throw new Error('Unbekannte Fassung ' + kopf.v + ' — dieses Programm kennt 1.');
    return { kopf, rohKopf, datenAb: anfang + laenge };
  }

  function empfaengerNamen(bytes) {
    try { return (kopfLesen(bytes).kopf.empfaenger || []).map(e => e.name).filter(Boolean); }
    catch (_) { return []; }
  }

  // Der eigene öffentliche Schlüssel wird für das Salz gebraucht. WebCrypto kann ihn aus einem
  // privaten nicht direkt herausgeben — also über JWK: das „d" (den geheimen Teil) weglassen und
  // den Rest als öffentlichen Schlüssel wieder einlesen.
  async function eigenerOeffentlicher(privat) {
    const jwk = await crypto.subtle.exportKey('jwk', privat);
    delete jwk.d;
    jwk.key_ops = [];
    const oeff = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return new Uint8Array(await crypto.subtle.exportKey('spki', oeff));
  }

  async function kek(gemeinsam, epkDer, eigenDer) {
    const basis = await crypto.subtle.importKey('raw', gemeinsam, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: zusammen(epkDer, eigenDer), info: INFO }, basis, 256);
    return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
  }

  // Probiert alle Einträge durch — welcher zu diesem Schlüssel gehört, verrät der Prüfwert.
  async function inhaltsschluesselAuspacken(kopf, privat) {
    const eigenDer = await eigenerOeffentlicher(privat);
    for (const e of kopf.empfaenger || []) {
      try {
        const epkDer = b64zuBytes(e.epk);
        const epk = await crypto.subtle.importKey('spki', epkDer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const gemeinsam = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, privat, 256);
        const schluessel = await kek(new Uint8Array(gemeinsam), epkDer, eigenDer);
        const roh = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64zuBytes(e.wiv), additionalData: new Uint8Array(MAGIC), tagLength: 128 },
          schluessel,
          zusammen(b64zuBytes(e.wrap), b64zuBytes(e.wtag)));
        if (roh.byteLength === 32) return new Uint8Array(roh);
      } catch (_) { /* nicht unser Eintrag — nächster */ }
    }
    return null;
  }

  async function privatLesen(b64) {
    try {
      return await crypto.subtle.importKey('pkcs8', b64zuBytes(b64),
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    } catch (e) {
      throw new Error('Der Schlüssel ist unbrauchbar. Er sollte eine einzige lange Zeile sein — '
                    + 'ohne Zeilenumbrüche und ohne Anführungszeichen.');
    }
  }

  /**
   * Öffnet eine verschlüsselte Sicherung.
   * @param {Uint8Array} bytes  Inhalt der .adbk-Datei
   * @param {string} privatB64  privater Schlüssel (Base64, eine Zeile)
   * @returns {Promise<Uint8Array>} das ursprüngliche Zip
   */
  async function entschluesseln(bytes, privatB64) {
    const { kopf, rohKopf, datenAb } = kopfLesen(bytes);
    const privat = await privatLesen(privatB64);

    const inhaltsschluessel = await inhaltsschluesselAuspacken(kopf, privat);
    if (!inhaltsschluessel) {
      const namen = (kopf.empfaenger || []).map(e => e.name).filter(Boolean).join(', ');
      throw new Error('Dieser Schlüssel gehört nicht zu dieser Sicherung. Hinterlegt sind: '
                    + (namen || 'unbekannt') + '.');
    }

    const k = await crypto.subtle.importKey('raw', inhaltsschluessel, 'AES-GCM', false, ['decrypt']);
    try {
      // WebCrypto erwartet Chiffrat UND Tag zusammen — genau so liegen sie in der Datei.
      const klar = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64zuBytes(kopf.iv), additionalData: rohKopf, tagLength: 128 },
        k, bytes.subarray(datenAb));
      return new Uint8Array(klar);
    } catch (_) {
      throw new Error('Die Sicherung ist beschädigt oder wurde verändert.');
    }
  }

  window.SicherungKrypto = { istContainer, empfaengerNamen, entschluesseln };
})();
