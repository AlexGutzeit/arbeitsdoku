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

  function melde(t, art) {
    const el = $('status');
    el.textContent = t;
    el.className = 'melde' + (art ? ' ' + art : '');
  }

  // EIN Eintrag je Code, nicht je Bild.
  //
  // Vorher wurde jedes gelesene Bild angehaengt — derselbe Barcode stand dann zwanzigmal da, und
  // die einzige Zahl, auf die es ankommt (Zeit bis zum ERSTEN Treffer), war unauffindbar.
  // Ausserdem wird der echte Scanner genau EINMAL lesen und dann aufhoeren; das laesst sich hier
  // mit dem Haken ausprobieren.
  function treffer(text, format, weg, ms) {
    const neu = !gesehen.has(text);
    if (ersterTrefferMs === null) ersterTrefferMs = ms;
    const e = gesehen.get(text) || { n: 0, format, weg, ersteMs: ms };
    e.n++; gesehen.set(text, e);

    const ul = $('treffer');
    if (ul.dataset.leer !== '0') { ul.innerHTML = ''; ul.dataset.leer = '0'; }
    ul.innerHTML = [...gesehen.entries()].map(([code, d]) =>
      `<li><code>${String(code).replace(/</g, '&lt;')}</code> — ${d.format}, ${d.weg}`
      + `<br><span style="color:var(--grau);font-size:.85em">erstmals nach ${Math.round(d.ersteMs)} ms`
      + (d.n > 1 ? ` · seither ${d.n}× bestätigt` : '') + '</span></li>').join('');

    $('bilanz').className = 'bilanz gut';
    $('bilanz').textContent =
      `Erster Treffer nach ${(ersterTrefferMs / 1000).toFixed(1)} Sekunden`
      + ` · ${gesehen.size} ${gesehen.size === 1 ? 'Code' : 'Codes'}`
      + ` · ${versuche} Bilder geprüft`;

    if (neu && navigator.vibrate) navigator.vibrate(60);
    // So wird der echte Scanner arbeiten: einmal lesen, dann aufhoeren und das Feld fuellen.
    if (neu && $('einmal') && $('einmal').checked) {
      stop();
      melde(`Gelesen: ${text} — nach ${(ms / 1000).toFixed(1)} Sekunden. Scanner gestoppt.`, 'gut');
    }
  }

  async function start() {
    if (laeuft) return;
    versuche = 0; ersterTrefferMs = null; beginn = performance.now();
    gesehen.clear();
    $('treffer').dataset.leer = '1'; $('treffer').innerHTML = '<li>noch keiner</li>';
    $('bilanz').className = 'bilanz'; $('bilanz').textContent = 'Noch nichts gelesen.';
    try {
      melde('Kamera wird angefragt …');
      // Höhere Auflösung ANFRAGEN, nicht erzwingen: Ein Barcode liegt quer, ein breiteres Bild
      // trifft ihn besser. Alex' Gerät lieferte auf 1280×720 hin ein hochkantes 720×1280 —
      // das Handy dreht, wie es mag. `ideal` lässt ihm die Wahl, statt die Kamera abzuweisen.
      strom = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 }, height: { ideal: 1080 },
          // Autofokus dauerhaft — bei Barcodes im Regal der wichtigste Einzelwert.
          focusMode: { ideal: 'continuous' },
        },
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
    melde(`Kamera läuft (${f.width || '?'}×${f.height || '?'}). Barcode ins Bild halten.`, 'gut');

    // Taschenlampe: erst JETZT lässt sich sagen, ob das Gerät sie über den Browser hergibt —
    // `getCapabilities()` liefert erst an einer laufenden Spur etwas. Der Knopf war vorher
    // immer anklickbar und die Absage verschwand in einer Zeile unter dem Videobild.
    const koennen = spur.getCapabilities ? spur.getCapabilities() : {};
    const hatLicht = !!koennen.torch;
    $('licht').disabled = !hatLicht;
    $('lichtinfo').textContent = hatLicht
      ? 'Die LED neben der Kamera — für dunkle Regale. Dieses Gerät kann sie schalten.'
      : 'Die LED neben der Kamera. DIESES GERÄT GIBT SIE ÜBER DEN BROWSER NICHT HER — '
        + 'bei iPhones ist das immer so, bei Android je nach Modell und Browser. '
        + 'Im Lager hilft dann nur das Licht im Raum oder die Taschenlampe im Handy-Menü.';
    $('fakten').insertAdjacentHTML('beforeend',
        zeile('Kamera-Auflösung', (f.width || '?') + '×' + (f.height || '?')
              + ((f.width && f.height && f.height > f.width) ? ' (hochkant)' : ''))
      + zeile('Taschenlampe schaltbar', jaNein(hatLicht))
      + zeile('Zoom steuerbar', jaNein(!!koennen.zoom))
      + zeile('Autofokus', (f.focusMode || koennen.focusMode && koennen.focusMode.join('/') || 'nicht auslesbar')));

    // Zoom ist auf Alex' Android verfügbar, die Taschenlampe nicht. Bei wenig Licht ist Zoom oft
    // der bessere Hebel — deshalb hier ausprobierbar machen statt nur anzeigen.
    if (koennen.zoom) {
      const z = $('zoom');
      z.min = koennen.zoom.min; z.max = koennen.zoom.max;
      z.step = koennen.zoom.step || 0.1; z.value = f.zoom || koennen.zoom.min;
      $('zoomwert').textContent = `(${(+z.value).toFixed(1)}× von ${koennen.zoom.min}–${koennen.zoom.max}×)`;
      $('zoombox').style.display = '';
      z.addEventListener('input', async () => {
        $('zoomwert').textContent = `(${(+z.value).toFixed(1)}× von ${koennen.zoom.min}–${koennen.zoom.max}×)`;
        try { await spur.applyConstraints({ advanced: [{ zoom: +z.value }] }); }
        catch (e) { melde('Zoom ließ sich nicht setzen: ' + e.message, 'schlecht'); }
      });
    }

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
    licht = false;
    $('zoombox').style.display = 'none';
    $('licht').disabled = true;
    $('licht').classList.remove('an');
    $('licht').textContent = 'Taschenlampe der Kamera';
    melde('Gestoppt.');
  }

  let licht = false;
  async function lichtSchalten() {
    if (!strom) return melde('Erst „Scanner starten" antippen.', 'schlecht');
    const spur = strom.getVideoTracks()[0];
    const koennen = spur.getCapabilities ? spur.getCapabilities() : {};
    if (!koennen.torch) {
      return melde('Dieses Gerät gibt die Taschenlampe über den Browser nicht her.', 'schlecht');
    }
    licht = !licht;
    try {
      await spur.applyConstraints({ advanced: [{ torch: licht }] });
      $('licht').classList.toggle('an', licht);
      $('licht').textContent = licht ? 'Taschenlampe AN — antippen zum Ausschalten' : 'Taschenlampe der Kamera';
      melde('Taschenlampe ' + (licht ? 'eingeschaltet' : 'ausgeschaltet') + '.', licht ? 'gut' : null);
    } catch (e) {
      licht = false;
      melde('Die Taschenlampe ließ sich nicht schalten: ' + e.message, 'schlecht');
    }
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('licht').addEventListener('click', lichtSchalten);
  $('treffer').dataset.leer = '1';
})();
