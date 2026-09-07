// Prüfstand für den Barcode-Scanner — beantwortet VOR dem Bau die Fragen, an denen alles hängt:
// Öffnet sich die Kamera auf dem iPhone (auch in der installierten PWA)? Liest der mitgelieferte
// Decoder zuverlässig? Wie lange dauert der erste Treffer bei Lagerlicht?
//
// EIGENE DATEI, nicht eingebettet: Die Sicherheitsregel der App ist `script-src 'self'` ohne
// `unsafe-inline` — ein <script>-Block im HTML würde vom Browser abgewiesen. Genau deshalb läuft
// dieser Prüfstand unter denselben Bedingungen wie die App selbst; ein Test unter anderen
// Bedingungen wäre wertlos.

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const zeile = (k, v, kl) => `<tr><td>${k}</td><td class="${kl || ''}">${v}</td></tr>`;
  const jaNein = (b) => b ? '<span class="ja">ja</span>' : '<span class="nein">nein</span>';

  const hatNativ = 'BarcodeDetector' in window;
  const hatKamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const zxingDa = typeof ZXing !== 'undefined';
  const installiert = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;

  $('fakten').innerHTML =
      zeile('Browser', navigator.userAgent.replace(/</g, '&lt;'))
    + zeile('als App installiert', jaNein(installiert))
    + zeile('sichere Verbindung', jaNein(window.isSecureContext))
    + zeile('Kamera-Schnittstelle', jaNein(hatKamera))
    + zeile('BarcodeDetector (nativ)', jaNein(hatNativ))
    + zeile('mitgelieferter Decoder', jaNein(zxingDa) + (zxingDa ? ' (354 KB)' : ''));

  let strom = null, laeuft = false, nativDetector = null, zxingLeser = null;
  let versuche = 0, ersterTrefferMs = null, beginn = 0;
  const gesehen = new Map();

  function melde(t) { $('status').textContent = t; }

  function treffer(text, format, weg, ms) {
    if (ersterTrefferMs === null) ersterTrefferMs = ms;
    const s = gesehen.get(text) || { n: 0, format, weg };
    s.n++; gesehen.set(text, s);
    const ul = $('treffer');
    if (ul.dataset.leer !== '0') { ul.innerHTML = ''; ul.dataset.leer = '0'; }
    ul.insertAdjacentHTML('afterbegin',
      `<li><code>${String(text).replace(/</g, '&lt;')}</code> — ${format}, ${weg}, nach ${Math.round(ms)} ms</li>`);
    $('bilanz').textContent =
      `${gesehen.size} verschiedene Codes · ${versuche} Bildversuche · erster Treffer nach ${Math.round(ersterTrefferMs)} ms`;
    if (navigator.vibrate) navigator.vibrate(60);
  }

  async function start() {
    if (laeuft) return;
    versuche = 0; ersterTrefferMs = null; beginn = performance.now();
    try {
      melde('Kamera wird angefragt …');
      strom = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      melde('Kamera abgelehnt oder nicht verfügbar: ' + e.name + ' — ' + e.message);
      return;
    }
    $('video').srcObject = strom;
    await $('video').play().catch(() => {});
    laeuft = true;
    const spur = strom.getVideoTracks()[0];
    const f = spur.getSettings ? spur.getSettings() : {};
    melde(`Kamera läuft (${f.width || '?'}×${f.height || '?'}). Barcode ins Bild halten.`);

    if (hatNativ) {
      try { nativDetector = new BarcodeDetector(); } catch (_) { nativDetector = null; }
    }
    if (zxingDa) {
      try {
        zxingLeser = new ZXing.BrowserMultiFormatReader();
        // ZXing bringt seine EIGENE Dauerschleife mit. Eine Methode `decodeFromCanvas` gibt es in
        // dieser Fassung NICHT — mein erster Entwurf rief sie auf und hätte auf dem Gerät gar
        // nichts gelesen. Gefunden, weil ich die Schnittstelle des Bündels abgefragt habe,
        // statt sie aus dem Gedächtnis zu schreiben.
        zxingLeser.decodeFromVideoElementContinuously($('video'), (ergebnis) => {
          if (ergebnis) {
            treffer(ergebnis.getText(),
              ZXing.BarcodeFormat[ergebnis.getBarcodeFormat()] || '?',
              'mitgeliefert', performance.now() - beginn);
          }
        });
      } catch (e) { zxingLeser = null; melde('Decoder ließ sich nicht starten: ' + e.message); }
    }
    if (hatNativ) schleife();
  }

  // Nur fuer den NATIVEN Weg: BarcodeDetector bekommt das Video-Element direkt.
  async function schleife() {
    if (!laeuft || !nativDetector) return;
    const v = $('video');
    if (v.readyState >= 2) {
      versuche++;
      try {
        const r = await nativDetector.detect(v);
        if (r && r.length) treffer(r[0].rawValue, r[0].format, 'nativ', performance.now() - beginn);
      } catch (_) { nativDetector = null; }
    }
    setTimeout(() => requestAnimationFrame(schleife), 120);
  }

  function stop() {
    laeuft = false;
    if (zxingLeser) { try { zxingLeser.reset(); } catch (_) {} zxingLeser = null; }
    if (strom) { strom.getTracks().forEach(t => t.stop()); strom = null; }
    $('video').srcObject = null;
    melde('Gestoppt.');
  }

  let licht = false;
  async function lichtSchalten() {
    if (!strom) return melde('Erst starten.');
    const spur = strom.getVideoTracks()[0];
    const f = spur.getCapabilities ? spur.getCapabilities() : {};
    if (!f.torch) return melde('Dieses Gerät bietet kein schaltbares Licht im Browser.');
    licht = !licht;
    try { await spur.applyConstraints({ advanced: [{ torch: licht }] }); melde('Licht ' + (licht ? 'an' : 'aus')); }
    catch (e) { melde('Licht ließ sich nicht schalten: ' + e.message); }
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('licht').addEventListener('click', lichtSchalten);
  $('treffer').dataset.leer = '1';
})();
