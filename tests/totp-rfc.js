// TOTP-Kern gegen die NORM prüfen, nicht gegen sich selbst (RFC 6238 / RFC 4226 / RFC 4648).
//
// Der Sinn dieses Tests: `totp.js` ist selbst gebaut. Ein Test, der die Erwartung aus derselben
// Funktion zieht, wäre wertlos — er würde jeden Rechenfehler brav mitmachen. Deshalb stehen hier
// die offiziellen Testvektoren aus den RFCs als feste Zahlen. Stimmt unsere Rechnung damit
// überein, ist sie mit Google Authenticator, Aegis, 2FAS und allen anderen kompatibel.
//
// Kein Server, keine Datenbank, keine Uhr von aussen — läuft in Sekunden.
//
//   node tests/totp-rfc.js
const totp = require('../totp');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// RFC 6238, Appendix B: Schlüssel "12345678901234567890" (20 Byte ASCII), SHA-1, 8 Stellen.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VEKTOREN = [
  { t: 59,          code: '94287082' },
  { t: 1111111109,  code: '07081804' },
  { t: 1111111111,  code: '14050471' },
  { t: 1234567890,  code: '89005924' },
  { t: 2000000000,  code: '69279037' },
  { t: 20000000000, code: '65353130' },   // Zeit jenseits von 2^32 — die Zeit darf nirgends gestutzt werden
];

console.log('── RFC 6238, Anhang B: die offiziellen Testvektoren ──');
console.log(`   Schlüssel in Base32: ${RFC_SECRET}`);
for (const v of RFC_VEKTOREN) {
  const berechnet = totp.code(RFC_SECRET, v.t * 1000, { stellen: 8 });
  ok(`T = ${v.t} → ${v.code}`, berechnet === v.code, `berechnet ${berechnet}`);
}

console.log('\n── Gegenprobe: die Vektoren sind nicht zufällig zu treffen ──');
// Achtung, hier lag meine erste Erwartung daneben: Die Fenster sind 0-29, 30-59, 60-89 — T=59 und
// T=60 liegen also in VERSCHIEDENEN Fenstern. Gleiches Fenster wie 59 hat z. B. 45.
ok('derselbe Zeitschritt liefert denselben Code (T=45 liegt im Fenster von T=59)',
  totp.code(RFC_SECRET, 45 * 1000, { stellen: 8 }) === '94287082',
  totp.code(RFC_SECRET, 45 * 1000, { stellen: 8 }));
ok('… und der Fensterwechsel bei T=60 liefert einen anderen',
  totp.code(RFC_SECRET, 60 * 1000, { stellen: 8 }) !== '94287082');
ok('… ein Fenster weiter aber NICHT',
  totp.code(RFC_SECRET, 90 * 1000, { stellen: 8 }) !== '94287082',
  totp.code(RFC_SECRET, 90 * 1000, { stellen: 8 }));
ok('ein anderer Schlüssel liefert einen anderen Code',
  totp.code(totp.base32Encode(Buffer.from('22345678901234567890', 'ascii')), 59000, { stellen: 8 }) !== '94287082');

console.log('\n── RFC 4648: Base32 ──');
// Die Testvektoren des RFC nutzen Auffüllzeichen; wir kodieren bewusst ohne, deshalb hier ohne '='.
const B32 = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'],
             ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
for (const [klar, kodiert] of B32) {
  const e = totp.base32Encode(Buffer.from(klar, 'ascii'));
  ok(`"${klar}" → ${kodiert || '(leer)'}`, e === kodiert, e);
}
ok('Dekodieren mit Auffüllzeichen funktioniert', totp.base32Decode('MZXW6YTBOI======').toString() === 'foobar');
ok('… und mit Leerzeichen und Kleinschreibung (so tippt man ab)',
  totp.base32Decode('mzxw 6ytb oi').toString() === 'foobar');
let warf = false;
try { totp.base32Decode('MZXW60!!'); } catch (_) { warf = true; }
ok('ein ungültiges Zeichen wirft, statt still Unsinn zu liefern', warf);

console.log('\n── Hin und zurück, 200 Zufallsschlüssel ──');
let rundReise = true;
for (let i = 0; i < 200; i++) {
  const roh = require('crypto').randomBytes(1 + (i % 25));
  if (!totp.base32Decode(totp.base32Encode(roh)).equals(roh)) { rundReise = false; break; }
}
ok('jeder Schlüssel kommt unverändert zurück', rundReise);

console.log('\n── Zeitfenster-Toleranz (Uhrenabweichung zwischen Handy und Server) ──');
const G = totp.geheimnisErzeugen();
const T0 = 1_700_000_000_000;   // fester Zeitpunkt, damit der Test nicht von der echten Uhr abhängt
const codeJetzt = totp.code(G, T0);
const codeVorher = totp.code(G, T0 - 30_000);
const codeSpaeter = totp.code(G, T0 + 30_000);
ok('der aktuelle Code wird angenommen', totp.pruefe(G, codeJetzt, { jetztMs: T0 }) !== null);
ok('der vorige Code wird angenommen (Handy geht 30 s nach)', totp.pruefe(G, codeVorher, { jetztMs: T0 }) !== null);
ok('der nächste Code wird angenommen (Handy geht 30 s vor)', totp.pruefe(G, codeSpaeter, { jetztMs: T0 }) !== null);
ok('zwei Fenster zurück wird NICHT angenommen', totp.pruefe(G, totp.code(G, T0 - 90_000), { jetztMs: T0 }) === null);
ok('zwei Fenster vor wird NICHT angenommen', totp.pruefe(G, totp.code(G, T0 + 90_000), { jetztMs: T0 }) === null);
ok('mit fenster:0 fällt die Nachsicht weg', totp.pruefe(G, codeVorher, { jetztMs: T0, fenster: 0 }) === null);

console.log('\n── Rückgabe ist der Zeitschritt (Grundlage des Replay-Riegels) ──');
const schrittJetzt = totp.pruefe(G, codeJetzt, { jetztMs: T0 });
ok('der zurückgegebene Schritt passt zum Zeitpunkt', schrittJetzt === totp.schrittFuer(T0), String(schrittJetzt));
ok('… und der vorige Code liefert einen KLEINEREN Schritt',
  totp.pruefe(G, codeVorher, { jetztMs: T0 }) === totp.schrittFuer(T0) - 1);

console.log('\n── Unsinnige Eingaben ──');
for (const [was, eingabe] of [['leer', ''], ['zu kurz', '12345'], ['zu lang', '1234567'],
                              ['Buchstaben', 'abcdef'], ['nichts', null], ['Objekt', {}]]) {
  ok(`${was} → abgelehnt`, totp.pruefe(G, eingabe, { jetztMs: T0 }) === null);
}
ok('Leerzeichen im Code stören nicht (Apps zeigen "123 456")',
  totp.pruefe(G, codeJetzt.slice(0, 3) + ' ' + codeJetzt.slice(3), { jetztMs: T0 }) !== null);

console.log('\n── otpauth-URI für den QR-Code ──');
const uri = totp.otpauthUri(G, 'alex', 'SenTec');
ok('beginnt richtig', uri.startsWith('otpauth://totp/'), uri);
ok('enthält Aussteller und Konto', uri.includes('SenTec%3Aalex'), uri);
ok('enthält den Schlüssel', uri.includes('secret=' + G));
ok('nennt Verfahren, Stellen und Takt ausdrücklich',
  uri.includes('algorithm=SHA1') && uri.includes('digits=6') && uri.includes('period=30'), uri);

console.log('\n── Erzeugte Geheimnisse ──');
const zwei = [totp.geheimnisErzeugen(), totp.geheimnisErzeugen()];
ok('sind 32 Zeichen lang (160 Bit)', zwei[0].length === 32, String(zwei[0].length));
ok('bestehen nur aus dem Base32-Alphabet', /^[A-Z2-7]+$/.test(zwei[0]), zwei[0]);
ok('sind nicht zweimal dasselbe', zwei[0] !== zwei[1]);

console.log(`\nTOTP gegen den Standard: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
process.exit(fail === 0 ? 0 : 1);
