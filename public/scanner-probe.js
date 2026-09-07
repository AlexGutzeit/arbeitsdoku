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

  // WONACH gesucht wird — der wichtigste Regler gegen Fehllesungen.
  //
  // Alex' Versuch im Freien las fuenf MICRO_QR_CODE aus Kies, Schuhen und einer Pappkiste:
  // „8801", „103944", „71715", „596352" und einen leeren. Die drei EAN-13 daneben hatten
  // gueltige Pruefziffern, waren also echt. 2D-Codes haben keine vergleichbare Absicherung —
  // der Decoder reimt sie sich aus Rauschen zusammen. Im Lager hiesse das: erfundener Code am
  // falschen Produkt.
  //
  // Warenetiketten sind EAN/UPC, Lageretiketten meist Code-128 oder Code-39, Kartons ITF.
  // Mehr braucht es nicht.
  const FORMATE_1D = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  // QR ist NICHT das Problem: Alex' Versuch las einen echten Produkt-QR
  // (https://www.eltropa.de/Produkt/2810834) — den pauschal abzuschalten waere falsch.
  // Das Rauschen kam ausschliesslich von MICRO_QR_CODE, und der laesst sich einzeln weglassen.
  const FORMATE_2D = ['qr_code', 'data_matrix'];

  // WIEVIELE LESUNGEN, BEVOR EIN CODE GILT.
  //
  // Die Pruefziffer allein genuegt nicht. In Alex' Lauf stand neben dem echten
  // EAN-13 4050821808435 (25x gelesen) ein UPC_A 010812808435 — mit FORMAL GUELTIGER
  // Pruefziffer, aber genau EINMAL gelesen und eine lange Ziffernfolge mit dem echten Code
  // teilend. Eine Fehllesung, die die Pruefziffer bestanden hat.
  //
  // Ein echter Barcode wird bei jedem Bild wieder gelesen, eine Fehllesung nicht. Zwei
  // uebereinstimmende Lesungen kosten Bruchteile einer Sekunde und schliessen genau diesen
  // Fall aus.
  // Im Feld gemessen (Alex, 07.09.2026, drei Laeufe an einer Strassenlaterne):
  //   echte Codes:   8, 14, 14, 15, 17, 18, 19, 23, 24, 25, 26, 36, 37 Lesungen
  //   Fehllesungen:  1, 1, 1, 1, 2, 2 Lesungen
  // Zwei genuegten NICHT: 4046281411216, 5056891027874 und 5056891027843 kamen mit je zwei
  // Lesungen durch — alle mit gueltiger Pruefziffer, alle nur in den vorderen Ziffern verfaelscht
  // (bei EAN-13 steckt die erste Ziffer in der Paritaet der linken Haelfte, dem anfaelligsten
  // Teil). Drei trennt in diesen Daten sauber, und echte Codes erreichen drei in Bruchteilen
  // einer Sekunde.
  const NOETIGE_LESUNGEN = () => Number(($('lesungen') || {}).value || 3);

  let strom = null, laeuft = false, nativDetector = null, zxingLeser = null;
  let aktuelleSpur = null;
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
    // Letzter Riegel: Meldet eine ueberlebende Schleife trotzdem noch, wird sie ignoriert.
    // Drei Riegel statt einem, weil der Fehler genau daran lag, dass EINER nicht gehalten hat.
    if (!laeuft) return;
    const neu = !gesehen.has(text);
    if (ersterTrefferMs === null) ersterTrefferMs = ms;
    const e = gesehen.get(text) || { n: 0, format, weg, ersteMs: ms };
    e.n++; gesehen.set(text, e);
    const noetig = NOETIGE_LESUNGEN();
    const geradeBestaetigt = e.n === noetig;

    const ul = $('treffer');
    if (ul.dataset.leer !== '0') { ul.innerHTML = ''; ul.dataset.leer = '0'; }
    ul.innerHTML = [...gesehen.entries()].map(([code, d]) => {
      const sicher = d.n >= noetig;
      return `<li style="${sicher ? '' : 'opacity:.55'}">`
        + `<code>${String(code).replace(/</g, '&lt;')}</code> — ${d.format}, ${d.weg}`
        + `<br><span style="color:var(--grau);font-size:.85em">erstmals nach ${Math.round(d.ersteMs)} ms · `
        + (sicher ? `${d.n}× gelesen — bestätigt`
                  : `nur ${d.n}× gelesen (nötig: ${noetig}) — vermutlich Fehllesung, wird nicht übernommen`)
        + '</span></li>';
    }).join('');

    const bestaetigte = [...gesehen.values()].filter(d => d.n >= noetig).length;
    const einzelne = gesehen.size - bestaetigte;
    $('bilanz').className = 'bilanz' + (bestaetigte ? ' gut' : '');
    $('bilanz').textContent =
      `Erster Treffer nach ${(ersterTrefferMs / 1000).toFixed(1)} Sekunden`
      + ` · ${bestaetigte} bestätigt`
      + (einzelne ? ` · ${einzelne} verworfen (zu selten gelesen)` : '')
      + ` · ${versuche} Bilder geprüft`
      + (versuche > 5 ? ` (${(versuche / ((performance.now() - beginn) / 1000)).toFixed(1)}/s)` : '');

    if (geradeBestaetigt && navigator.vibrate) navigator.vibrate(60);
    // So wird der echte Scanner arbeiten: lesen, BESTAETIGEN lassen, dann aufhoeren und das Feld
    // fuellen. Erst die zweite uebereinstimmende Lesung zaehlt.
    if (geradeBestaetigt && $('einmal') && $('einmal').checked) {
      stop();
      melde(`Gelesen und bestätigt: ${text} — nach ${(ms / 1000).toFixed(1)} Sekunden. Scanner gestoppt.`, 'gut');
    }
  }

  async function start() {
    // IMMER erst aufraeumen. Ohne das legte jeder Start einen weiteren Decoder an, waehrend der
    // alte weiterlief — die Schleifen summierten sich und meldeten Treffer, obwohl "gestoppt"
    // dastand. Genau das hat Alex gesehen: 33 Bestaetigungen bei angehaktem "einmal stoppen".
    stop();
    await new Promise(r => setTimeout(r, 150));
    versuche = 0; ersterTrefferMs = null; beginn = performance.now();
    gesehen.clear();
    $('treffer').dataset.leer = '1'; $('treffer').innerHTML = '<li>noch keiner</li>';
    $('bilanz').className = 'bilanz'; $('bilanz').textContent = 'Noch nichts gelesen.';
    try {
      melde('Kamera wird angefragt …');
      const [wunschBreite, wunschHoehe] =
        ($('aufloesung') ? $('aufloesung').value : '1920x1080').split('x').map(Number);
      // Höhere Auflösung ANFRAGEN, nicht erzwingen: Ein Barcode liegt quer, ein breiteres Bild
      // trifft ihn besser. Alex' Gerät lieferte auf 1280×720 hin ein hochkantes 720×1280 —
      // das Handy dreht, wie es mag. `ideal` lässt ihm die Wahl, statt die Kamera abzuweisen.
      strom = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: wunschBreite }, height: { ideal: wunschHoehe },
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
    aktuelleSpur = spur;
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
    // ERSETZEN, nicht anhaengen: Bei jedem Start kamen sonst vier weitere Zeilen dazu — nach
    // sechs Versuchen stand die Tabelle sechsmal da. Von Alex im Betrieb gefunden.
    const alt = $('fakten').querySelector('#kamerafakten');
    if (alt) alt.remove();
    $('fakten').insertAdjacentHTML('beforeend',
      '<tbody id="kamerafakten">'
      + zeile('Kamera-Auflösung', (f.width || '?') + '×' + (f.height || '?')
              + ((f.width && f.height && f.height > f.width) ? ' (hochkant)' : ''))
      + zeile('Taschenlampe schaltbar', jaNein(hatLicht))
      + zeile('Zoom steuerbar', jaNein(!!koennen.zoom))
      + zeile('Autofokus', (f.focusMode || koennen.focusMode && koennen.focusMode.join('/') || 'nicht auslesbar'))
      + '</tbody>');

    // Kurzfassung in der Ergebniskarte — damit EIN Screenshot davon alles enthaelt.
    $('steckbrief').innerHTML =
      `<strong>${installiert ? 'installierte App' : 'im Browser'}</strong>`
      + ` · ${hatNativ ? 'nativer Scanner' : 'mitgelieferter Decoder'}`
      + ` · ${f.width || '?'}×${f.height || '?'}`
      + ` · Licht ${hatLicht ? 'schaltbar' : 'nicht schaltbar'}`
      + ` · ${(navigator.userAgent.match(/iPhone|iPad|Android|Firefox|Chrome/) || ['?'])[0]}`;

    // Zoom ist auf Alex' Android verfügbar, die Taschenlampe nicht. Bei wenig Licht ist Zoom oft
    // der bessere Hebel — deshalb hier ausprobierbar machen statt nur anzeigen.
    if (koennen.zoom) {
      const z = $('zoom');
      z.min = koennen.zoom.min; z.max = koennen.zoom.max;
      z.step = koennen.zoom.step || 0.1; z.value = f.zoom || koennen.zoom.min;
      $('zoomwert').textContent = `(${(+z.value).toFixed(1)}× von ${koennen.zoom.min}–${koennen.zoom.max}×)`;
      $('zoombox').style.display = '';
      // Der Zuhoerer haengt EINMAL am Regler (siehe unten) und schlaegt die AKTUELLE Spur nach.
      // Vorher wurde bei jedem Start ein weiterer angehaengt; die alten hielten tote Spuren fest
      // und meldeten „The associated Track is in an invalid state", waehrend der neueste den Zoom
      // tatsaechlich setzte. Alex sah also die Fehlermeldung einer Leiche. Gefunden von ihm.
    }

    const mit2d = $('zweid') && $('zweid').checked;
    const formate = mit2d ? FORMATE_1D.concat(FORMATE_2D) : FORMATE_1D;
    if (hatNativ) {
      try { nativDetector = new BarcodeDetector({ formats: formate }); }
      catch (_) { try { nativDetector = new BarcodeDetector(); } catch (_) { nativDetector = null; } }
    }
    if (zxingDa) {
      try {
        const hinweise = new Map();
        hinweise.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
          formate.map(f => ZXing.BarcodeFormat[f.toUpperCase()]).filter(v => v !== undefined));
        zxingLeser = new ZXing.BrowserMultiFormatReader(hinweise);
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
    schleife();   // zaehlt Bilder in jedem Fall, entschluesselt nur mit nativem Detektor
  }

  // Nur fuer den NATIVEN Weg: BarcodeDetector bekommt das Video-Element direkt.
  // Laeuft NUR das Buendel (iPhone), zaehlt diese Schleife trotzdem die Bilder mit — sonst
  // stuende dort „0 Bilder geprueft" und der Vergleich zwischen Aufloesungen waere blind.
  async function schleife() {
    if (!laeuft) return;
    if (!nativDetector) {
      if ($('video').readyState >= 2) versuche++;
      return setTimeout(() => requestAnimationFrame(schleife), 120);
    }
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
    nativDetector = null;
    if (zxingLeser) {
      // BEIDES: stopContinuousDecode beendet die Schleife, reset gibt die Kameraspur frei.
      // reset() allein liess die Schleife in dieser Fassung weiterlaufen.
      try { zxingLeser.stopContinuousDecode(); } catch (_) {}
      try { zxingLeser.reset(); } catch (_) {}
      zxingLeser = null;
    }
    if (strom) { strom.getTracks().forEach(t => t.stop()); strom = null; }
    aktuelleSpur = null;
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

  // EINMAL anhaengen, nicht bei jedem Start.
  $('zoom').addEventListener('input', async () => {
    const z = $('zoom');
    $('zoomwert').textContent = `(${(+z.value).toFixed(1)}× von ${z.min}–${z.max}×)`;
    if (!aktuelleSpur || aktuelleSpur.readyState !== 'live') return;
    try { await aktuelleSpur.applyConstraints({ advanced: [{ zoom: +z.value }] }); }
    catch (e) { melde('Zoom ließ sich nicht setzen: ' + e.message, 'schlecht'); }
  });

  // Bericht in die Zwischenablage — der einzige Weg, wie ein Ergebnis den Weg zu Alex findet.
  // Absichtlich manuell: Die Seite verspricht, nichts zu senden.
  $('kopieren').addEventListener('click', async () => {
    const zeilen = [];
    zeilen.push('Scanner-Prüfstand — ' + new Date().toLocaleString('de-DE'));
    zeilen.push('');
    for (const tr of $('fakten').querySelectorAll('tr')) {
      const td = tr.querySelectorAll('td');
      if (td.length === 2) zeilen.push('  ' + td[0].textContent.trim() + ': ' + td[1].textContent.trim());
    }
    zeilen.push('');
    zeilen.push('  Auflösung gewählt: ' + $('aufloesung').value
      + ' · nötige Lesungen: ' + $('lesungen').value
      + ' · QR/2D: ' + ($('zweid').checked ? 'an' : 'aus'));
    const zoom = $('zoombox').style.display !== 'none' ? $('zoomwert').textContent : '(nicht verfügbar)';
    zeilen.push('  Zoom: ' + zoom);
    zeilen.push('');
    zeilen.push('  ' + $('bilanz').textContent);
    zeilen.push('');
    for (const li of $('treffer').querySelectorAll('li')) {
      zeilen.push('  - ' + li.textContent.replace(/\s+/g, ' ').trim());
    }
    const text = zeilen.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('kopierinfo').textContent = 'Kopiert. Jetzt in eine Nachricht an Alex einfügen.';
    } catch (_) {
      // Ohne Zwischenablage-Recht (aeltere Browser, kein sicherer Kontext): zum Markieren anbieten.
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.width = '100%'; ta.rows = 12;
      $('kopierinfo').textContent = 'Zwischenablage nicht erlaubt — Text bitte von Hand markieren:';
      $('kopierinfo').after(ta); ta.select();
    }
  });

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('licht').addEventListener('click', lichtSchalten);
  $('treffer').dataset.leer = '1';
})();
