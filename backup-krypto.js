// Verschlüsselte Sicherungen — der Server kann sie erzeugen, aber nicht lesen.
//
// Warum überhaupt: Die Datenbank dieser App enthält Kundennamen und -adressen, Einsatzorte,
// Geburtsdaten und Abwesenheits-Kommentare. Sie wird viermal täglich gesichert, und diese
// Sicherungen liegen am Ende auf drei Rechnern — Server, Zweitanlage, Laptop. Eine einzige dieser
// Kopien in fremden Händen gibt alles preis. Genau das ist der Fall, gegen den hier etwas hilft.
//
// Was es NICHT löst: Wer den laufenden Server übernimmt, sieht die Daten trotzdem — die App muss
// sie ja lesen können. Eine Datenbankverschlüsselung mit dem Schlüssel daneben wäre deshalb
// Theater. Geschützt werden die RUHENDEN Kopien.
//
// Deshalb asymmetrisch: Auf den Servern liegen nur ÖFFENTLICHE Schlüssel. Sie können verpacken,
// nicht auspacken. Die privaten Teile liegen auf der Zweitanlage (damit der Notfall-Umschalter
// ohne Menschen läuft) und offline beim Chef.
//
// ECDH P-256 statt X25519 — nicht weil es besser wäre, sondern weil jeder Browser genau das in
// WebCrypto beherrscht. Dadurch entschlüsselt dieselbe Datei im Browser wie hier in Node, und es
// gibt nur EIN Format statt zwei, von denen eines ungetestet bleibt.
//
// Aufbau einer Datei:
//
//   "ADBK1\n"        6 Byte   Kennung. Bewusst KEIN Zip-Magic (PK\x03\x04) — eine verschlüsselte
//                             Datei soll nirgends versehentlich als Klartext-Zip durchgehen.
//   uint32 BE        4 Byte   Länge des Kopfes
//   Kopf             n Byte   JSON, siehe unten
//   Chiffrat         m Byte   AES-256-GCM über das Zip, mit dem KOPF als zusätzlich
//                             authentifizierten Daten
//   Tag             16 Byte   ganz am Ende, weil er beim Strömen erst zum Schluss feststeht
//
// Kopf:
//   { v:1, iv:"<b64>", empfaenger:[ { name, epk, wiv, wrap, wtag } ] }
//
// Je Empfänger wird ein flüchtiges Schlüsselpaar erzeugt, daraus mit dem öffentlichen Schlüssel
// des Empfängers ein gemeinsames Geheimnis abgeleitet (HKDF) und damit der zufällige
// Inhaltsschlüssel verpackt. Der Kopf geht als AAD in die Inhalts-Verschlüsselung — dadurch lässt
// sich kein Empfänger nachträglich austauschen, ohne dass die Prüfsumme bricht.
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('ADBK1\n', 'ascii');
const VERSION = 1;
const IV_BYTES = 12;      // von GCM empfohlen
const TAG_BYTES = 16;
const SCHLUESSEL_BYTES = 32;
const INFO = Buffer.from('arbeitsdoku-sicherung-v1', 'utf8');

// ── Schlüssel ──────────────────────────────────────────────────────────────────────────────────

function paarErzeugen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    oeffentlich: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privat: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

const oeffentlichLesen = (b64) =>
  crypto.createPublicKey({ key: Buffer.from(String(b64).trim(), 'base64'), format: 'der', type: 'spki' });
const privatLesen = (b64) =>
  crypto.createPrivateKey({ key: Buffer.from(String(b64).trim(), 'base64'), format: 'der', type: 'pkcs8' });

// Empfänger aus der Umgebung: "name:<oeffentlicher Schluessel>,name2:<...>"
//
// Ist nichts gesetzt, wird NICHT verschlüsselt und alles läuft wie bisher. Das ist Absicht: Dieses
// Repo ist öffentlich und wird auch von Fremdfirmen betrieben. Eine Pflichtvariable hiesse, dass
// deren Sicherung beim Update stillschweigend abbricht.
function empfaengerAusUmgebung(wert = process.env.BACKUP_EMPFAENGER) {
  const roh = String(wert || '').trim();
  if (!roh) return [];
  const raus = [];
  for (const stueck of roh.split(',')) {
    const s = stueck.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) throw new Error(`BACKUP_EMPFAENGER: „${s}" — erwartet wird name:schluessel`);
    const name = s.slice(0, i).trim();
    const b64 = s.slice(i + 1).trim();
    let schluessel;
    try { schluessel = oeffentlichLesen(b64); }
    catch (e) { throw new Error(`BACKUP_EMPFAENGER: Schlüssel von „${name}" ist unbrauchbar (${e.message})`); }
    raus.push({ name, schluessel, b64 });
  }
  return raus;
}

// ── Inhaltsschlüssel verpacken / auspacken ─────────────────────────────────────────────────────

// Das Salz bindet die Ableitung an BEIDE Seiten. Ohne das liesse sich ein Eintrag von einem
// Empfänger auf einen anderen umhängen.
function kek(gemeinsam, epkDer, empfaengerDer) {
  return Buffer.from(crypto.hkdfSync('sha256', gemeinsam, Buffer.concat([epkDer, empfaengerDer]), INFO, 32));
}

function fuerEmpfaengerVerpacken(inhaltsschluessel, empfaenger) {
  const fluechtig = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const epkDer = fluechtig.publicKey.export({ type: 'spki', format: 'der' });
  const empfDer = empfaenger.schluessel.export({ type: 'spki', format: 'der' });
  const gemeinsam = crypto.diffieHellman({ privateKey: fluechtig.privateKey, publicKey: empfaenger.schluessel });

  const wiv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', kek(gemeinsam, epkDer, empfDer), wiv);
  c.setAAD(MAGIC);
  const wrap = Buffer.concat([c.update(inhaltsschluessel), c.final()]);
  return {
    name: empfaenger.name,
    epk: epkDer.toString('base64'),
    wiv: wiv.toString('base64'),
    wrap: wrap.toString('base64'),
    wtag: c.getAuthTag().toString('base64'),
  };
}

// Probiert alle Einträge durch. Welcher zu diesem Schlüssel gehört, verrät der Prüfwert von
// selbst — deshalb muss im Kopf nicht stehen, wem welcher Eintrag gehört.
function inhaltsschluesselAuspacken(kopf, privat) {
  const empfDer = crypto.createPublicKey(privat).export({ type: 'spki', format: 'der' });
  for (const e of kopf.empfaenger || []) {
    try {
      const epkDer = Buffer.from(e.epk, 'base64');
      const gemeinsam = crypto.diffieHellman({
        privateKey: privat,
        publicKey: crypto.createPublicKey({ key: epkDer, format: 'der', type: 'spki' }),
      });
      const d = crypto.createDecipheriv('aes-256-gcm', kek(gemeinsam, epkDer, empfDer), Buffer.from(e.wiv, 'base64'));
      d.setAAD(MAGIC);
      d.setAuthTag(Buffer.from(e.wtag, 'base64'));
      const k = Buffer.concat([d.update(Buffer.from(e.wrap, 'base64')), d.final()]);
      if (k.length === SCHLUESSEL_BYTES) return k;
    } catch (_) { /* nicht unser Eintrag — nächster */ }
  }
  return null;
}

// ── Verschlüsseln (strömend) ───────────────────────────────────────────────────────────────────

// Liefert einen Transform: hinein das Zip, heraus der fertige Container. Strömend, weil die
// Sicherung mit der Dokumentenablage hunderte Megabyte gross werden kann — die will niemand
// vollständig im Speicher halten.
function verschluesselnStream(empfaenger) {
  if (!empfaenger || !empfaenger.length) throw new Error('Kein Empfänger angegeben');

  const inhaltsschluessel = crypto.randomBytes(SCHLUESSEL_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const kopf = Buffer.from(JSON.stringify({
    v: VERSION,
    iv: iv.toString('base64'),
    empfaenger: empfaenger.map(e => fuerEmpfaengerVerpacken(inhaltsschluessel, e)),
  }), 'utf8');

  const chiffre = crypto.createCipheriv('aes-256-gcm', inhaltsschluessel, iv);
  chiffre.setAAD(kopf);

  let kopfGeschrieben = false;
  return new Transform({
    transform(stueck, _kodierung, fertig) {
      try {
        if (!kopfGeschrieben) {
          const laenge = Buffer.alloc(4);
          laenge.writeUInt32BE(kopf.length, 0);
          this.push(Buffer.concat([MAGIC, laenge, kopf]));
          kopfGeschrieben = true;
        }
        this.push(chiffre.update(stueck));
        fertig();
      } catch (e) { fertig(e); }
    },
    flush(fertig) {
      try {
        if (!kopfGeschrieben) {   // leere Eingabe: Kopf muss trotzdem heraus
          const laenge = Buffer.alloc(4);
          laenge.writeUInt32BE(kopf.length, 0);
          this.push(Buffer.concat([MAGIC, laenge, kopf]));
        }
        this.push(chiffre.final());
        this.push(chiffre.getAuthTag());   // der Tag steht am Ende — vorher steht er nicht fest
        fertig();
      } catch (e) { fertig(e); }
    },
  });
}

// ── Entschlüsseln ──────────────────────────────────────────────────────────────────────────────

function istContainer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

function kopfLesen(buffer) {
  if (!istContainer(buffer)) throw new Error('Das ist keine verschlüsselte Sicherung');
  if (buffer.length < MAGIC.length + 4) throw new Error('Datei ist abgeschnitten');
  const laenge = buffer.readUInt32BE(MAGIC.length);
  const anfang = MAGIC.length + 4;
  // Obergrenze, damit eine kaputte Längenangabe nicht in eine absurde Speicheranforderung läuft.
  if (laenge <= 0 || laenge > 1024 * 1024 || anfang + laenge + TAG_BYTES > buffer.length) {
    throw new Error('Datei ist beschädigt (unplausibler Kopf)');
  }
  const rohKopf = buffer.subarray(anfang, anfang + laenge);
  let kopf;
  try { kopf = JSON.parse(rohKopf.toString('utf8')); }
  catch (_) { throw new Error('Datei ist beschädigt (Kopf unlesbar)'); }
  if (kopf.v !== VERSION) throw new Error(`Unbekannte Fassung ${kopf.v} — diese App kennt ${VERSION}`);
  return { kopf, rohKopf, datenAb: anfang + laenge };
}

function entschluesseln(buffer, privatB64) {
  const { kopf, rohKopf, datenAb } = kopfLesen(buffer);
  let privat;
  try { privat = privatLesen(privatB64); }
  catch (e) { throw new Error('Der Schlüssel ist unbrauchbar (' + e.message + ')'); }

  const inhaltsschluessel = inhaltsschluesselAuspacken(kopf, privat);
  if (!inhaltsschluessel) {
    const namen = (kopf.empfaenger || []).map(e => e.name).filter(Boolean).join(', ');
    throw new Error(`Dieser Schlüssel gehört nicht zu dieser Sicherung. Hinterlegt sind: ${namen || 'unbekannt'}.`);
  }

  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  const chiffrat = buffer.subarray(datenAb, buffer.length - TAG_BYTES);
  const d = crypto.createDecipheriv('aes-256-gcm', inhaltsschluessel, Buffer.from(kopf.iv, 'base64'));
  d.setAAD(rohKopf);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(chiffrat), d.final()]); }
  catch (_) { throw new Error('Die Sicherung ist beschädigt oder wurde verändert.'); }
}

// Wer kann diese Datei öffnen? Für Meldungen — verrät nichts Geheimes.
function empfaengerNamen(buffer) {
  try { return (kopfLesen(buffer).kopf.empfaenger || []).map(e => e.name).filter(Boolean); }
  catch (_) { return []; }
}

module.exports = {
  MAGIC, VERSION, TAG_BYTES,
  paarErzeugen, empfaengerAusUmgebung, oeffentlichLesen, privatLesen,
  verschluesselnStream, entschluesseln, istContainer, kopfLesen, empfaengerNamen,
};
