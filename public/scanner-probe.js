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
  const GEWAEHLTE_LESUNGEN = () => Number(($('lesungen') || {}).value || 3);
  // 2D-Codes tragen eine Fehlerkorrektur (Reed-Solomon): Was sich entziffern laesst, ist praktisch
  // sicher richtig. 1D hat nur eine Pruefziffer, und die ist uns zweimal bei einer Fehllesung
  // durchgerutscht. Valentins Lauf verwarf deshalb zwei ECHTE Hersteller-QRs (ABB, fischer) —
  // eine Regel, die richtige Daten wegwirft, ist genauso falsch wie eine, die falsche durchlaesst.
  const istZweiD = (f) => /qr|matrix|aztec|pdf417/i.test(String(f || ''));
  // Dieselbe Plausibilitaetspruefung wie im echten Scanner: ITF nur 14-stellig (Karton-Standard).
  // Alex' Buecherregal lieferte zwoelf achtstellige ITF-Treffer, neun davon 9- bis 16-mal gelesen —
  // gegen eine STABILE Fehllesung hilft Wiederholung nicht.
  const plausibel = (code, format) => {
    const f = String(format || '').toLowerCase(), w = String(code || '');
    if (f.includes('itf')) return /^\d{14}$/.test(w);
    if (f.includes('ean_13') || f === 'ean13') return /^\d{13}$/.test(w);
    if (f.includes('ean_8') || f === 'ean8') return /^\d{8}$/.test(w);
    if (f.includes('upc_a') || f === 'upca') return /^\d{12}$/.test(w);
    return w.trim().length >= 3;
  };
  const NOETIGE_LESUNGEN = (format) => istZweiD(format) ? 1 : GEWAEHLTE_LESUNGEN();

  let strom = null, laeuft = false, nativDetector = null, zxingLeser = null;
  let aktuelleSpur = null;
  let versuche = 0, ersterTrefferMs = null, beginn = 0;
  const gesehen = new Map();
  const unplausibel = new Set();
  const gs1Erkannt = new Map();

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
  // Dieselbe GS1-Zerlegung wie im echten Scanner: Aus 010979857524203121SA3AUXMS78F7POQ4CZ7Z
  // wird die Artikelnummer 9798575242031 — sonst zaehlte jede Packung ihre eigene Seriennummer
  // als eigenen Code, und der Katalog waere nach einer Woche unbrauchbar.
  // Pruefziffer einer GTIN (EAN-8/UPC-A/EAN-13/GTIN-14) — gebraucht, um bei einem
  // zusammengesetzten Code sicher zu erkennen, ob vorn eine Artikelnummer steht.
  const gtinGueltig = (n) => {
    const w = String(n || '');
    if (!/^\d+$/.test(w) || ![8, 12, 13, 14].includes(w.length)) return false;
    const z = w.split('').map(Number), pruef = z.pop();
    let su = 0;
    for (let i = z.length - 1, f = 3; i >= 0; i--, f = (f === 3 ? 1 : 3)) su += z[i] * f;
    return ((10 - (su % 10)) % 10) === pruef;
  };
  const DOKUMENT_ENDUNGEN = /\.(pdf|html?|php|aspx?|jpe?g|png)$/i;
  const gs1Nummer = (w) => {
    const b = String(w || '').replace(/^\][A-Za-z]\d/, '').replace(/\x1d/g, '');
    let g = null;
    const roh = b.match(/^01(\d{14})/);
    // Zusammengesetzt, z. B. 4043377228871,22SL22118P0205002,100 (Alex' Rundgang 09.09.2026):
    // vorn die Artikelnummer, dahinter Charge und Menge. Nur uebernehmen, wenn die Pruefziffer
    // stimmt — sonst ist es keine GTIN.
    const zerlegt = (!roh && /[,;|]/.test(b)) ? b.split(/[,;|]/)[0].trim() : null;
    if (roh) g = roh[1];
    else if (zerlegt && /^\d{13,14}$/.test(zerlegt) && gtinGueltig(zerlegt)) {
      g = zerlegt.length === 13 ? '0' + zerlegt : zerlegt;
    }
    else if (/^https?:\/\//i.test(b)) {
      // GS1 Digital Link: https://herkunft.edeka.de/?01=04311501706954 — im Feld gemessen,
      // derselbe Artikel wie der Strichcode daneben.
      const p = b.match(/\/01\/(\d{14})(?:[/?#]|$)/), q = b.match(/[?&]01=(\d{14})(?:[&#]|$)/);
      g = p ? p[1] : (q ? q[1] : null);
    }
    if (!g) return null;
    return g.startsWith('0') ? g.slice(1) : g;
  };

  // Eine Adresse, die auf eine SEITE zeigt statt auf einen Artikel — dieselbe Faustregel wie in
  // js/scanner.js: entscheidend ist das letzte Pfadstueck. Valentins id.abb/2CKA006800A3087 ist
  // ein Artikel, Alex' bauer-solar.de/solarmodule/ eine Seite.
  const istWerbecode = (code) => {
    const w = String(code || '');
    if (!/^https?:\/\//i.test(w)) return false;
    if (gs1Nummer(w)) return false;
    let pfad;
    try { pfad = new URL(w).pathname; } catch (_) { return false; }
    const st = pfad.split('/').filter(Boolean);
    const letztes = st.length ? st[st.length - 1] : '';
    if (!letztes) return true;
    if (DOKUMENT_ENDUNGEN.test(letztes)) return true;
    return !/\d/.test(letztes);
  };

  // ── Fehllesungen derselben Etikette erkennen ────────────────────────────────────────────
  //
  // Im Crafter gemessen (Alex, 09.09.2026, 09:04) — vier Treffer binnen 1,5 Sekunden:
  //
  //   4050821027874  ean_13  12x     ← das echte Etikett
  //   050894027874   upc_a    5x     ← Fehllesung, kam durch die Drei-Lesungen-Schwelle
  //   008970027874   upc_a    1x
  //   8050124027874  ean_13   5x     ← Fehllesung, kam ebenfalls durch
  //
  // Alle vier enden auf „027874". Das ist kein Zufall: Bei EAN-13 steckt die erste Ziffer in der
  // PARITAET der linken Haelfte — dem anfaelligsten Teil. Eine Fehllesung verdirbt deshalb den
  // KOPF, nicht das Ende.
  //
  // NUR DAS ENDE ZAEHLT — der Anfang darf NICHT herangezogen werden. Alex (09.09.2026): „ich habe
  // auch teilweise 3 Barcodes direkt uebereinander." Gestapelte Etiketten werden im SELBEN Moment
  // gelesen, und Geschwister-Codes desselben Herstellers teilen sich den ANFANG:
  //
  //   4003899947247 / 4003899947209   gemeinsamer Anfang 11, gemeinsames Ende 0   → zwei ECHTE Artikel
  //   4050821027874 / 050894027874    gemeinsamer Anfang  0, gemeinsames Ende 6   → Fehllesung
  //
  // Meine erste Fassung pruefte auch den Anfang und haette zwei echte Artikel als Fehllesung
  // beschuldigt — genau dann, wenn sie uebereinanderkleben.
  //
  // Zusaetzlich muss ein deutlich staerker gelesener Nachbar (mindestens doppelt so oft) fast
  // gleichzeitig aufgetaucht sein.
  const gemEnde = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[a.length-1-i] === b[b.length-1-i]) i++; return i; };
  // Welche Codes wurden im selben Moment gelesen? Bei drei uebereinanderklebenden Barcodes sind
  // das die Geschwister EINER Etikette — und genau das muss man sehen, um zu beurteilen, welchen
  // die App nehmen wuerde.
  const gleichzeitigMit = (code, d, alle) => {
    const raus = [];
    for (const [x, xd] of alle) {
      if (x !== code && Math.abs(xd.ersteMs - d.ersteMs) <= 2500) raus.push(x);
    }
    return raus;
  };
  const fehllesungVon = (code, d, alle) => {
    for (const [x, xd] of alle) {
      if (x === code) continue;
      if (xd.n < d.n * 2) continue;                       // kein deutlich staerkerer Nachbar
      if (Math.abs(xd.ersteMs - d.ersteMs) > 2500) continue;  // nicht im selben Moment
      if (gemEnde(code, x) >= 6) return x;
    }
    return null;
  };

  function treffer(rohText, format, weg, ms) {
    const nummer = gs1Nummer(rohText);
    const text = nummer || rohText;
    if (nummer) gs1Erkannt.set(text, rohText);
    if (!plausibel(text, nummer ? 'ean_13' : format)) { unplausibel.add(text + ' (' + format + ')'); return; }
    // Letzter Riegel: Meldet eine ueberlebende Schleife trotzdem noch, wird sie ignoriert.
    // Drei Riegel statt einem, weil der Fehler genau daran lag, dass EINER nicht gehalten hat.
    if (!laeuft) return;
    const neu = !gesehen.has(text);
    if (ersterTrefferMs === null) ersterTrefferMs = ms;
    const e = gesehen.get(text) || { n: 0, format, weg, ersteMs: ms };
    e.n++; gesehen.set(text, e);
    const noetig = NOETIGE_LESUNGEN(format);
    const geradeBestaetigt = e.n === noetig;

    const ul = $('treffer');
    if (ul.dataset.leer !== '0') { ul.innerHTML = ''; ul.dataset.leer = '0'; }
    ul.innerHTML = [...gesehen.entries()].map(([code, d]) => {
      const sicher = d.n >= NOETIGE_LESUNGEN(d.format);
      const stattdessen = fehllesungVon(code, d, gesehen);
      const zusammen = gleichzeitigMit(code, d, gesehen);
      return `<li style="${sicher ? '' : 'opacity:.55'}">`
        + `<code>${String(code).replace(/</g, '&lt;')}</code> — ${d.format}, ${d.weg}`
        + `<br><span style="color:var(--grau);font-size:.85em">erstmals nach ${Math.round(d.ersteMs)} ms · `
        + (gs1Erkannt.has(code) ? 'Artikelnummer aus GS1-Code · ' : '')
        + (istWerbecode(code)
            ? `${d.n}× gelesen — <strong>Werbe-/Infocode</strong> (Seite, kein Artikel) – wird nicht übernommen`
            : stattdessen
            ? `${d.n}× gelesen — <strong>vermutlich Fehllesung von ${String(stattdessen).replace(/</g, '&lt;')}</strong>`
              + ` (gleiches Ende bzw. gleicher Anfang, im selben Moment, dort deutlich öfter gelesen)`
            : sicher ? `${d.n}× gelesen — bestätigt` + (istZweiD(d.format) ? ' (2D: Fehlerkorrektur, eine Lesung genügt)' : '')
                  : `nur ${d.n}× gelesen (nötig: ${NOETIGE_LESUNGEN(d.format)}) — vermutlich Fehllesung, wird nicht übernommen`)
        + (zusammen.length
            ? `<br><span style="color:var(--grau);font-size:.8em">gleichzeitig gelesen mit `
              + zusammen.map(x => String(x).slice(0, 28).replace(/</g, '&lt;')).join(', ')
              + ` — vermutlich dieselbe Etikette</span>`
            : '')
        + '</span></li>';
    }).join('');

    const bestaetigte = [...gesehen.values()].filter(d => d.n >= NOETIGE_LESUNGEN(d.format)).length;
    const einzelne = gesehen.size - bestaetigte;
    $('bilanz').className = 'bilanz' + (bestaetigte ? ' gut' : '');
    $('bilanz').textContent =
      `Erster Treffer nach ${(ersterTrefferMs / 1000).toFixed(1)} Sekunden`
      + ` · ${bestaetigte} bestätigt`
      + (einzelne ? ` · ${einzelne} verworfen (zu selten gelesen)` : '')
      + (unplausibel.size ? ` · ${unplausibel.size} unplausibel (Format/Länge)` : '')
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
    gesehen.clear(); unplausibel.clear(); gs1Erkannt.clear();
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
        // KORREKTUR (08.09.2026): Hier stand „bei iPhones ist das immer so". Das ist FALSCH.
        // Jakobs iPhone (iOS 18.7) meldet die Taschenlampe als schaltbar — Safari kann das seit
        // iOS 17.4. Ich hatte eine veraltete Annahme als Tatsache hingeschrieben, ausgerechnet
        // an der Stelle, an der jemand sie liest.
        + 'das hängt am Modell und am Browser, nicht am Hersteller. '
        + 'Im Lager hilft dann das Licht im Raum, die Taschenlampe im Handy-Menü — oder der '
        + 'Zoom weiter unten.';
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
