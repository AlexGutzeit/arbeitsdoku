/**
 * Prueft einen hinterlegten Link, bevor er gespeichert wird.
 *
 * WARUM SERVERSEITIG UND STRENG: Der Link wird spaeter als anklickbarer Knopf angezeigt. Ein
 * `javascript:`-Link wuerde beim Klick Code IM ANMELDE-KONTEXT der App ausfuehren — mit dem
 * Token des Klickenden. Das ist derselbe Fehler wie A1 (XSS) aus der Bugliste v6, nur mit einer
 * freundlicheren Oberflaeche davor. Die Pruefung gehoert deshalb dorthin, wo sie niemand
 * umgehen kann, und nicht ins Formular.
 *
 * `new URL()` ist hier bewusst statt einer selbstgebauten Zeichenpruefung: Wer selbst parst,
 * uebersieht Schreibweisen wie "java\nscript:" oder "JaVaScRiPt:".
 */
function linkPruefen(roh) {
  const s = String(roh == null ? '' : roh).trim();
  if (!s) return { ok: true, wert: null };
  if (s.length > 500) return { ok: false, fehler: 'Der Link ist zu lang (höchstens 500 Zeichen).' };
  // Ohne Schema, aber eindeutig eine Domain: „https://" ergaenzen. So tippt man Adressen, und
  // eine Fehlermeldung dafuer waere reine Schikane. Ein „javascript:" traegt bereits ein Schema
  // und faellt deshalb NICHT in diesen Zweig — es wird unten abgewiesen.
  const mitSchema = /^[a-z][a-z0-9+.-]*:/i.test(s)
    ? s
    : (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s) ? 'https://' + s : s);

  let u;
  try { u = new URL(mitSchema); } catch (_) {
    return { ok: false, fehler: 'Das ist keine vollständige Adresse — bitte mit „https://" beginnen.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, fehler: `Nur „http://" und „https://" sind erlaubt (angegeben war „${u.protocol}").` };
  }
  return { ok: true, wert: u.href };
}
module.exports = { linkPruefen };
