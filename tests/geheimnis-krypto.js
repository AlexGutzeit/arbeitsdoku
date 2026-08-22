// Verschlüsselung der TOTP-Geheimnisse und der Notfall-Schalter (geheimnis.js).
//
// Was hier wirklich geprüft wird, ist nicht „lässt sich das wieder entschlüsseln" — das wäre
// billig. Sondern die Fälle, in denen es NICHT klappen darf: fremder Schlüssel, verändertes
// Chiffrat, umgehängte Nutzer-Id. Genau daran hängt, ob eine gestohlene Sicherungskopie etwas wert
// ist.
//
// Kein Server, keine Datenbank.
//
//   node tests/geheimnis-krypto.js
const crypto = require('crypto');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const wirft = (fn) => { try { fn(); return false; } catch (_) { return true; } };

// Umgebung sauber setzen, bevor das Modul den Schlüssel zieht.
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
delete process.env.TWOFA_KEY;
delete process.env.TWOFA_AUS;
const g = require('../geheimnis');

const GEHEIM = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';   // wie ein Base32-TOTP-Schlüssel

console.log('── Hin und zurück ──');
const blob = g.verschluesseln(GEHEIM, 42);
ok('das Ergebnis ist nicht der Klartext', !blob.includes(GEHEIM), blob.slice(0, 40));
ok('es beginnt mit der Version', blob.startsWith('v1:'), blob.slice(0, 12));
ok('es besteht aus vier Teilen', blob.split(':').length === 4);
ok('entschlüsselt kommt der Schlüssel zurück', g.entschluesseln(blob, 42) === GEHEIM);

console.log('\n── Jede Verschlüsselung sieht anders aus ──');
const zweiter = g.verschluesseln(GEHEIM, 42);
ok('zweimal derselbe Klartext ergibt zwei verschiedene Datensätze', blob !== zweiter);
ok('… beide lassen sich trotzdem lesen', g.entschluesseln(zweiter, 42) === GEHEIM);

console.log('\n── Was NICHT gehen darf ──');
ok('mit fremder Nutzer-Id schlägt es fehl (Zeile lässt sich nicht umhängen)',
  wirft(() => g.entschluesseln(blob, 43)));
const teile = blob.split(':');
const ctRoh = Buffer.from(teile[3], 'base64');
ctRoh[0] ^= 0x01;                                   // ein einziges Bit kippen
const verbogen = [teile[0], teile[1], teile[2], ctRoh.toString('base64')].join(':');
ok('ein gekipptes Bit im Chiffrat wird bemerkt', wirft(() => g.entschluesseln(verbogen, 42)));
const tagRoh = Buffer.from(teile[2], 'base64'); tagRoh[0] ^= 0x01;
ok('ein verändertes Prüfsiegel wird bemerkt',
  wirft(() => g.entschluesseln([teile[0], teile[1], tagRoh.toString('base64'), teile[3]].join(':'), 42)));
ok('ein fremdes Format wirft, statt still etwas zu liefern', wirft(() => g.entschluesseln('v9:a:b:c', 42)));
ok('Unsinn wirft', wirft(() => g.entschluesseln('einfach-nur-text', 42)));
ok('leer wirft', wirft(() => g.entschluesseln('', 42)));

console.log('\n── Ein anderer Schlüssel kann nichts damit anfangen ──');
// Das ist der eigentliche Punkt: Wer nur die Datenbank hat, aber nicht den Schlüssel, steht an.
g._schluesselVergessen();
process.env.TWOFA_KEY = crypto.randomBytes(32).toString('base64');
ok('mit einem anderen TWOFA_KEY schlägt das Entschlüsseln fehl', wirft(() => g.entschluesseln(blob, 42)));
const mitEigenem = g.verschluesseln(GEHEIM, 42);
ok('… mit diesem Schlüssel klappt es dagegen', g.entschluesseln(mitEigenem, 42) === GEHEIM);

console.log('\n── Schlüsselherkunft ──');
g._schluesselVergessen();
process.env.TWOFA_KEY = crypto.randomBytes(32).toString('hex');
ok('hex-Schreibweise wird angenommen', g.schluessel().length === 32);
g._schluesselVergessen();
process.env.TWOFA_KEY = 'viel-zu-kurz';
ok('ein unbrauchbarer TWOFA_KEY sperrt niemanden aus, sondern fällt auf JWT_SECRET zurück',
  g.schluessel().length === 32);
g._schluesselVergessen();
delete process.env.TWOFA_KEY;
const ausJwt1 = g.schluessel().toString('hex');
g._schluesselVergessen();
const ausJwt2 = g.schluessel().toString('hex');
ok('ohne TWOFA_KEY wird aus JWT_SECRET abgeleitet — und zwar immer gleich', ausJwt1 === ausJwt2);
g._schluesselVergessen();
process.env.JWT_SECRET = 'ein-ganz-anderes-secret-mit-genug-zeichen';
ok('… ein anderes JWT_SECRET ergibt einen anderen Schlüssel', g.schluessel().toString('hex') !== ausJwt1);
ok('… und macht damit alte Datensätze unlesbar (der dokumentierte Preis)',
  wirft(() => g.entschluesseln(blob, 42)));
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
g._schluesselVergessen();

console.log('\n── Notfall-Schalter ──');
delete process.env.TWOFA_AUS;
ok('standardmäßig aus', g.notabschaltung() === false);
for (const wert of ['1', 'true', 'ja', 'JA', 'True']) {
  process.env.TWOFA_AUS = wert;
  ok(`TWOFA_AUS=${wert} schaltet ab`, g.notabschaltung() === true);
}
for (const wert of ['0', 'false', 'nein', '']) {
  process.env.TWOFA_AUS = wert;
  ok(`TWOFA_AUS=${wert || '(leer)'} schaltet NICHT ab`, g.notabschaltung() === false);
}
delete process.env.TWOFA_AUS;

console.log(`\nGeheimnis-Verschlüsselung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
process.exit(fail === 0 ? 0 : 1);
