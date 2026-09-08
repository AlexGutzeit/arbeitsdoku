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

const SCANNER_FORMATE_1D = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const SCANNER_FORMATE_2D = ['qr_code', 'data_matrix'];
const SCANNER_NOETIGE_LESUNGEN = 3;

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

    function schliessen(code) {
      laeuft = false;
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

    function treffer(code) {
      if (!laeuft || !code) return;
      const n = (gezaehlt.get(code) || 0) + 1;
      gezaehlt.set(code, n);
      if (n < SCANNER_NOETIGE_LESUNGEN) {
        melde(`Gelesen (${n} von ${SCANNER_NOETIGE_LESUNGEN}) — bitte ruhig halten …`);
        return;
      }
      if (navigator.vibrate) navigator.vibrate(80);
      melde('Gelesen: ' + code);
      schliessen(code);
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
          zxing.decodeFromVideoElementContinuously(v, (erg) => { if (erg) treffer(erg.getText()); });
        } catch (_) { zxing = null; }
      }
      if (!nativ && !zxing) { melde('Kein Decoder verfügbar. Bitte eintippen.'); setTimeout(() => schliessen(null), 3000); return; }

      // Schleife nur fuer den nativen Weg; ZXing bringt seine eigene mit.
      (async function schleife() {
        if (!laeuft || !nativ) return;
        if (v.readyState >= 2) {
          try { const r = await nativ.detect(v); if (r && r.length) treffer(r[0].rawValue); }
          catch (_) { nativ = null; }
        }
        if (laeuft) setTimeout(() => requestAnimationFrame(schleife), 120);
      })();
    })();
  });
}
