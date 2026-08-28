// Abwesenheitskalender: wer fehlt wann — alle Mitarbeiter auf einen Blick (Alex, 28.08.2026).
//
// Liste und Urlaubsübersicht beantworten „wer hat wie viel". Offen war „wer fehlt wann".
//
// WARUM EINE MATRIX UND KEIN KALENDERBLATT. Am 05.06.2026 waren in den echten Daten 8 von 12
// gleichzeitig abwesend (5× Urlaub, 3× Freizeitausgleich). In einem Kalenderblatt müsste diese
// eine Tageszelle acht Namen tragen — das endet bei „+5 weitere", und genau die Tage, an denen es
// darauf ankommt, wären die unlesbaren. In der Matrix hat jeder seine eigene Zeile; ein voller Tag
// ist dort eine senkrechte Wand, die man auf hundert Meter sieht.
//
// MONAT UND JAHR SIND DIESELBE FUNKTION. Beide zeichnen Zeilen × Tage; sie unterscheiden sich nur
// in der Spaltenbreite und der Kopfzeile (Tageszahlen bzw. Monatsnamen). Zwei getrennte Renderer
// würden auseinanderlaufen — dieselbe Falle, die uns beim Bestellrecht dreimal erwischt hat.
//
// KEINE EIGENE SERVER-ANFRAGE. `renderAbsences()` hat die vollständige Liste und `S.users` bereits
// geladen. Der Kalender rechnet daraus; er holt nichts nach.
(function () {
  'use strict';

  // Spalte 1 gehoert den NAMEN, die Tage beginnen bei 2. Ohne eigene Spalte legte sich die
  // (breitere) Namenszelle ueber die ersten vier Tage — im Juni 2026 verschwand ausgerechnet der
  // 05., der Tag mit acht Abwesenden, darunter.
  const TAG1 = 2;

  const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const MONAT_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const MONAT_LANG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
                      'September', 'Oktober', 'November', 'Dezember'];

  // Datumsrechnung ausschliesslich in UTC. Sonst verschiebt die Sommerzeit einzelne Tage um eins —
  // ein Fehler, der genau zweimal im Jahr auftritt und beim Testen im August nie auffällt.
  const alsDatum = (iso) => new Date(iso + 'T00:00:00Z');
  const alsIso = (d) => d.toISOString().slice(0, 10);
  const plusTag = (iso, n) => {
    const d = alsDatum(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return alsIso(d);
  };
  const tagAbstand = (vonIso, bisIso) =>
    Math.round((alsDatum(bisIso) - alsDatum(vonIso)) / 86400000);

  const heuteIso = () => new Date().toLocaleDateString('sv-SE');

  // --- Zustand der Ansicht ---------------------------------------------------------------------
  // Bewusst modulweit und nicht in S: Der Kalender ist eine Ansicht, kein Datenbestand. Wer den
  // Reiter wechselt und zurückkommt, soll denselben Monat wiedersehen.
  const zustand = {
    modus: 'monat',                       // 'monat' | 'jahr'
    anker: heuteIso().slice(0, 7) + '-01', // erster Tag des gezeigten Monats bzw. Jahres
    // Wischposition je Ansicht. Der Kalender wird bei JEDER Aenderung neu gezeichnet — auch, wenn
    // die Chefin nebenan einen Urlaub genehmigt (SSE). Ohne dieses Gedaechtnis spraenge man dabei
    // zurueck zu „heute", obwohl man gerade den Maerz ansieht. Dieselbe Falle wie beim
    // Scroll-Ruecksprung im Zeitnachweis (B10).
    wisch: {},
  };
  const wischSchluessel = () => zustand.modus + '|' + zustand.anker;

  function spanne() {
    if (zustand.modus === 'jahr') {
      const jahr = zustand.anker.slice(0, 4);
      return { von: jahr + '-01-01', bis: jahr + '-12-31' };
    }
    const von = zustand.anker.slice(0, 8) + '01';
    const d = alsDatum(von);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);                       // letzter Tag des Monats
    return { von, bis: alsIso(d) };
  }

  function titel() {
    const d = alsDatum(zustand.anker);
    return zustand.modus === 'jahr'
      ? String(d.getUTCFullYear())
      : MONAT_LANG[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function verschieben(schritte) {
    const d = alsDatum(zustand.anker);
    if (zustand.modus === 'jahr') d.setUTCFullYear(d.getUTCFullYear() + schritte);
    else d.setUTCMonth(d.getUTCMonth() + schritte);
    d.setUTCDate(1);
    zustand.anker = alsIso(d);
  }

  // --- Daten aufbereiten -----------------------------------------------------------------------

  const ueberschneidet = (a, von, bis) => a.date_from <= bis && a.date_to >= von;

  // Feiertage haben user_id NULL — sie gelten fuer ALLE. Als eigene Zeile wuerden sie jede Zeile
  // fuellen und die Ansicht wertlos machen; deshalb faerben sie die SPALTE.
  const istFeiertag = (a) => a.type === 'feiertag';

  /**
   * Die Zeilen des Kalenders: alle aktiven Mitarbeiter, plus jeder, der in der Spanne eine
   * Abwesenheit hat (auch ein ausgestellter — seine alten Zeiten gehoeren in den Monat, in dem
   * sie lagen).
   */
  function zeilenBauen(abwesenheiten, nutzer, von, bis) {
    const nachId = new Map();
    for (const u of (nutzer || [])) {
      if (Number(u.active) === 0) continue;
      nachId.set(u.id, { id: u.id, name: u.name, eintraege: [] });
    }
    for (const a of abwesenheiten) {
      if (istFeiertag(a) || !a.user_id) continue;
      if (!ueberschneidet(a, von, bis)) continue;
      if (!nachId.has(a.user_id)) {
        nachId.set(a.user_id, { id: a.user_id, name: a.user_name || ('#' + a.user_id), eintraege: [] });
      }
      nachId.get(a.user_id).eintraege.push(a);
    }
    return [...nachId.values()].sort((x, y) => x.name.localeCompare(y.name, 'de'));
  }

  // --- Zeichnen --------------------------------------------------------------------------------

  /**
   * Ein Balken je Abwesenheit, auf die Spanne zugeschnitten. Ein Zeitraum kann laenger sein als
   * das Sichtfenster (der laengste echte ist 47 Tage, 11.01.–26.02.2027) — dann wird er
   * abgeschnitten und die Schnittkante bekommt einen Pfeil, damit niemand denkt, dort sei Schluss.
   */
  function balkenHtml(a, von, bis, spalten) {
    const startIso = a.date_from < von ? von : a.date_from;
    const endeIso  = a.date_to  > bis ? bis : a.date_to;
    const start = tagAbstand(von, startIso) + TAG1;
    const laenge = tagAbstand(startIso, endeIso) + 1;
    if (start < TAG1 || laenge < 1 || start > spalten + TAG1 - 1) return '';
    const offenLinks  = a.date_from < von;
    const offenRechts = a.date_to > bis;
    const klassen = ['abscal-bar', 'abscal-bar--' + a.type];
    if (a.status === 'pending')  klassen.push('abscal-bar--pending');
    if (a.status === 'rejected') klassen.push('abscal-bar--rejected');
    if (offenLinks)  klassen.push('abscal-bar--offen-links');
    if (offenRechts) klassen.push('abscal-bar--offen-rechts');
    const art = (typeof ABSENCE_TYPES !== 'undefined' && ABSENCE_TYPES[a.type])
      ? ABSENCE_TYPES[a.type].label : a.type;
    // Die Beschriftung steht IM Balken, aber nur wenn er breit genug ist — im Jahr ist ein
    // Ein-Tages-Balken drei Pixel schmal, dort traegt die Farbe die Aussage.
    const text = (zustand.modus === 'monat' && laenge >= 3) ? esc(art) : '';
    return `<div class="${klassen.join(' ')}" style="grid-column:${start} / span ${Math.min(laenge, spalten + TAG1 - start)}"
      data-abs="${a.id}" role="img" aria-label="${esc(a.user_name || '')}: ${esc(art)}, ${esc(formatDateRange(a.date_from, a.date_to))}">${text}</div>`;
  }

  function kopfHtml(von, bis, spalten) {
    if (zustand.modus === 'jahr') {
      // Monatsnamen, jeder ueber so viele Spalten wie sein Monat Tage hat.
      let html = '', iso = von;
      while (iso <= bis) {
        const d = alsDatum(iso);
        const ersterNaechster = alsIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
        const ende = ersterNaechster > bis ? plusTag(bis, 1) : ersterNaechster;
        const tage = tagAbstand(iso, ende);
        const ersterDesMonats = iso.slice(0, 8) + '01';
        html += `<button type="button" class="abscal-kopf-monat" data-monat="${ersterDesMonats}"
          style="grid-column:${tagAbstand(von, iso) + TAG1} / span ${tage}"
          title="${MONAT_LANG[d.getUTCMonth()]} ${d.getUTCFullYear()} im Detail">${MONAT_KURZ[d.getUTCMonth()]}</button>`;
        iso = ende;
      }
      return html;
    }
    let html = '';
    for (let i = 0; i < spalten; i++) {
      const iso = plusTag(von, i);
      const wt = alsDatum(iso).getUTCDay();
      const we = (wt === 0 || wt === 6) ? ' abscal-kopf-tag--we' : '';
      html += `<div class="abscal-kopf-tag${we}" style="grid-column:${i + TAG1}">
        <span class="abscal-kopf-wt">${WOCHENTAG[wt]}</span><span class="abscal-kopf-nr">${iso.slice(8)}</span></div>`;
    }
    return html;
  }

  /**
   * Wochenenden, Feiertage und „heute" als senkrechte Streifen hinter allen Zeilen.
   *
   * WOCHENENDEN NUR IM MONAT. Im Jahr sind es 104 Streifen zu je drei Pixeln — das ergibt ein
   * Barcode-Muster, das die Monatsnamen zerschneidet und keine nutzbare Auskunft gibt (dass Samstag
   * frei ist, weiss jeder). Dort stehen stattdessen Monatsgrenzen, die man wirklich braucht, um
   * einen Balken zeitlich einzuordnen.
   */
  function unterlageHtml(von, bis, spalten, feiertage, zeilenAnzahl) {
    const bis1 = zeilenAnzahl + 2;   // Kopfzeile + alle Mitarbeiterzeilen
    const imJahr = zustand.modus === 'jahr';
    let html = '';
    for (let i = 0; i < spalten; i++) {
      const iso = plusTag(von, i);
      const d = alsDatum(iso);
      const wt = d.getUTCDay();
      const f = feiertage.get(iso);
      let k = null;
      if (f) k = 'abscal-spalte--feiertag';
      else if (!imJahr && (wt === 0 || wt === 6)) k = 'abscal-spalte--we';
      if (k) {
        html += `<div class="abscal-spalte ${k}" style="grid-column:${i + TAG1};grid-row:1 / ${bis1}"
          ${f ? `title="${esc(f)}"` : ''}></div>`;
      }
      if (imJahr && d.getUTCDate() === 1 && i > 0) {
        html += `<div class="abscal-spalte abscal-spalte--monat" style="grid-column:${i + TAG1};grid-row:1 / ${bis1}"></div>`;
      }
    }
    const h = heuteIso();
    if (h >= von && h <= bis) {
      html += `<div class="abscal-spalte abscal-spalte--heute" style="grid-column:${tagAbstand(von, h) + TAG1};grid-row:1 / ${bis1}"></div>`;
    }
    return html;
  }

  function legendeHtml(benutzteArten) {
    if (typeof ABSENCE_TYPES === 'undefined') return '';
    const teile = Object.entries(ABSENCE_TYPES)
      .filter(([t]) => benutzteArten.has(t))
      .map(([t, v]) => `<span class="abscal-legende-eintrag"><i class="abscal-legende-farbe abscal-bar--${t}"></i>${esc(v.label)}</span>`);
    // „Wochenende" nur erklaeren, wo es auch gezeichnet wird — im Jahr gibt es die Streifen nicht.
    if (zustand.modus === 'monat') {
      teile.push('<span class="abscal-legende-eintrag"><i class="abscal-legende-farbe abscal-legende-we"></i>Wochenende</span>');
    }
    teile.push('<span class="abscal-legende-eintrag abscal-legende-hinweis">schraffiert = noch nicht genehmigt</span>');
    return `<div class="abscal-legende">${teile.join('')}</div>`;
  }

  /**
   * Zeichnet den Kalender in `ziel`.
   * @param {HTMLElement} ziel
   * @param {Array} abwesenheiten  die bereits geladene Liste (ungefiltert)
   * @param {Array} nutzer         S.users
   */
  function zeichnen(ziel, abwesenheiten, nutzer, opt) {
    opt = opt || {};
    if (!ziel) return;
    const { von, bis } = spanne();
    const spalten = tagAbstand(von, bis) + 1;

    const feiertage = new Map();
    for (const a of abwesenheiten) {
      if (!istFeiertag(a) || a.status === 'rejected') continue;
      for (let iso = a.date_from; iso <= a.date_to; iso = plusTag(iso, 1)) {
        if (iso >= von && iso <= bis) feiertage.set(iso, a.comment || 'Feiertag');
      }
    }

    const zeilen = zeilenBauen(abwesenheiten, nutzer, von, bis);
    const benutzteArten = new Set();
    for (const z of zeilen) for (const a of z.eintraege) benutzteArten.add(a.type);
    if (feiertage.size) benutzteArten.add('feiertag');

    const koerper = zeilen.map((z, i) => {
      const balken = z.eintraege.map(a => balkenHtml(a, von, bis, spalten)).join('');
      return `<div class="abscal-name" style="grid-row:${i + 2}">${esc(z.name)}</div>
              <div class="abscal-zeile" style="grid-row:${i + 2};grid-column:${TAG1} / ${spalten + TAG1}"></div>
              ${balken.replace(/style="grid-column:/g, `style="grid-row:${i + 2};grid-column:`)}`;
    }).join('');

    const leer = zeilen.length === 0;
    ziel.innerHTML = `
      <div class="abscal-steuer">
        <div class="abscal-modus">
          <button class="abscal-modus-btn ${zustand.modus === 'monat' ? 'active' : ''}" data-modus="monat">Monat</button>
          <button class="abscal-modus-btn ${zustand.modus === 'jahr' ? 'active' : ''}" data-modus="jahr">Jahr</button>
        </div>
        <div class="abscal-nav">
          <button class="btn btn-sm btn-outline" data-schritt="-1" aria-label="zurück">‹</button>
          <span class="abscal-titel">${esc(titel())}</span>
          <button class="btn btn-sm btn-outline" data-schritt="1" aria-label="vor">›</button>
          <button class="btn btn-sm btn-outline abscal-heute" data-heute="1">Heute</button>
        </div>
      </div>
      ${leer ? '<p class="absence-empty">Keine Mitarbeiter zum Anzeigen.</p>' : `
      <div class="abscal-scroll">
        <div class="abscal-grid abscal-grid--${zustand.modus}"
             style="grid-template-columns:var(--abscal-name) repeat(${spalten}, var(--abscal-tag))">
          ${unterlageHtml(von, bis, spalten, feiertage, zeilen.length)}
          ${kopfHtml(von, bis, spalten)}
          ${koerper}
        </div>
      </div>`}
      ${leer ? '' : legendeHtml(benutzteArten)}`;

    // Dorthin scrollen, wo heute ist. Im Jahr ist das Gitter rund dreimal so breit wie ein
    // Handy-Fenster; ohne das startet man im Januar und wischt sich erst zur Gegenwart durch.
    // Nur waagerecht und nur innerhalb der Flaeche — die Seite selbst bleibt, wo sie ist.
    const flaeche = ziel.querySelector('.abscal-scroll');
    if (flaeche) {
      const schluessel = wischSchluessel();
      const gemerkt = zustand.wisch[schluessel];
      if (gemerkt != null) {
        flaeche.scrollLeft = gemerkt;                 // dieselbe Ansicht: Position halten
      } else {
        const h = heuteIso();
        const spalte = (h >= von && h <= bis) ? ziel.querySelector('.abscal-spalte--heute') : null;
        flaeche.scrollLeft = spalte ? Math.max(0, spalte.offsetLeft - flaeche.clientWidth / 3) : 0;
      }
      flaeche.addEventListener('scroll', () => { zustand.wisch[schluessel] = flaeche.scrollLeft; }, { passive: true });
    }

    ziel.querySelectorAll('.abscal-modus-btn').forEach(b => b.addEventListener('click', () => {
      zustand.modus = b.dataset.modus;
      // Beim Wechsel den Anker auf den Monats- bzw. Jahresanfang ziehen, damit die Spanne stimmt.
      // Vom Jahr in den Monat: Zeigt das Jahr das LAUFENDE, landet man im aktuellen Monat statt
      // stur im Januar — sonst schaut man auf einen Monat, der neun Monate zurueckliegt.
      const h = heuteIso();
      if (zustand.modus === 'jahr') {
        zustand.anker = zustand.anker.slice(0, 4) + '-01-01';
      } else if (zustand.anker.slice(0, 4) === h.slice(0, 4)) {
        zustand.anker = h.slice(0, 8) + '01';
      } else {
        zustand.anker = zustand.anker.slice(0, 8) + '01';
      }
      zeichnen(ziel, abwesenheiten, nutzer, opt);
    }));
    ziel.querySelectorAll('[data-schritt]').forEach(b => b.addEventListener('click', () => {
      verschieben(Number(b.dataset.schritt));
      zeichnen(ziel, abwesenheiten, nutzer, opt);
    }));
    // Auf einen Monatsnamen tippen fuehrt in genau diesen Monat — der naheliegende Weg vom
    // Ueberblick ins Detail, ohne den Umweg ueber „Monat" und dann vor-/zurueckblaettern.
    ziel.querySelectorAll('[data-monat]').forEach(b => b.addEventListener('click', () => {
      zustand.modus = 'monat';
      zustand.anker = b.dataset.monat;
      zeichnen(ziel, abwesenheiten, nutzer, opt);
    }));
    ziel.querySelector('[data-heute]')?.addEventListener('click', () => {
      const h = heuteIso();
      zustand.anker = zustand.modus === 'jahr' ? h.slice(0, 4) + '-01-01' : h.slice(0, 8) + '01';
      zeichnen(ziel, abwesenheiten, nutzer, opt);
    });

    // Erklärung am Balken. Dasselbe Muster wie bei den Gesetzes-Markern: Maus UND langer Druck,
    // damit es am Handy überhaupt erreichbar ist.
    const nachId = new Map(abwesenheiten.map(a => [String(a.id), a]));
    ziel.querySelectorAll('.abscal-bar').forEach(el => {
      const a = nachId.get(el.dataset.abs);
      if (!a) return;
      // Dasselbe Muster wie bei den Verstoss-Markern in app-3-dashboard.js: `istMauszeiger()`
      // filtert die Maus-Ersatzereignisse weg, die Chrome nach jeder Beruehrung schickt — sonst
      // waere die per langem Druck geoeffnete Sprechblase beim Loslassen sofort wieder zu.
      // attachLongPressTooltip ruft sein zweites Argument als FUNKTION auf (`htmlFor()`) — ein
      // String flöge dort auf die Nase, und zwar nur beim langen Druck auf einem echten Gerät.
      const html = () => balkenTooltipHtml(a);
      el.addEventListener('mouseenter', (ev) => {
        if (!istMauszeiger()) return;
        showTooltip(html(), ev.clientX, ev.clientY);
      });
      el.addEventListener('mousemove', (ev) => {
        if (!istMauszeiger()) return;
        if (tooltipEl && tooltipEl.style.display !== 'none') showTooltip(tooltipEl.innerHTML, ev.clientX, ev.clientY);
      });
      el.addEventListener('mouseleave', () => { if (istMauszeiger()) hideTooltip(); });
      attachLongPressTooltip(el, html);
      // Antippen fuehrt zum Eintrag in der Liste. attachLongPressTooltip setzt bei einem langen
      // Druck einen Riegel, damit das Aufklappen der Sprechblase nicht zugleich als Klick zaehlt.
      if (typeof opt.beiKlick === 'function') {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { hideTooltip(); opt.beiKlick(a); });
      }
    });
  }

  function balkenTooltipHtml(a) {
    const art = (typeof ABSENCE_TYPES !== 'undefined' && ABSENCE_TYPES[a.type])
      ? ABSENCE_TYPES[a.type].icon + ' ' + ABSENCE_TYPES[a.type].label : a.type;
    const status = (typeof absenceStatusLabel === 'function') ? absenceStatusLabel(a.status) : '';
    const tage = tagAbstand(a.date_from, a.date_to) + 1;
    return `<strong>${esc(a.user_name || '')}</strong><br>${esc(art)} · ${status}<br>
      ${esc(formatDateRange(a.date_from, a.date_to))} <span class="abscal-tt-tage">(${tage} ${tage === 1 ? 'Tag' : 'Tage'})</span>
      ${a.comment ? '<br><em>' + esc(a.comment) + '</em>' : ''}`;
  }

  window.Abwesenheitskalender = { zeichnen, zustand, _intern: { spanne, zeilenBauen, verschieben, titel } };
})();
