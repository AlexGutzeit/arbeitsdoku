// Barcode-Scanner für die Bestellungen.
//
// Alles hier ist im Prüfstand auf echten Geräten gemessen worden, nicht angenommen
// (public/scanner-probe.html, 07.09.2026):
//
//  * ZWEI WEGE. `BarcodeDetector` gibt es nur in Chrome/Android. Im Betrieb sind auch iPhones und
//    Firefox — dort liefert das mitgelieferte Bündel. Gemessen: nativ 6,1 Bilder/s auf Android,
//    Bündel 5,6 Bilder/s auf dem iPhone. Praktisch gleich schnell.
//
//  * MICRO-QR IST AUS. Auf Kies und Pappe erfand der Decoder fünf Codes, die es nicht gibt
//    („8801", „103944", …). QR selbst ist unschuldig — ein echter Produkt-QR wurde sauber
//    gelesen. Also 1D + QR + Data-Matrix, Micro-QR nie.
//
//  * DREI ÜBEREINSTIMMENDE LESUNGEN. Die Prüfziffer allein genügt NICHT: `010812808435` und
//    `5000121411223` hatten gültige Prüfziffern und waren trotzdem falsch — jeweils einmal
//    gelesen, während der echte Nachbar 25- bzw. 36-mal gelesen wurde. Gemessen: echte Codes
//    8–37 Lesungen, Fehllesungen 1–2. Drei trennt sauber und kostet Sekundenbruchteile.
//
//  * HOHE AUFLÖSUNG. Gegen die Erwartung: 480×640 brachte WENIGER Bilder pro Sekunde (4,1 statt
//    6,1) und dreimal so viele Fehllesungen.
//
//  * DAS LICHT ENTSCHEIDET. Gutes Licht 0,5 s, Dämmerung 6 s, Straßenlaterne 12,7 s. Deshalb
//    bleibt die Tastatur gleichwertig — im dunklen Regaleck ist Tippen schneller.
//
//  * TASCHENLAMPE: hängt am MODELL, nicht am Hersteller. Ein iPhone mit iOS 18.7 im Lager gibt sie
//    her, zwei Android-Geräte nicht. Die frühere Annahme „iPhones nie" war falsch.
//
//  * IM LAGER GEMESSEN (08.09.2026): iPhone mit dem Bündel 6,2 Bilder/s und erster Treffer nach
//    0,8 s — schneller als der native Weg auf Android (5,8/s). Der erste Code wurde 114× bestätigt.
//    Gelesen wurden auch ein Code-128-Lageretikett und ein Produkt-QR; die Formatliste stimmt.

const SCANNER_FORMATE_1D = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const SCANNER_FORMATE_2D = ['qr_code', 'data_matrix'];
/**
 * Wie oft ein Code gelesen werden muss, bevor er gilt — nach FORMAT unterschieden.
 *
 * Der Grund ist keine Vorliebe, sondern Bauart:
 *
 *  * EINDIMENSIONALE Codes (EAN, UPC, Code-128, ITF) haben nur eine Prüfziffer. Die ist uns
 *    zweimal bei einer Fehllesung durchgerutscht: `010812808435` und `5000121411223` waren formal
 *    gültig und trotzdem falsch. Dort schützt nur Wiederholung — drei Lesungen.
 *
 *  * ZWEIDIMENSIONALE Codes (QR, Data-Matrix) tragen eine Fehlerkorrektur nach Reed-Solomon. Was
 *    sich überhaupt entziffern lässt, ist praktisch sicher richtig; ein „falsch, aber gültig"
 *    gibt es dort nicht wie bei 1D.
 *
 * Warum das nicht theoretisch ist: Valentins Lauf im Lager (08.09.2026) verwarf zwei ECHTE
 * Hersteller-QRs — `https://id.abb/2CKA006800A3087` (einmal gelesen) und
 * `https://qr.fischer.id/p/568010` (zweimal). ABB und fischer, also genau die Marken eines
 * Elektrobetriebs. Eine Regel, die richtige Daten wegwirft, ist genauso falsch wie eine, die
 * falsche durchlässt.
 */
const SCANNER_LESUNGEN_1D = 3;
const SCANNER_LESUNGEN_2D = 1;
function scannerNoetigeLesungen(format) {
  const f = String(format || '').toLowerCase();
  return (f.includes('qr') || f.includes('matrix') || f.includes('aztec') || f.includes('pdf417'))
    ? SCANNER_LESUNGEN_2D : SCANNER_LESUNGEN_1D;
}

/**
 * Aus mehreren gleichzeitig gelesenen Codes den glaubwürdigsten wählen: den am HÄUFIGSTEN
 * gelesenen, der die Schwelle erreicht hat.
 *
 * Warum das nötig ist — im Lager gemessen (08.09.2026): Auf demselben Karton lagen
 *   043899923098   (UPC-A)  —  3× gelesen
 *   4003899923098  (EAN-13) — 12× gelesen
 * 239 Millisekunden auseinander, beide mit gültiger Prüfziffer, mit zehn gemeinsamen Endziffern.
 * Wer den ERSTEN nimmt, der die Schwelle erreicht, bekommt hier den schwächeren. Der öfter
 * gelesene ist der, den die Kamera wirklich sieht.
 *
 * Als eigene Funktion, damit sie prüfbar ist — die Kamera lässt sich nicht nachstellen, diese
 * Entscheidung schon.
 */
/**
 * Stimmt die Prüfziffer einer GTIN? (EAN-8/UPC-A/EAN-13/GTIN-14)
 *
 * Gebraucht, um eine Artikelnummer aus einem zusammengesetzten Code SICHER zu erkennen. Ohne die
 * Prüfziffer müsste man raten, ob das erste Feld vor dem Komma eine Artikelnummer ist oder
 * irgendeine Hausnummer des Herstellers — und falsch geraten heisst: zwei Artikel auf einem
 * Eintrag.
 */
function scannerGtinGueltig(nummer) {
  const w = String(nummer || '');
  if (!/^\d+$/.test(w) || ![8, 12, 13, 14].includes(w.length)) return false;
  const ziffern = w.split('').map(Number);
  const pruef = ziffern.pop();
  let summe = 0;
  // Von rechts nach links abwechselnd 3 und 1 — unabhaengig von der Laenge, deshalb rueckwaerts.
  for (let i = ziffern.length - 1, f = 3; i >= 0; i--, f = (f === 3 ? 1 : 3)) summe += ziffern[i] * f;
  return ((10 - (summe % 10)) % 10) === pruef;
}

/**
 * Ein Werbe- oder Infocode: eine Internetadresse, die auf eine SEITE zeigt statt auf einen Artikel.
 *
 * Hier stehen sich zwei Feldbefunde gegenüber, und beide haben recht:
 *
 *   Valentin, 08.09.2026 — echte Hersteller-QRs, die ARTIKEL bezeichnen:
 *     https://id.abb/2CKA006800A3087        (2CKA006800A3087 ist die ABB-Artikelnummer)
 *     https://qr.fischer.id/p/568010
 *
 *   Alex im Lager, 09.09.2026 — QRs, die eine SEITE bezeichnen:
 *     https://bauer-solar.de/solarmodule/                              (13× gelesen)
 *     https://www.latrivenetacavi.com/download/environment_label.pdf   (9× gelesen)
 *
 * Der Unterschied steckt im letzten Pfadstück: Eine Artikelnummer enthält Ziffern, ein
 * Seitenname nicht. Das ist eine FAUSTREGEL, keine Norm — deshalb ist sie bewusst vorsichtig
 * gebaut: Im Zweifel gilt eine Adresse als Artikelcode. Ein zu Unrecht abgewiesener Code hält
 * jemanden im Lager auf; ein zu Unrecht gespeicherter macht nur einen Eintrag, den man aufräumen
 * kann.
 *
 * WARUM ES ÜBERHAUPT ZÄHLT: `bauer-solar.de/solarmodule/` klebt auf ALLEN Modulen des
 * Herstellers. Als Barcode gespeichert zeigten zwei verschiedene Artikel auf denselben
 * Katalogeintrag — und der zweite bekäme beim Anlegen „gehört bereits zu …", ohne dass jemand
 * versteht, warum.
 *
 * Ein GS1 Digital Link ist nie ein Werbecode: Aus dem löst scannerCodeNormalisieren die GTIN
 * heraus, und dann steht hier gar keine Adresse mehr.
 */
const SCANNER_DOKUMENT_ENDUNGEN = /\.(pdf|html?|php|aspx?|jpe?g|png)$/i;

function scannerIstWerbecode(code) {
  const w = String(code || '');
  if (!/^https?:\/\//i.test(w)) return false;
  // Erst durch die Normalisierung schicken: Ein GS1 Digital Link IST ein Artikelcode, auch wenn er
  // wie eine Adresse aussieht. So ist die Antwort unabhaengig davon, ob vorher schon normalisiert
  // wurde — sonst haette die Reihenfolge der Aufrufe stillen Einfluss auf das Ergebnis.
  if (scannerCodeNormalisieren(w).artikelnummer) return false;
  let pfad;
  try { pfad = new URL(w).pathname; } catch (_) { return false; }
  const stuecke = pfad.split('/').filter(Boolean);
  const letztes = stuecke.length ? stuecke[stuecke.length - 1] : '';
  if (!letztes) return true;                              // nur eine Startseite
  if (SCANNER_DOKUMENT_ENDUNGEN.test(letztes)) return true;  // ein Merkblatt, kein Artikel
  return !/\d/.test(letztes);                             // ohne eine einzige Ziffer: ein Seitenname
}

/**
 * Welcher Bildausschnitt wird gelesen?
 *
 * Alex (09.09.2026): „Das Scanner Feld einzuschränken wäre auf jeden Fall eine gute Idee. Dann
 * aber bitte auch optisch sichtbar, so dass man sieht wo man hinzielen muss."
 *
 * Der grüne Rahmen war bis dahin reine Dekoration — gelesen wurde das GANZE Bild. Damit gewann
 * jeder Code, der zufällig mit im Bild hing: der QR `4311` wurde in beiden Läufen 16- bzw. 18-mal
 * gelesen und hätte als 2D-Code jeden Strichcode geschlagen. Ein Rahmen, der etwas anderes
 * verspricht als das Programm tut, ist schlimmer als kein Rahmen.
 *
 * Diese Funktion rechnet den sichtbaren Rahmen in Koordinaten des VIDEOBILDES um. Der Umweg ist
 * nötig, weil das Video mit `object-fit: cover` angezeigt wird: Es wird so weit vergrössert, dass
 * die Box gefüllt ist, und links/rechts oder oben/unten fällt etwas weg. Wer einfach die
 * Prozentwerte des Rahmens auf videoWidth/videoHeight anwendet, liest den falschen Bereich —
 * und zwar unbemerkt, weil trotzdem Codes gefunden werden.
 *
 * Alle Werte in derselben Einheit wie die Box (CSS-Pixel); zurück kommen Pixel des Videobildes.
 */
function scannerAusschnittRechteck(videoW, videoH, boxW, boxH, rahmen) {
  if (!videoW || !videoH || !boxW || !boxH) return null;
  const skala = Math.max(boxW / videoW, boxH / videoH);   // object-fit: cover
  const versatzX = (videoW * skala - boxW) / 2;
  const versatzY = (videoH * skala - boxH) / 2;
  const sx = (rahmen.left + versatzX) / skala;
  const sy = (rahmen.top + versatzY) / skala;
  const sw = rahmen.width / skala;
  const sh = rahmen.height / skala;
  // Auf das Videobild begrenzen — ein Rahmen, der über den Rand ragt, darf keinen negativen
  // Ausschnitt erzeugen (drawImage zeichnet dann nichts und der Scanner fände nie etwas).
  const x = Math.max(0, Math.min(videoW - 1, Math.round(sx)));
  const y = Math.max(0, Math.min(videoH - 1, Math.round(sy)));
  return { sx: x, sy: y,
           sw: Math.max(1, Math.min(videoW - x, Math.round(sw))),
           sh: Math.max(1, Math.min(videoH - y, Math.round(sh))) };
}

/** Aus einem Canvas lesen — der Weg, über den beide Decoder denselben Ausschnitt bekommen. */
function scannerAusCanvasLesen(canvas, hinweise) {
  const quelle = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
  const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(quelle));
  const leser = new ZXing.BrowserMultiFormatReader(hinweise);
  return leser.decodeBitmap(bitmap);   // wirft NotFoundException, wenn nichts drin ist
}

/**
 * Eine Charge mit Verfallsdatum — keine Artikelnummer.
 *
 * Im Lager gemessen (Alex, 09.09.2026, 10:54): Ein Data-Matrix enthielt
 *
 *   *202511182 06/17/26
 *    ^^^^^^^^^ ^^^^^^^^
 *    Chargennummer  Verfallsdatum
 *
 * 18-mal gelesen, also grundsolide erkannt — und trotzdem das Falsche. Diese Angabe ist PRO
 * CHARGE verschieden: Bei jeder Lieferung waere es ein neues „unbekanntes Produkt", genau die
 * Katalog-Verschmutzung, gegen die die GS1-Zerlegung gebaut wurde.
 *
 * BEWUSST ENG: Erkannt wird nur ein Datum aus DREI durch Schraegstrich getrennten Zahlengruppen.
 * Alex dazu (09.09.2026): „ohne mir sicher zu sein, würde ich ein / in einer Artikelnummer
 * bezweifeln." „Bezweifeln" ist nicht „ausschliessen" — deshalb faellt NICHT jeder Schraegstrich
 * darunter, und Bindestriche oder Punkte schon gar nicht: `AEH-25-100` ist eine gaengige
 * Artikelnummer. Wer eine echte Nummer mit Datum darin hat, sieht die Meldung und kann es sagen.
 */
const SCANNER_DATUM_MUSTER = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

function scannerIstChargencode(code) {
  return SCANNER_DATUM_MUSTER.test(String(code || ''));
}

/**
 * Soll dieser Code NICHT als Barcode uebernommen werden? Gibt den Grund zurueck oder null.
 *
 * Eine Stelle fuer beide Faelle, damit Rangfolge und Erklaerung nicht auseinanderlaufen koennen:
 * Was hier abgelehnt wird, muss dem Benutzer auch erklaert werden — sonst scannt er und es
 * passiert scheinbar nichts.
 */
function scannerNichtUebernehmen(code) {
  if (scannerIstWerbecode(code)) return 'werbung';
  if (scannerIstChargencode(code)) return 'charge';
  return null;
}

/**
 * Eine zu kurze reine Zahl — das kann keine Artikelnummer sein.
 *
 * Im Lager gemessen (Alex, 09.09.2026, 11:45): Auf EINER Etikette lagen
 *
 *   4311          QR,          57x gelesen   ← niemand weiss, was das ist
 *   801036963840  Data-Matrix, 11x gelesen
 *
 * Beide sind 2D, keiner ist eine gueltige GTIN — also entschied die Trefferzahl, und die
 * unerklaerte `4311` gewann. Sie taucht seit dem ersten Rundgang in jedem Lauf auf; Alex kennt
 * sie nicht („Evtl eine Kennung der Firma für die Großhändler?").
 *
 * Die KUERZESTE Artikelnummer dieser Welt ist eine EAN-8 — und die waere eine gueltige GTIN und
 * damit schon eine Klasse hoeher. Eine reine Zahl mit weniger als acht Stellen, die keine
 * Pruefziffer erfuellt, ist deshalb keine Artikelnummer, sondern eine Haus-, Regal- oder
 * Lieferantenkennung. Sie faellt eine Klasse zurueck und verliert damit gegen jeden Code, der
 * einen Artikel bezeichnet — bleibt aber waehlbar, falls sonst gar nichts da ist.
 */
function scannerIstKurzzahl(code) {
  return /^\d{1,7}$/.test(String(code || '').trim());
}

/**
 * Eine reine Zahl, die KEINE Artikelnummer sein kann.
 *
 * Alex hat die Etikette fotografiert (09.09.2026). Sie loest beide Raetsel auf einmal:
 *
 *   Etiketten ID  801036963840   ← steht im Klartext direkt UNTER dem Data-Matrix
 *   Lieferdatum   07.09.2026        TRANS 801905 · TOUR WZ07 · BOX 8
 *
 * Es ist ein LIEFERSCHEIN-Etikett des Grosshaendlers, kein Produktetikett. Die Artikelnummern
 * stehen nur als TEXT darauf (1010957292 beim Haendler, Schletter 973000-075 beim Hersteller) —
 * die beiden lesbaren Codes bezeichnen das ETIKETT und die Tour, nicht die Ware. Und eine
 * Etiketten-ID ist bei jeder Lieferung eine andere.
 *
 * Regel: Eine rein numerische Angabe ist genau dann eine Artikelnummer, wenn sie die
 * GTIN-Pruefziffer erfuellt. Tut sie das nicht, ist sie eine Haus-, Etiketten- oder Tournummer.
 * Sie verliert damit den 2D-Bonus — ein Data-Matrix ist zwar verlaesslich GELESEN, aber sein
 * INHALT ist deshalb noch keine Artikelnummer.
 *
 * Vorsichtig gefasst: Nur reine Ziffern. Alles mit Buchstaben oder Zeichen (`S78037524`,
 * `A2026052700123`, `wmqr.eu/1422030000`) bleibt unberuehrt — dort ist keine Pruefziffer zu
 * erwarten und die Regel haette keine Grundlage.
 */
function scannerIstNummerOhnePruefziffer(code) {
  const w = String(code || '').trim();
  return /^\d+$/.test(w) && !scannerGtinGueltig(w);
}

function scannerBesterTreffer(zaehlung) {
  // -Infinity, nicht -1: Ein Werbecode traegt ein negatives Gewicht und wuerde sonst gar nicht
  // zurueckgegeben — der Benutzer bekaeme „nichts erkannt", obwohl deutlich etwas gelesen wurde.
  // Zurueckgeben und ERKLAEREN ist besser als verschweigen.
  let bester = null, beste = -Infinity;
  for (const [code, d] of zaehlung) {
    const n = typeof d === 'number' ? d : d.n;
    const format = typeof d === 'number' ? '' : d.format;
    if (n < scannerNoetigeLesungen(format)) continue;
    // Ein 2D-Code schlaegt einen 1D-Code auch mit weniger Lesungen: Seine Fehlerkorrektur macht
    // ihn zur verlaesslicheren Angabe, und ein Hersteller-QR ist praeziser als eine EAN, die
    // daneben im Bild liegt.
    // Ein Werbe- oder Chargencode darf den 2D-Bonus NICHT bekommen — sonst schlaegt die
    // Herstelleradresse (13x gelesen) den Strichcode des Artikels daneben (5x), und man scannt am
    // Ziel vorbei. Er bleibt trotzdem waehlbar, damit unten erklaert werden kann, was gelesen wurde.
    const werbung = !!scannerNichtUebernehmen(code);

    // RANGFOLGE IN KLASSEN, innerhalb der Klasse entscheidet die Trefferzahl:
    //
    //   3  eine inhaltlich gueltige GTIN            — die Artikelnummer nach Norm
    //   2  ein 2D-Code (Fehlerkorrektur)            — verlaesslich gelesen, aber irgendein Inhalt
    //   1  alles Uebrige                            — Haus-, Bestell- oder Chargennummern
    //   0  Werbe-/Infocode                          — nur, wenn sonst gar nichts da ist
    //
    // WARUM GTIN VOR 2D — und warum das eine fruehere Entscheidung umkehrt:
    //
    // Im Lager gemessen (Alex, 09.09.2026, 10:54), beide auf DERSELBEN Etikette:
    //   4003899947209                          EAN-13, 49x gelesen
    //   https://www.eltropa.de/produkt/2811369 QR,     21x gelesen
    // Mit dem alten festen 2D-Bonus gewann die Haendler-Adresse. Sie bezeichnet den Artikel zwar
    // auch, aber die GTIN ist die Nummer, die JEDER kennt — der Hersteller, der zweite Haendler,
    // das naechste System. Die Adresse eines Haendlers ist es nicht.
    //
    // Frueher galt „2D schlaegt 1D immer", weil ein Hersteller-QR praeziser sei als eine EAN, die
    // ZUFAELLIG DANEBEN im Bild liegt (Valentins Lauf). Diese Begruendung ist mit dem Zielrahmen
    // entfallen: Es liegt nichts mehr zufaellig daneben, gelesen wird nur der Rahmen. Bleibt ein
    // QR die einzige Angabe, gewinnt er weiterhin — Klasse 2 schlaegt Klasse 1.
    //
    // Die Schwelle greift VOR dieser Wertung (siehe oben): Ein einmal gelesener Code kommt gar
    // nicht bis hierher, auch keine einmal gelesene GTIN.
    const klasse = werbung ? 0
      : scannerGtinGueltig(code) ? 3
      : (scannerNoetigeLesungen(format) === SCANNER_LESUNGEN_2D
         && !scannerIstNummerOhnePruefziffer(code)) ? 2
      : 1;
    const gewicht = klasse * 1000000 + n;
    if (gewicht > beste) { bester = code; beste = gewicht; }
  }
  return bester;
}

/**
 * Ist der gelesene Wert für sein Format überhaupt plausibel?
 *
 * ITF (Interleaved 2 of 5) ist das einzige Format ohne Prüfziffer-Pflicht — und Scanner lesen
 * darin bereitwillig Teilmuster anderer Codes. Im Feld gemessen (Alex, 08.09.2026, Bücherregal):
 * ZWÖLF ITF-Treffer, alle exakt achtstellig, neun davon mit `00` beginnend — auf Gegenständen,
 * die garantiert kein ITF tragen. Und sie wurden 9- bis 16-mal gelesen.
 *
 * DAS IST DER PUNKT: Gegen eine STABILE Fehllesung hilft Wiederholung nicht. Sie wird genauso oft
 * bestätigt wie ein echter Code. Der einzige wirksame Riegel ist die Norm — auf Umkartons steht
 * ITF-14 mit vierzehn Stellen. Alles andere ist bei uns kein Code, sondern ein Muster.
 *
 * Für EAN und UPC prüft der Decoder die Prüfziffer bereits selbst (belegt: ein Testcode mit
 * falscher Ziffer wurde abgelehnt). Hier wird deshalb nur die Länge nachgehalten.
 */
function scannerPlausibel(code, format) {
  const f = String(format || '').toLowerCase();
  const w = String(code || '');
  if (f.includes('itf')) return /^\d{14}$/.test(w);          // nur ITF-14, der Karton-Standard
  if (f.includes('ean_13') || f === 'ean13') return /^\d{13}$/.test(w);
  if (f.includes('ean_8') || f === 'ean8') return /^\d{8}$/.test(w);
  if (f.includes('upc_a') || f === 'upca') return /^\d{12}$/.test(w);
  if (f.includes('upc_e') || f === 'upce') return /^\d{6,8}$/.test(w);
  // Code-128, Code-39, QR, Data-Matrix: freier Inhalt, aber nicht leer und nicht ein Zeichen.
  // („S" als CODE_39 stand in Alex' Lauf — ein Buchstabe ist kein Artikelcode.)
  return w.trim().length >= 3;
}

/**
 * Aus einem GS1-Code die reine Artikelnummer herauslösen.
 *
 * Im Feld gemessen (Alex, 08.09.2026). Auf einer Packung stand ein Data-Matrix:
 *
 *   010979857524203121SA3AUXMS78F7POQ4CZ7Z
 *   ^^                ^^
 *   01 = GTIN         21 = Seriennummer
 *
 * Nach „01" folgen 14 Stellen GTIN (`09798575242031`), danach „21" und die Seriennummer. Ohne die
 * führende Null ist die GTIN genau der EAN-13 `9798575242031` — derselbe Code, der auf derselben
 * Packung als Strichcode klebt und im selben Lauf gelesen wurde.
 *
 * WARUM DAS ENTSCHEIDEND IST: Die Seriennummer ist PRO STÜCK verschieden. Wer die Rohzeichenkette
 * als Barcode speichert, legt für jede einzelne Packung ein neues „unbekanntes Produkt" an — der
 * Katalog wäre nach einer Woche unbrauchbar. Genau das hätte diese Funktion verhindert, und
 * genau das hätte ich ohne Alex' Feldversuch nicht bemerkt.
 *
 * Gilt für Data-Matrix, QR und GS1-128. Ein gewöhnliches Lageretikett wie `A2026052700123` bleibt
 * unangetastet: Es beginnt nicht mit „01" plus vierzehn Ziffern.
 */
function scannerCodeNormalisieren(code) {
  let w = String(code || '');
  // Manche Decoder stellen eine Symbolkennung voran (]d2 = Data-Matrix, ]C1 = GS1-128).
  w = w.replace(/^\][A-Za-z]\d/, '');
  // Trennzeichen FNC1 (Gruppentrenner) entfernen.
  w = w.replace(/\x1d/g, '');

  let gtin = null;
  const roh = w.match(/^01(\d{14})/);
  // ZUSAMMENGESETZTER CODE mit Trennzeichen. Im Lager gemessen (Alex, 09.09.2026):
  //
  //   4043377228871,22SL22118P0205002,100   (Data-Matrix, 7x gelesen)
  //   4043377228871                         (EAN-13 daneben auf derselben Packung, 8x gelesen)
  //
  //   4043377079275,21010589,50             (Data-Matrix, 3x)
  //   4043377079275                         (Code-128 daneben, 5x)
  //
  // Beide Male steht vorn die Artikelnummer, dahinter Charge und Menge — pro Packung verschieden.
  // Ungeloest waeren das ZWEI Eintraege fuer DENSELBEN Artikel, je nachdem, welches Etikett man
  // erwischt. Genommen wird das erste Feld nur, wenn seine PRUEFZIFFER stimmt; sonst ist es keine
  // GTIN und der Code bleibt, wie er ist.
  const zerlegt = (!roh && /[,;|]/.test(w)) ? w.split(/[,;|]/)[0].trim() : null;
  if (roh) {
    gtin = roh[1];
  } else if (zerlegt && /^\d{13,14}$/.test(zerlegt) && scannerGtinGueltig(zerlegt)) {
    gtin = zerlegt.length === 13 ? '0' + zerlegt : zerlegt;
  } else if (/^https?:\/\//i.test(w)) {
    // GS1 DIGITAL LINK: Die Artikelnummer steckt in einer Internetadresse, entweder als
    // Pfadstück `/01/04311501706954` oder als Abfrage `?01=04311501706954`.
    //
    // Im Feld gemessen (Alex, 08.09.2026): Auf einer Packung stand
    //   https://herkunft.edeka.de/?01=04311501706954   (48× gelesen, QR)
    //   4311501706954                                  (14× gelesen, Strichcode)
    // Ohne diese Zerlegung wären das ZWEI Einträge für DASSELBE Produkt — und wer den QR scannt,
    // fände den Strichcode-Eintrag nicht.
    const imPfad = w.match(/\/01\/(\d{14})(?:[/?#]|$)/);
    const inAbfrage = w.match(/[?&]01=(\d{14})(?:[&#]|$)/);
    if (imPfad) gtin = imPfad[1];
    else if (inAbfrage) gtin = inAbfrage[1];
  }
  if (!gtin) return { code: w, artikelnummer: null };
  // GTIN-14 mit führender Null ist ein EAN-13.
  const nummer = gtin.startsWith('0') ? gtin.slice(1) : gtin;
  return { code: nummer, artikelnummer: nummer, roh: w };
}

let _zxingGeladen = null;

/**
 * Den Decoder erst laden, wenn wirklich gescannt wird.
 *
 * 354 KB gehören nicht in den Start jeder Sitzung — die meisten Bestellungen entstehen weiterhin
 * getippt. Der Service-Worker legt die Datei nach dem ersten Mal ab, danach ist es kostenlos.
 */
function scannerDecoderLaden() {
  if (typeof ZXing !== 'undefined') return Promise.resolve(true);
  if (_zxingGeladen) return _zxingGeladen;
  _zxingGeladen = new Promise((fertig) => {
    const s = document.createElement('script');
    s.src = '/vendor/zxing.min.js';
    s.onload = () => fertig(true);
    s.onerror = () => { _zxingGeladen = null; fertig(false); };
    document.head.appendChild(s);
  });
  return _zxingGeladen;
}

/**
 * Scanner öffnen. Liefert den gelesenen Code oder null (abgebrochen).
 *
 * Bewusst als Versprechen mit EINEM Ergebnis: Der Scanner liest einen Code, bestätigt ihn und
 * schließt sich. Dauerbetrieb wäre für eine Bestellung falsch — man scannt ein Ding, nicht einen
 * Wareneingang.
 */
async function scannerOeffnen() {
  const nativVorhanden = 'BarcodeDetector' in window;
  const bundelDa = await scannerDecoderLaden();
  if (!nativVorhanden && !bundelDa) {
    toast('Der Scanner lässt sich auf diesem Gerät nicht laden. Bitte den Namen eintippen.', 'error', 7000);
    return null;
  }

  return new Promise((fertig) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay scanner-overlay';
    overlay.innerHTML = `
      <div class="scanner-box">
        <div class="scanner-kopf">
          <strong>Barcode scannen</strong>
          <button type="button" class="btn btn-outline btn-sm" data-act="zu">Abbrechen</button>
        </div>
        <div class="scanner-melde" id="sc-status">Kamera wird geöffnet …</div>
        <div class="scanner-bild">
          <video id="sc-video" playsinline muted autoplay></video>
          <!-- Zielrahmen. Seit 09.09.2026 ist er KEINE Dekoration mehr: Genau dieser Bereich wird
               gelesen, alles ausserhalb nicht (scannerAusschnittRechteck). Wer die Geometrie hier
               oder im CSS aendert, aendert damit den gelesenen Bereich mit — das ist Absicht,
               damit Anzeige und Wirkung nicht auseinanderlaufen koennen. -->
          <div class="scanner-rahmen" id="sc-rahmen"><i class="ecke-or"></i><i class="ecke-ul"></i></div>
          <div class="scanner-hinweis">Nur was im Rahmen liegt, wird gelesen</div>
          <canvas id="sc-schnitt" style="display:none"></canvas>
        </div>
        <div id="sc-zoombox" class="scanner-zoom" style="display:none">
          <label for="sc-zoom">Zoom</label>
          <input type="range" id="sc-zoom">
        </div>
        <button type="button" class="btn btn-outline btn-sm" id="sc-licht" style="display:none">
          Licht an</button>
      </div>`;
    document.body.appendChild(overlay);
    const aufraeumen = typeof dialogBarrierefrei === 'function' ? dialogBarrierefrei(overlay) : () => {};

    const $s = (id) => overlay.querySelector('#' + id);
    const melde = (t) => { $s('sc-status').textContent = t; };

    let strom = null, laeuft = true, nativ = null, zxing = null, spur = null, licht = false;
    let zxingHinweise = null;   // Formatliste fuer den mitgelieferten Decoder
    const gezaehlt = new Map();
    // Nach der ersten Bestaetigung noch kurz weiterlesen, statt sofort zu schliessen. Eine halbe
    // Sekunde kostet nichts und entscheidet den Fall oben richtig.
    const NACHLAUF_MS = 500;
    let nachlauf = null;
    let gs1Gemeldet = false;

    function schliessen(code) {
      laeuft = false;
      if (nachlauf) { clearTimeout(nachlauf); nachlauf = null; }
      // ZXing braucht kein Anhalten mehr: Seit dem Ausschnitt-Umbau laeuft KEINE fremde
      // Dauerschleife mehr, sondern nur die eigene — und die endet mit `laeuft = false`.
      zxing = null;
      nativ = null;
      if (strom) { strom.getTracks().forEach(t => t.stop()); strom = null; }
      document.removeEventListener('keydown', beiTaste);
      overlay.remove(); aufraeumen();
      fertig(code || null);
    }
    const beiTaste = (e) => { if (e.key === 'Escape') schliessen(null); };
    document.addEventListener('keydown', beiTaste);
    overlay.querySelector('[data-act="zu"]').addEventListener('click', () => schliessen(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) schliessen(null); });

    function treffer(rohCode, format) {
      if (!laeuft || !rohCode) return;
      // Erst die Artikelnummer herauslösen, DANN prüfen und zählen. Sonst zählte jede Packung
      // ihre eigene Seriennummer als eigenen Code.
      const norm = scannerCodeNormalisieren(rohCode);
      const code = norm.code;
      if (norm.artikelnummer && !gs1Gemeldet) {
        gs1Gemeldet = true;
        melde('Artikelnummer aus dem Code gelesen: ' + norm.artikelnummer);
      }
      if (!scannerPlausibel(code, norm.artikelnummer ? 'ean_13' : format)) return;
      const vorher = gezaehlt.get(code);
      const n = (vorher ? vorher.n : 0) + 1;
      gezaehlt.set(code, { n, format: format || (vorher && vorher.format) || '' });
      const noetig = scannerNoetigeLesungen(format);
      if (n < noetig) {
        if (!nachlauf) melde(`Gelesen (${n} von ${noetig}) — bitte ruhig halten …`);
        return;
      }
      if (nachlauf) return;   // laeuft schon
      if (navigator.vibrate) navigator.vibrate(80);
      melde('Erkannt — einen Moment …');
      nachlauf = setTimeout(() => {
        const bester = scannerBesterTreffer(gezaehlt) || code;
        melde('Gelesen: ' + bester);
        schliessen(bester);
      }, NACHLAUF_MS);
    }

    (async () => {
      try {
        strom = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' },
                   width: { ideal: 1920 }, height: { ideal: 1080 },
                   focusMode: { ideal: 'continuous' } },
          audio: false,
        });
      } catch (e) {
        melde('Die Kamera ließ sich nicht öffnen: ' + (e && e.message || e));
        setTimeout(() => schliessen(null), 3500);
        return;
      }
      if (!laeuft) { strom.getTracks().forEach(t => t.stop()); return; }
      const v = $s('sc-video');
      v.srcObject = strom;
      await v.play().catch(() => {});
      spur = strom.getVideoTracks()[0];
      melde('Barcode in den Rahmen halten.');

      const koennen = spur.getCapabilities ? spur.getCapabilities() : {};
      if (koennen.torch) {
        const k = $s('sc-licht'); k.style.display = '';
        k.addEventListener('click', async () => {
          licht = !licht;
          try { await spur.applyConstraints({ advanced: [{ torch: licht }] }); k.textContent = licht ? 'Licht aus' : 'Licht an'; }
          catch (_) { k.style.display = 'none'; }
        });
      }
      // Zoom ist auf vielen Geraeten das EINZIGE Werkzeug gegen schlechtes Licht — die
      // Taschenlampe gibt Safari nie her und viele Android-Geraete auch nicht.
      if (koennen.zoom) {
        const z = $s('sc-zoom');
        z.min = koennen.zoom.min; z.max = koennen.zoom.max;
        z.step = koennen.zoom.step || 0.1; z.value = koennen.zoom.min;
        $s('sc-zoombox').style.display = '';
        z.addEventListener('input', async () => {
          if (!spur || spur.readyState !== 'live') return;
          try { await spur.applyConstraints({ advanced: [{ zoom: +z.value }] }); } catch (_) {}
        });
      }

      const formate = SCANNER_FORMATE_1D.concat(SCANNER_FORMATE_2D);
      if (nativVorhanden) {
        try { nativ = new BarcodeDetector({ formats: formate }); } catch (_) { nativ = null; }
      }
      if (!nativ && typeof ZXing !== 'undefined') {
        try {
          zxingHinweise = new Map();
          zxingHinweise.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
            formate.map(f => ZXing.BarcodeFormat[f.toUpperCase()]).filter(x => x !== undefined));
          zxing = true;
        } catch (_) { zxing = null; }
      }
      if (!nativ && !zxing) { melde('Kein Decoder verfügbar. Bitte eintippen.'); setTimeout(() => schliessen(null), 3000); return; }

      // EINE Schleife fuer beide Decoder, beide auf DEMSELBEN Ausschnitt.
      //
      // Frueher brachte ZXing seine eigene Dauerschleife mit (decodeFromVideoElementContinuously).
      // Die las das ganze Bild — und sie liess sich schlecht anhalten; ueberlebende Schleifen
      // waren schon einmal die Ursache dafuer, dass nach dem Stoppen weitergezaehlt wurde.
      // Eine eigene Schleife loest beides auf einmal.
      const schnitt = document.getElementById('sc-schnitt');
      const rahmenEl = document.getElementById('sc-rahmen');
      (async function schleife() {
        if (!laeuft) return;
        if (v.readyState >= 2) {
          const vr = v.getBoundingClientRect(), rr = rahmenEl.getBoundingClientRect();
          const aus = scannerAusschnittRechteck(v.videoWidth, v.videoHeight, vr.width, vr.height,
            { left: rr.left - vr.left, top: rr.top - vr.top, width: rr.width, height: rr.height });
          if (aus) {
            if (schnitt.width !== aus.sw || schnitt.height !== aus.sh) { schnitt.width = aus.sw; schnitt.height = aus.sh; }
            schnitt.getContext('2d').drawImage(v, aus.sx, aus.sy, aus.sw, aus.sh, 0, 0, aus.sw, aus.sh);
            if (nativ) {
              try { const r = await nativ.detect(schnitt); if (r && r.length) treffer(r[0].rawValue, r[0].format); }
              catch (_) { nativ = null; }          // faellt auf ZXing zurueck
            }
            if (!nativ && zxing) {
              // NotFoundException ist der Normalfall (kein Code im Ausschnitt) und darf nichts tun.
              try {
                const erg = scannerAusCanvasLesen(schnitt, zxingHinweise);
                if (erg) treffer(erg.getText(), ZXing.BarcodeFormat[erg.getBarcodeFormat()] || '');
              } catch (_) {}
            }
          }
        }
        if (laeuft) setTimeout(() => requestAnimationFrame(schleife), 120);
      })();
    })();
  });
}
