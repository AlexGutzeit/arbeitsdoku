// Der Container für verschlüsselte Sicherungen (Alex, 24.08.2026).
//
// Hier hängt der Bestand dran: Kommt aus dem Container nicht Byte für Byte dasselbe Zip heraus,
// ist die Historie verloren — und zwar unbemerkt, bis jemand sie braucht. Deshalb wird nicht
// geprüft, ob „irgendetwas herauskommt", sondern ob es DASSELBE ist.
//
// Geprüft wird ausserdem, dass die Datei sich nicht heimlich verändern lässt: GCM merkt jede
// Änderung am Chiffrat, am Kopf und am Tag. Ohne diese Prüfung könnte jemand einen Empfänger
// austauschen oder Daten unterschieben.
//
//   node tests/backup-krypto.js
const crypto = require('crypto');
const { Readable } = require('stream');
const k = require('../backup-krypto');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// Bequemer Weg vom Puffer durch den Transform zum Puffer.
function verschluesseln(daten, empfaenger) {
  return new Promise((res, rej) => {
    const teile = [];
    Readable.from([daten])
      .pipe(k.verschluesselnStream(empfaenger))
      .on('data', d => teile.push(d))
      .on('end', () => res(Buffer.concat(teile)))
      .on('error', rej);
  });
}
const empf = (name, paar) => ({ name, schluessel: k.oeffentlichLesen(paar.oeffentlich), b64: paar.oeffentlich });

(async () => {
  const minipc = k.paarErzeugen();
  const offline = k.paarErzeugen();
  const fremd = k.paarErzeugen();
  const empfaenger = [empf('minipc', minipc), empf('offline', offline)];

  console.log('── Schlüsselpaare ──');
  ok('öffentlicher Schlüssel ist Base64 und lesbar', /^[A-Za-z0-9+/=]+$/.test(minipc.oeffentlich) && !!k.oeffentlichLesen(minipc.oeffentlich));
  ok('privater ebenso', !!k.privatLesen(minipc.privat));
  ok('zwei Aufrufe liefern verschiedene Paare', minipc.privat !== offline.privat);

  console.log('\n── Hin und zurück ──');
  // Ein Zip-artiger Puffer mit erkennbarem Inhalt — daran zeigt sich später, ob wirklich
  // verschlüsselt wurde.
  const klartext = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('Kundenname Mustermann GmbH, Musterstrasse 1, 96199 Zapfendorf'),
    crypto.randomBytes(50000),
  ]);
  const container = await verschluesseln(klartext, empfaenger);
  ok('die Datei trägt die Kennung ADBK1', k.istContainer(container));
  ok('… und ist KEIN Zip', !(container[0] === 0x50 && container[1] === 0x4b), container.subarray(0, 6).toString('hex'));
  ok('sie nennt beide Empfänger', JSON.stringify(k.empfaengerNamen(container)) === '["minipc","offline"]',
    JSON.stringify(k.empfaengerNamen(container)));

  ok('der Mini-PC-Schlüssel liefert das Zip Byte für Byte zurück',
    k.entschluesseln(container, minipc.privat).equals(klartext));
  ok('der Offline-Schlüssel ebenso',
    k.entschluesseln(container, offline.privat).equals(klartext));

  console.log('\n── Und der Klartext steht wirklich nicht mehr drin ──');
  // Die eigentliche Frage. Ohne diese Zeile könnte der Container den Inhalt einfach durchreichen
  // und alle Prüfungen oben wären trotzdem grün.
  ok('der Kundenname ist im Container nicht zu finden',
    container.indexOf(Buffer.from('Mustermann')) === -1);
  ok('… und die Adresse auch nicht', container.indexOf(Buffer.from('Zapfendorf')) === -1);
  ok('… im Klartext dagegen sehr wohl (die Suche taugt also etwas)',
    klartext.indexOf(Buffer.from('Mustermann')) > 0);

  console.log('\n── Ein fremder Schlüssel nützt nichts ──');
  try { k.entschluesseln(container, fremd.privat); ok('fremder Schlüssel wird abgewiesen', false, 'er kam durch!'); }
  catch (e) { ok('fremder Schlüssel wird abgewiesen', /gehört nicht/i.test(e.message), e.message); }
  try { k.entschluesseln(container, 'kein-schluessel'); ok('Unsinn statt Schlüssel wird abgewiesen', false); }
  catch (e) { ok('Unsinn statt Schlüssel wird abgewiesen', /unbrauchbar/i.test(e.message), e.message); }

  console.log('\n── Veränderte Dateien fallen auf ──');
  const kaputt = (pos, was) => { const b = Buffer.from(container); b[pos] ^= 0xff; return b; };
  const scheitert = (b) => { try { k.entschluesseln(b, minipc.privat); return false; } catch (_) { return true; } };
  ok('ein verändertes Byte im Chiffrat', scheitert(kaputt(container.length - 100)));
  ok('ein verändertes Byte im Tag', scheitert(kaputt(container.length - 1)));
  ok('ein verändertes Byte im Kopf', scheitert(kaputt(40)));
  ok('eine abgeschnittene Datei', scheitert(container.subarray(0, container.length - 40)));
  ok('… und die unveränderte geht weiterhin', !scheitert(container));

  console.log('\n── Kaputte Eingaben stürzen nicht ab ──');
  for (const [was, b] of [
    ['leer', Buffer.alloc(0)],
    ['nur die Kennung', Buffer.from('ADBK1\n')],
    ['ein echtes Zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])],
    ['unsinnige Kopflänge', Buffer.concat([Buffer.from('ADBK1\n'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(20)])],
  ]) {
    try { k.entschluesseln(b, minipc.privat); ok(`${was}: wird abgewiesen`, false, 'kam durch'); }
    catch (e) { ok(`${was}: wird mit klarer Meldung abgewiesen`, e.message.length > 10 && !/undefined|Cannot read/.test(e.message), e.message); }
  }
  ok('istContainer erkennt ein Zip als NICHT-Container', !k.istContainer(Buffer.from([0x50, 0x4b, 0x03, 0x04])));

  console.log('\n── Empfänger aus der Umgebung ──');
  ok('leer → keine Verschlüsselung (Fremdfirmen ohne Konfiguration)', k.empfaengerAusUmgebung('').length === 0);
  ok('einer', k.empfaengerAusUmgebung(`minipc:${minipc.oeffentlich}`).length === 1);
  const zwei = k.empfaengerAusUmgebung(` minipc:${minipc.oeffentlich} , offline:${offline.oeffentlich} `);
  ok('zwei, mit Leerzeichen drumherum', zwei.length === 2 && zwei[1].name === 'offline', JSON.stringify(zwei.map(e => e.name)));
  for (const [was, wert] of [['ohne Doppelpunkt', 'nurname'], ['kaputter Schlüssel', 'x:nicht-base64!!']]) {
    try { k.empfaengerAusUmgebung(wert); ok(`${was} → Fehler`, false, 'ging durch'); }
    catch (e) { ok(`${was} → verständlicher Fehler`, /BACKUP_EMPFAENGER/.test(e.message), e.message); }
  }

  console.log('\n── Zwei Sicherungen desselben Inhalts sind verschieden ──');
  const zweiter = await verschluesseln(klartext, empfaenger);
  ok('… weil Schlüssel und IV jedes Mal neu sind', !zweiter.equals(container));
  ok('… beide lassen sich trotzdem öffnen', k.entschluesseln(zweiter, offline.privat).equals(klartext));

  console.log('\n── Grenzfälle der Grösse ──');
  const leer = await verschluesseln(Buffer.alloc(0), empfaenger);
  ok('leere Eingabe: Container entsteht und ergibt wieder nichts',
    k.istContainer(leer) && k.entschluesseln(leer, minipc.privat).length === 0);
  const gross = crypto.randomBytes(3 * 1024 * 1024);
  const grossC = await verschluesseln(gross, empfaenger);
  ok('3 MB gehen durch (mehrere Ströme-Stücke)', k.entschluesseln(grossC, minipc.privat).equals(gross));

  console.log(`\nSicherungs-Container: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
