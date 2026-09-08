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
function scannerBesterTreffer(zaehlung) {
  let bester = null, beste = -1;
  for (const [code, d] of zaehlung) {
    const n = typeof d === 'number' ? d : d.n;
    const format = typeof d === 'number' ? '' : d.format;
    if (n < scannerNoetigeLesungen(format)) continue;
    // Ein 2D-Code schlaegt einen 1D-Code auch mit weniger Lesungen: Seine Fehlerkorrektur macht
    // ihn zur verlaesslicheren Angabe, und ein Hersteller-QR ist praeziser als eine EAN, die
    // daneben im Bild liegt.
    const gewicht = n + (scannerNoetigeLesungen(format) === SCANNER_LESUNGEN_2D ? 1000 : 0);
    if (gewicht > beste) { bester = code; beste = gewicht; }
  }
  return bester;
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
          <!-- Zielrahmen: Er sagt ohne Worte, wo der Code hingehört. Ohne ihn hält jeder anders,
               und bei schlechtem Licht entscheidet genau das über Erfolg oder zwölf Sekunden. -->
          <div class="scanner-rahmen"></div>
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
    const gezaehlt = new Map();
    // Nach der ersten Bestaetigung noch kurz weiterlesen, statt sofort zu schliessen. Eine halbe
    // Sekunde kostet nichts und entscheidet den Fall oben richtig.
    const NACHLAUF_MS = 500;
    let nachlauf = null;

    function schliessen(code) {
      laeuft = false;
      if (nachlauf) { clearTimeout(nachlauf); nachlauf = null; }
      if (zxing) { try { zxing.stopContinuousDecode(); } catch (_) {} try { zxing.reset(); } catch (_) {} zxing = null; }
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

    function treffer(code, format) {
      if (!laeuft || !code) return;
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
          const hinweise = new Map();
          hinweise.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
            formate.map(f => ZXing.BarcodeFormat[f.toUpperCase()]).filter(x => x !== undefined));
          zxing = new ZXing.BrowserMultiFormatReader(hinweise);
          zxing.decodeFromVideoElementContinuously(v, (erg) => {
            if (erg) treffer(erg.getText(), ZXing.BarcodeFormat[erg.getBarcodeFormat()] || '');
          });
        } catch (_) { zxing = null; }
      }
      if (!nativ && !zxing) { melde('Kein Decoder verfügbar. Bitte eintippen.'); setTimeout(() => schliessen(null), 3000); return; }

      // Schleife nur fuer den nativen Weg; ZXing bringt seine eigene mit.
      (async function schleife() {
        if (!laeuft || !nativ) return;
        if (v.readyState >= 2) {
          try { const r = await nativ.detect(v); if (r && r.length) treffer(r[0].rawValue, r[0].format); }
          catch (_) { nativ = null; }
        }
        if (laeuft) setTimeout(() => requestAnimationFrame(schleife), 120);
      })();
    })();
  });
}
