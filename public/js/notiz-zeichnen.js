// --- Zeichenflächen im Notiz-Editor (Alex, 24.11.2026) ---
//
// „Normal schreiben wie bisher — und ein Umschalter auf Zeichnen: Was geschrieben ist, bleibt stehen, man
// zeichnet mit Finger, Stift oder Maus, auch Striche, Pfeile, Kästen, Kreise, mit Farbe." Entschieden: die
// Zeichnung sitzt als eigene FLÄCHE zwischen den Zeilen (nicht über dem Text) — dann sieht sie auf Handy
// und Rechner gleich aus und rutscht mit ihrem Absatz mit.
//
// Was eine Zeichnung ist und wie sie aussieht: public/js/zeichnung.js (gemeinsam mit dem Server).
// Hier: der Block im Schreibfeld, die Ansicht je Fläche mit Griffen, die Werkzeuge und „Rückgängig".
//
//   * Im Schreibfeld ist eine Fläche ein Quill-Block (ZeichnungBlot) — Quill kennt nur die Kennung.
//     Inhalt, Größe und Einzug stehen im gemeinsamen Dokument (Karte 'zeichnungen') und kommen live
//     bei allen an. Die Ansicht baut nzSteuerung, sobald Quill den Block einhängt.
//   * Text- und Zeichenmodus: Im Zeichenmodus ist das Schreibfeld gesperrt (keine Tastatur, die am
//     Handy beim Zeichnen aufspringt); die Flächen haben Griffe zum Vergrößern, Einrücken und Löschen.
//   * Rückgängig/Wiederholen im Zeichenmodus nimmt nur EIGENE Zeichenschritte zurück (Y.UndoManager
//     mit eigener Herkunft) — das Tippen hat sein eigenes Rückgängig in Quill.

let _nzSitzung = null;   // Steuerung der gerade offenen Notiz — an ihr hängen die Flächen im Schreibfeld

const NZ_WERKZEUGE = [
  { id: 'frei', name: 'Stift (frei zeichnen)', svg: '<path d="M4 20c3-1 4-4 7-7l6-6 2 2-6 6c-3 3-6 4-7 7z"/><path d="M15 5l4 4"/>' },
  { id: 'linie', name: 'Linie', svg: '<path d="M5 19L19 5"/>' },
  { id: 'pfeil', name: 'Pfeil', svg: '<path d="M5 19L19 5"/><path d="M11 5h8v8"/>' },
  { id: 'kasten', name: 'Kasten', svg: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  { id: 'kreis', name: 'Kreis', svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5"/>' },
  { id: 'radierer', name: 'Radierer (Striche antippen oder darüberwischen)', svg: '<path d="M8 20h12"/><path d="M4.5 14.5l8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 19H8.5l-4-4a.4.4 0 0 1 0-.5z"/>' },
  { id: 'hand', name: 'Seite verschieben (scrollen, ohne zu zeichnen)', svg: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1V4.5a1.5 1.5 0 0 1 3 0V12m0-6.5a1.5 1.5 0 0 1 3 0V13m0-4.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 14.5a1.6 1.6 0 0 1 2.6-1.9L8 14"/>' },
];
const NZ_DICKEN = { 2: 'Dünn', 4: 'Mittel', 8: 'Dick' };
const NZ_FARBNAMEN = { schwarz: 'Schwarz', rot: 'Rot', orange: 'Orange', gruen: 'Grün', blau: 'Blau', lila: 'Lila', grau: 'Grau' };
const nzIcon = (inhalt) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inhalt}</svg>`;

// Kennungen: Fläche 12, Strich 8 Zeichen aus a–z0–9 (Prüfung: NotizZeichnung.ID / STRICH_ID)
function nzKennung(n) {
  const z = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const zufall = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(zufall, x => z[x % z.length]).join('');
}

// Antippen sicher erkennen. Chrome verschluckt nach einem schnellen Zug über eine Fläche mit
// touch-action: none ein Tippen, das kurz danach kommt (gilt als „Schwung anhalten") — der click fehlt
// dann, man tippt „Radierer" und nichts passiert (gemessen 24.11.2026: jeder zweite Tipp nach einem Strich).
// Bei Finger und Stift zählt deshalb schon das Loslassen auf demselben Knopf; der click, der meist doch
// noch kommt, wird übergangen. Maus und Tastatur (Enter/Leertaste) laufen wie immer über click.
function nzTippen(wurzel, handeln) {
  let unten = null, zuletzt = { knopf: null, zeit: 0 };
  const knopfVon = (e) => { const b = e.target.closest && e.target.closest('button'); return b && wurzel.contains(b) && !b.disabled ? b : null; };
  const runter = (e) => { unten = e.pointerType === 'mouse' ? null : knopfVon(e); };
  const hoch = (e) => {
    const b = knopfVon(e);
    if (e.pointerType !== 'mouse' && b && b === unten) { zuletzt = { knopf: b, zeit: Date.now() }; handeln(b, e); }
    unten = null;
  };
  const klick = (e) => {
    const b = knopfVon(e);
    if (!b || (b === zuletzt.knopf && Date.now() - zuletzt.zeit < 700)) return;
    handeln(b, e);
  };
  wurzel.addEventListener('pointerdown', runter);
  wurzel.addEventListener('pointerup', hoch);
  wurzel.addEventListener('click', klick);
  return () => { wurzel.removeEventListener('pointerdown', runter); wurzel.removeEventListener('pointerup', hoch); wurzel.removeEventListener('click', klick); };
}

// Einmal je Seite: der Block „zeichnung" für Quill
function notizZeichnungAnmelden(Quill) {
  if (notizZeichnungAnmelden.erledigt) return;
  notizZeichnungAnmelden.erledigt = true;
  const BlockEmbed = Quill.import('blots/block/embed');
  class ZeichnungBlot extends BlockEmbed {
    static create(id) {
      const n = super.create();
      n.setAttribute('contenteditable', 'false');
      n.dataset.id = String(id);
      return n;
    }
    static value(n) { return n.dataset.id; }
    attach() { super.attach(); if (_nzSitzung) _nzSitzung.an(this.domNode); }
    detach() { if (_nzSitzung) _nzSitzung.ab(this.domNode); super.detach(); }
    // Quill untersucht sonst jede Änderung IN der Fläche (jeder Strich, jeder Griff) als mögliche
    // Textänderung und liest dafür das ganze Dokument neu. Hat ein Block diese Methode, überspringt
    // es sie (quill/blots/scroll.js: isUpdatable).
    updateContent() {}
  }
  ZeichnungBlot.blotName = 'zeichnung';
  ZeichnungBlot.tagName = 'DIV';
  ZeichnungBlot.className = 'notiz-zeichnung';
  Quill.register(ZeichnungBlot, true);
}

// Knopfleiste: Umschalter (immer) und die Zeichenwerkzeuge (nur im Zeichenmodus). Steht in notizFeldHtml().
function nzLeisteHtml() {
  return `
        <span class="nz-modus" role="group" aria-label="Eingabe">
          <button type="button" class="nz-modus-knopf" data-modus="text" aria-pressed="true" title="Text: schreiben mit der Tastatur">${nzIcon('<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>')}<span>Text</span></button>
          <button type="button" class="nz-modus-knopf" data-modus="zeichnen" aria-pressed="false" title="Zeichnen mit Finger, Stift oder Maus">${nzIcon(NZ_WERKZEUGE[0].svg)}<span>Zeichnen</span></button>
        </span>
        <span class="ql-formats nz-nur-zeichnen nz-werkzeuge" role="group" aria-label="Werkzeug">
          ${NZ_WERKZEUGE.map(w => `<button type="button" class="nz-knopf" data-werkzeug="${w.id}" aria-pressed="false" title="${w.name}" aria-label="${w.name}">${nzIcon(w.svg)}</button>`).join('')}
        </span>
        <span class="ql-formats nz-nur-zeichnen nz-stift-gruppe">
          <button type="button" class="nz-knopf nz-stift-knopf" aria-haspopup="true" aria-expanded="false" title="Farbe und Dicke" aria-label="Farbe und Dicke"><span class="nz-stift-punkt"></span></button>
          <span class="nz-stift-wahl" hidden>
            <span class="nz-stift-reihe" role="group" aria-label="Farbe">${Object.entries(NZ_FARBNAMEN).map(([k, n]) =>
              `<button type="button" class="nz-farbe" data-farbe="${k}" title="${n}" aria-label="${n}" aria-pressed="false"></button>`).join('')}</span>
            <span class="nz-stift-reihe" role="group" aria-label="Dicke">${Object.entries(NZ_DICKEN).map(([d, n]) =>
              `<button type="button" class="nz-dicke" data-dicke="${d}" title="${n}" aria-label="${n}" aria-pressed="false"><span style="height:${d}px"></span></button>`).join('')}</span>
          </span>
        </span>
        <span class="ql-formats nz-nur-zeichnen nz-aktionen">
          <button type="button" class="nz-knopf" data-akt="rueckgaengig" title="Rückgängig (eigene Zeichenschritte)" aria-label="Rückgängig" disabled>${nzIcon('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>')}</button>
          <button type="button" class="nz-knopf" data-akt="wiederholen" title="Wiederholen" aria-label="Wiederholen" disabled>${nzIcon('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>')}</button>
          <button type="button" class="nz-knopf nz-neu" data-akt="neu" title="Neue Zeichenfläche unter der Zeile, in der der Cursor stand">${nzIcon('<path d="M12 5v14M5 12h14"/>')}<span>Fläche</span></button>
        </span>`;
}

// Für Druck und Vorschau aus dem Stand im Browser: Zeichnungen mit Inhalt statt nur Kennung — dieselbe
// Form, die der Server in body_delta schreibt (notiz-dokument.js, felder()).
function nzDeltaMitInhalt(doc) {
  const karte = doc.getMap('zeichnungen');
  return doc.getText('notiz').toDelta().map(op => {
    const id = op.insert && typeof op.insert === 'object' ? op.insert.zeichnung : null;
    if (typeof id !== 'string') return op;
    const m = karte.get(id);
    const s = m && m.get && m.get('s');
    return { ...op, insert: { zeichnung: m && m.get ? { id, b: m.get('b'), h: m.get('h'), e: m.get('e'), s: s ? s.toArray() : [] } : { id } } };
  });
}

// Fertige Zeichnung (Vorschau, Druck) als HTML. Die Fläche nimmt höchstens ihre eigene Breite ein und
// schrumpft samt Einzug, wenn weniger Platz ist — wie im Schreibfeld.
function nzZeichnungHtml(z) {
  const d = NotizZeichnung.bereinigt(z);
  if (!d.s.length) return '';   // leere Fläche: außerhalb des Schreibfelds nur weißer Raum (wie in PDF/Word/ODT)
  const gesamt = d.b + d.e;
  return `<div class="notiz-zeichnung-bild" style="max-width:${gesamt}px"><div style="margin-left:${(d.e / gesamt * 100).toFixed(3)}%;width:${(d.b / gesamt * 100).toFixed(3)}%">`
    + NotizZeichnung.svg(d) + '</div></div>';
}

// ─── Steuerung je Sitzung ───────────────────────────────────────────────────────────────────────

function nzSteuerung(s) {
  const Y = window.Kollab.Y, Z = window.NotizZeichnung;
  const herkunft = { zeichnen: true };   // eigene Zeichenschritte — nur die nimmt „Rückgängig" zurück
  const karte = s.doc.getMap('zeichnungen');
  const text = s.doc.getText('notiz');
  const leiste = document.getElementById('notiz-leiste');
  const editorEl = document.querySelector('#notiz-feld');
  const st = { modus: 'text', werkzeug: 'frei', farbe: 'schwarz', dicke: 4, letzteStelle: null, offen: true };
  try { const g = JSON.parse(localStorage.getItem('notiz-stift') || '{}');   // gemerkt je Gerät
    if (Z.FARBEN[g.farbe]) st.farbe = g.farbe; if (Z.DICKEN.includes(g.dicke)) st.dicke = g.dicke; } catch (_) {}
  const ansichten = new Map();   // Block-Element → Ansicht
  const rueck = new Y.UndoManager([karte, text], { trackedOrigins: new Set([herkunft]), captureTimeout: 24 * 3600 * 1000 });

  const darfSchreiben = () => s.zugriff && s.zugriff !== 'read';
  const flaechenDaten = (id) => {
    const m = karte.get(id);
    if (!(m instanceof Y.Map)) return null;
    const striche = m.get('s');
    return { b: m.get('b'), h: m.get('h'), e: m.get('e'), s: striche instanceof Y.Array ? striche.toArray() : [] };
  };
  const leer = () => ({ b: 600, h: 300, e: 0, s: [] });
  // Fehlt der Inhalt (eine gelöschte Fläche kam per Rückgängig im Text zurück), entsteht er beim ersten Strich neu
  const flaecheSichern = (id) => {
    let m = karte.get(id);
    if (m instanceof Y.Map) return m;
    const d = leer();
    m = new Y.Map(); m.set('b', d.b); m.set('h', d.h); m.set('e', d.e); m.set('s', new Y.Array());
    karte.set(id, m);
    return m;
  };

  // ─── Ansicht einer Fläche ──────────────────────────────────────────────────────────────────
  function an(node) {
    if (ansichten.has(node)) return;
    const id = node.dataset.id;
    node.innerHTML = `<div class="nz-rahmen">
        <svg class="nz-svg" xmlns="http://www.w3.org/2000/svg"><g class="nz-striche"></g><g class="nz-jetzt"></g></svg>
        <button type="button" class="nz-griff nz-griff-schieben" title="Einrücken: nach links oder rechts ziehen" aria-label="Zeichenfläche einrücken">${nzIcon('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M4 12h16"/>')}</button>
        <button type="button" class="nz-griff nz-griff-loeschen" title="Zeichenfläche löschen" aria-label="Zeichenfläche löschen">${nzIcon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>')}</button>
        <button type="button" class="nz-griff nz-griff-groesse" title="Größe ändern: ziehen" aria-label="Größe der Zeichenfläche ändern">${nzIcon('<path d="M20 14v6h-6M20 20l-7-7M4 10V4h6M4 4l7 7"/>')}</button>
      </div>`.replace(/>\s+</g, '><');   // Das Schreibfeld zeigt Leerraum an (pre-wrap): Zwischenraum würde zur Leerzeile über der Fläche
    const v = { node, id, rahmen: node.firstElementChild, svg: node.querySelector('.nz-svg'),
      striche: node.querySelector('.nz-striche'), jetzt: node.querySelector('.nz-jetzt'),
      massstab: 1, vorlaeufig: null, stand: null, zeiger: null, strich: null };
    ansichten.set(node, v);
    v.svg.addEventListener('pointerdown', (e) => zeichnenStart(v, e));
    v.svg.addEventListener('pointermove', (e) => zeichnenWeiter(v, e));
    v.svg.addEventListener('pointerup', (e) => zeichnenEnde(v, e));
    v.svg.addEventListener('pointercancel', (e) => zeichnenAbbrechen(v, e));
    griffBinden(v, node.querySelector('.nz-griff-groesse'), 'groesse');
    griffBinden(v, node.querySelector('.nz-griff-schieben'), 'einzug');
    nzTippen(v.rahmen, (b) => { if (b.classList.contains('nz-griff-loeschen')) loeschen(v); });
    zeigen(v, true);
  }
  function ab(node) { ansichten.delete(node); }

  // Platz und Maßstab: höchstens 1, sonst so klein, dass Einzug + Breite in die Zeile passen
  const platz = (v) => Math.max(40, v.node.clientWidth || (editorEl && editorEl.clientWidth) || 300);
  function zeigen(v, striche) {
    const d = { ...(flaechenDaten(v.id) || leer()), ...(v.vorlaeufig || {}) };
    v.massstab = Math.min(1, platz(v) / (d.b + d.e));
    const m = v.massstab;
    v.rahmen.style.width = d.b * m + 'px';
    v.rahmen.style.height = d.h * m + 'px';
    v.rahmen.style.marginLeft = d.e * m + 'px';
    v.svg.setAttribute('viewBox', `0 0 ${d.b} ${d.h}`);
    v.d = d;
    if (striche) v.striche.innerHTML = d.s.map(Z.strichSvg).join('');
  }

  // Änderungen am Dokument (eigene und fremde) → betroffene Flächen neu zeichnen, gebündelt je Bild
  const schmutzig = new Set();
  let geplant = false;
  const neuZeichnen = (id) => {
    schmutzig.add(id);
    if (geplant) return;
    geplant = true;
    requestAnimationFrame(() => {
      geplant = false;
      for (const v of ansichten.values()) if (schmutzig.has(v.id) || schmutzig.has('*')) zeigen(v, true);
      schmutzig.clear();
    });
  };
  const beobachter = (ereignisse) => {
    for (const ev of ereignisse) {
      if (ev.path.length) neuZeichnen(String(ev.path[0]));
      else for (const k of ev.keysChanged) neuZeichnen(k);
    }
  };
  karte.observeDeep(beobachter);
  // Andere Breite (Handy gedreht, Fenster) → Maßstab neu. Nur die Breite: Die Höhe ändert sich bei jedem
  // Zeilenumbruch, und die Striche bleiben beim Umrechnen ohnehin, wie sie sind (viewBox).
  let letzteBreite = 0;
  const groesse = new ResizeObserver((eintraege) => {
    const b = Math.round(eintraege[0].contentRect.width);
    if (b === letzteBreite) return;
    letzteBreite = b;
    for (const v of ansichten.values()) zeigen(v, false);
  });
  if (editorEl) groesse.observe(editorEl);

  // ─── Zeichnen ──────────────────────────────────────────────────────────────────────────────
  const imZeichenmodus = () => st.modus === 'zeichnen' && darfSchreiben();
  function punkt(v, e) {
    const r = v.svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * v.d.b, y = (e.clientY - r.top) / r.height * v.d.h;
    return [Math.round(Math.min(v.d.b, Math.max(0, x))), Math.round(Math.min(v.d.h, Math.max(0, y)))];
  }
  function zeichnenStart(v, e) {
    if (!imZeichenmodus() || st.werkzeug === 'hand') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (v.zeiger !== null) {
      // Zweiter Finger (oder der Handballen): kein Strich daraus — den angefangenen verwerfen
      zeichnenAbbrechen(v);
      return;
    }
    e.preventDefault();
    try { v.svg.setPointerCapture(e.pointerId); } catch (_) {}
    v.zeiger = e.pointerId;
    rueck.stopCapturing();   // alles bis zum Loslassen ist EIN Schritt für „Rückgängig"
    const [x, y] = punkt(v, e);
    if (st.werkzeug === 'radierer') { v.strich = { radieren: true, x, y }; radieren(v, [x, y]); return; }
    v.strich = { k: nzKennung(8), t: st.werkzeug, f: st.farbe, d: st.dicke, p: st.werkzeug === 'frei' ? [x, y] : [x, y, x, y] };
    vorschau(v);
  }
  function zeichnenWeiter(v, e) {
    if (v.zeiger !== e.pointerId || !v.strich) return;
    e.preventDefault();
    const folge = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of folge) {
      const [x, y] = punkt(v, ev);
      if (v.strich.radieren) {
        // Die ganze Strecke seit dem letzten Punkt abtasten — ein schneller Wischer meldet nur wenige Punkte
        const { x: x0, y: y0 } = v.strich, schritte = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / (4 / v.massstab)));
        radieren(v, Array.from({ length: schritte }, (_, i) => [x0 + (x - x0) * (i + 1) / schritte, y0 + (y - y0) * (i + 1) / schritte]).flat());
        v.strich.x = x; v.strich.y = y;
        continue;
      }
      const p = v.strich.p;
      if (v.strich.t === 'frei') {
        if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 1 && p.length < Z.MAX_ZAHLEN) p.push(x, y);
      } else { p[2] = x; p[3] = y; }
    }
    if (!v.strich.radieren) vorschau(v);
  }
  function zeichnenEnde(v, e) {
    if (v.zeiger !== e.pointerId) return;
    const strich = v.strich;
    v.zeiger = null; v.strich = null; v.jetzt.innerHTML = '';
    if (!strich || strich.radieren) return;
    if (strich.t === 'frei') strich.p = Z.ausduennen(strich.p, 0.6).map(Math.round);
    else if (Math.hypot(strich.p[2] - strich.p[0], strich.p[3] - strich.p[1]) < 3) return;   // nur getippt: keine Form
    if (!Z.strichOk(strich)) return;
    s.doc.transact(() => {
      const striche = flaecheSichern(v.id).get('s');
      if (striche.length < Z.MAX_STRICHE) striche.push([strich]);
    }, herkunft);
  }
  function zeichnenAbbrechen(v) {
    v.zeiger = null; v.strich = null; v.jetzt.innerHTML = '';
  }
  const vorschau = (v) => { v.jetzt.innerHTML = Z.strichSvg(v.strich); };

  // Radierer: ganze Striche, die man berührt (10 Bildschirmpunkte Spielraum). punkte = [x0, y0, x1, y1, …]
  function radieren(v, punkte) {
    const m = karte.get(v.id);
    const striche = m instanceof Y.Map ? m.get('s') : null;
    if (!striche) return;
    const alle = striche.toArray();
    const weg = [];
    alle.forEach((strich, i) => {
      const grenze = strich.d / 2 + 10 / v.massstab;
      for (let j = 0; j < punkte.length; j += 2) if (Z.abstand(strich, punkte[j], punkte[j + 1]) <= grenze) { weg.push(i); break; }
    });
    if (!weg.length) return;
    s.doc.transact(() => { for (const i of weg.reverse()) striche.delete(i, 1); }, herkunft);
  }

  // ─── Griffe: Größe (Ecke unten rechts) und Einzug (oben links) ─────────────────────────────
  function griffBinden(v, knopf, art) {
    let start = null;
    knopf.addEventListener('pointerdown', (e) => {
      if (!imZeichenmodus()) return;
      e.preventDefault(); e.stopPropagation();
      try { knopf.setPointerCapture(e.pointerId); } catch (_) {}
      start = { x: e.clientX, y: e.clientY, d: { ...v.d }, frei: platz(v) / v.massstab, id: e.pointerId };
      v.rahmen.classList.add('nz-zieht');
    });
    knopf.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = (e.clientX - start.x) / v.massstab, dy = (e.clientY - start.y) / v.massstab, d = start.d;
      const G = Z.GRENZEN, eng = (x, [a, b]) => Math.round(Math.min(b, Math.max(a, x)));
      // Nicht breiter, als die Zeile gerade Platz hat (sonst schrumpfte alles beim Ziehen) — außer sie war es schon
      const breiteste = Math.max(d.b, Math.floor(start.frei - d.e));
      if (art === 'groesse') v.vorlaeufig = { b: eng(Math.min(d.b + dx, breiteste), G.b), h: eng(d.h + dy, G.h) };
      else v.vorlaeufig = { e: eng(Math.min(d.e + dx, Math.max(d.e, start.frei - d.b)), G.e) };
      zeigen(v, false);
    });
    const ende = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const neu = v.vorlaeufig; start = null; v.vorlaeufig = null;
      v.rahmen.classList.remove('nz-zieht');
      if (!neu) return;
      rueck.stopCapturing();
      s.doc.transact(() => { const m = flaecheSichern(v.id); for (const [k, x] of Object.entries(neu)) m.set(k, x); }, herkunft);
      zeigen(v, false);
    };
    knopf.addEventListener('pointerup', ende);
    knopf.addEventListener('pointercancel', ende);
  }

  // Wo im Text steht die Fläche? (Index im gemeinsamen Text = Index in Quill)
  function stelleVon(id) {
    let i = 0;
    for (const op of text.toDelta()) {
      if (typeof op.insert === 'string') { i += op.insert.length; continue; }
      if (op.insert && op.insert.zeichnung === id) return i;
      i += 1;
    }
    return -1;
  }

  async function loeschen(v) {
    if (!imZeichenmodus()) return;
    const leerFlaeche = !(flaechenDaten(v.id) || leer()).s.length;
    if (!leerFlaeche && !(await confirmModal('Diese Zeichenfläche mit allem, was darauf gezeichnet ist, löschen? (Mit „Rückgängig" holst du sie zurück.)',
      { title: 'Zeichenfläche löschen', okLabel: 'Löschen' }))) return;
    const i = stelleVon(v.id);
    rueck.stopCapturing();
    s.doc.transact(() => { if (i >= 0) text.delete(i, 1); karte.delete(v.id); }, herkunft);
  }

  // ─── Neue Fläche ───────────────────────────────────────────────────────────────────────────
  // Unter der Zeile, in der der Cursor zuletzt stand; steht er in einer leeren Zeile, an ihrer Stelle
  // (die leere Zeile bleibt darunter zum Weiterschreiben). Ohne Cursor am Ende.
  function einfuegen() {
    if (!darfSchreiben()) return;
    if (karte.size >= Z.MAX_FLAECHEN) { toast(`Mehr als ${Z.MAX_FLAECHEN} Zeichenflächen passen nicht in eine Notiz.`, 'error'); return; }
    const q = s.quill;
    const laenge = q.getLength();
    const stelle = st.letzteStelle == null ? laenge - 1 : Math.min(st.letzteStelle, laenge - 1);
    const [zeile] = q.getLine(stelle);
    let pos = laenge;
    if (zeile) {
      const anfang = q.getIndex(zeile);
      const leereZeile = zeile.length() === 1 && zeile.statics.blotName !== 'zeichnung';
      pos = leereZeile ? anfang : anfang + zeile.length();
    }
    const breite = editorEl ? editorEl.querySelector('.ql-editor').clientWidth - 32 : 600;
    const b = Math.round(Math.min(Z.GRENZEN.b[1], Math.max(Z.GRENZEN.b[0], Math.min(breite, 1000))));
    const h = Math.round(Math.min(420, Math.max(160, b * 0.6)));
    const id = nzKennung(12);
    rueck.stopCapturing();
    s.doc.transact(() => {
      const m = new Y.Map(); m.set('b', b); m.set('h', h); m.set('e', 0); m.set('s', new Y.Array());
      karte.set(id, m);
      const ende = pos >= text.length;
      text.insertEmbed(Math.min(pos, text.length), { zeichnung: id });
      if (ende) text.insert(text.length, '\n');   // das Dokument endet immer mit einem Zeilenende
    }, herkunft);
    st.letzteStelle = pos + 1;
    requestAnimationFrame(() => {
      const el = editorEl && editorEl.querySelector(`.notiz-zeichnung[data-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // ─── Knopfleiste ──────────────────────────────────────────────────────────────────────────
  const knoepfe = (sel) => leiste ? [...leiste.querySelectorAll(sel)] : [];
  function leisteZeigen() {
    if (!leiste) return;
    leiste.classList.toggle('nz-im-zeichnen', st.modus === 'zeichnen');
    if (editorEl) {
      editorEl.classList.toggle('nz-zeichnen', imZeichenmodus());
      editorEl.classList.toggle('nz-hand', st.werkzeug === 'hand');
    }
    for (const b of knoepfe('.nz-modus-knopf')) b.setAttribute('aria-pressed', String(b.dataset.modus === st.modus));
    for (const b of knoepfe('[data-werkzeug]')) b.setAttribute('aria-pressed', String(b.dataset.werkzeug === st.werkzeug));
    for (const b of knoepfe('.nz-farbe')) b.setAttribute('aria-pressed', String(b.dataset.farbe === st.farbe));
    for (const b of knoepfe('.nz-dicke')) b.setAttribute('aria-pressed', String(Number(b.dataset.dicke) === st.dicke));
    const punktEl = leiste.querySelector('.nz-stift-punkt');
    if (punktEl) { punktEl.style.background = Z.FARBEN[st.farbe]; const g = 6 + st.dicke * 1.5; punktEl.style.width = punktEl.style.height = g + 'px'; }
    const sk = leiste.querySelector('.nz-stift-knopf');
    if (sk) { const t = `Farbe und Dicke: ${NZ_FARBNAMEN[st.farbe]}, ${NZ_DICKEN[st.dicke]}`; sk.title = t; sk.setAttribute('aria-label', t); }
    rueckKnoepfe();
  }
  function rueckKnoepfe() {
    for (const b of knoepfe('[data-akt="rueckgaengig"]')) b.disabled = !rueck.undoStack.length;
    for (const b of knoepfe('[data-akt="wiederholen"]')) b.disabled = !rueck.redoStack.length;
  }
  rueck.on('stack-item-added', rueckKnoepfe);
  rueck.on('stack-item-popped', rueckKnoepfe);
  rueck.on('stack-cleared', rueckKnoepfe);

  function modusSetzen(modus) {
    if (modus === 'zeichnen' && !darfSchreiben()) modus = 'text';
    const vorher = st.modus;
    st.modus = modus;
    if (modus === 'zeichnen') {
      const r = s.quill.getSelection();
      if (r) st.letzteStelle = r.index;
      s.quill.blur();
      s.quill.enable(false);
      // Noch keine Fläche in der Notiz? Dann gleich eine — umschalten heißt „ich will zeichnen".
      if (vorher !== 'zeichnen' && !text.toDelta().some(op => typeof op.insert !== 'string')) einfuegen();
    } else {
      stiftWahlZu();
      s.quill.enable(darfSchreiben());
    }
    leisteZeigen();
  }

  function stiftWahlZu() {
    const wahl = leiste && leiste.querySelector('.nz-stift-wahl');
    if (wahl) wahl.hidden = true;
    const k = leiste && leiste.querySelector('.nz-stift-knopf');
    if (k) k.setAttribute('aria-expanded', 'false');
  }
  const stiftMerken = () => { try { localStorage.setItem('notiz-stift', JSON.stringify({ farbe: st.farbe, dicke: st.dicke })); } catch (_) {} };

  const knopf = (b) => {
    if (b.dataset.modus) { modusSetzen(b.dataset.modus); return; }
    if (b.dataset.werkzeug) { st.werkzeug = b.dataset.werkzeug; leisteZeigen(); return; }
    if (b.classList.contains('nz-stift-knopf')) {
      const wahl = leiste.querySelector('.nz-stift-wahl');
      wahl.hidden = !wahl.hidden;
      b.setAttribute('aria-expanded', String(!wahl.hidden));
      if (!wahl.hidden) {
        // Unter dem Knopf, aber nie über den rechten Rand der Leiste hinaus (am Handy steht der Knopf mittendrin)
        const lb = leiste.getBoundingClientRect(), kb = b.getBoundingClientRect();
        wahl.style.top = Math.round(kb.bottom - lb.top + 4) + 'px';
        wahl.style.left = Math.round(Math.max(8, Math.min(kb.left - lb.left, lb.width - wahl.offsetWidth - 8))) + 'px';
      }
      return;
    }
    if (b.dataset.farbe) {
      st.farbe = b.dataset.farbe;
      if (st.werkzeug === 'radierer' || st.werkzeug === 'hand') st.werkzeug = 'frei';   // Farbe gewählt = zeichnen wollen
      stiftMerken(); leisteZeigen(); return;
    }
    if (b.dataset.dicke) {
      st.dicke = Number(b.dataset.dicke);
      if (st.werkzeug === 'radierer' || st.werkzeug === 'hand') st.werkzeug = 'frei';
      stiftMerken(); stiftWahlZu(); leisteZeigen(); return;
    }
    if (b.dataset.akt === 'rueckgaengig') { rueck.undo(); return; }
    if (b.dataset.akt === 'wiederholen') { rueck.redo(); return; }
    if (b.dataset.akt === 'neu') { einfuegen(); }
  };
  const tippenAus = leiste ? nzTippen(leiste, knopf) : () => {};
  // Farbwahl schließt beim Tippen daneben
  const daneben = (e) => {
    const g = leiste && leiste.querySelector('.nz-stift-gruppe');
    if (g && !g.contains(e.target)) stiftWahlZu();
  };
  document.addEventListener('pointerdown', daneben, true);
  // Tastatur im Zeichenmodus: Strg+Z / Strg+Umschalt+Z / Strg+Y, Esc zurück zum Text
  const tasten = (e) => {
    if (st.modus !== 'zeichnen') return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const strg = e.ctrlKey || e.metaKey;
    if (strg && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) rueck.redo(); else rueck.undo(); }
    else if (strg && e.key.toLowerCase() === 'y') { e.preventDefault(); rueck.redo(); }
    else if (e.key === 'Escape') modusSetzen('text');
  };
  document.addEventListener('keydown', tasten);
  // Wo stand der Cursor zuletzt? (Dort kommt eine neue Fläche hin)
  s.quill.on('selection-change', (r) => { if (r && st.modus === 'text') st.letzteStelle = r.index; });
  leisteZeigen();

  const steuerung = {
    an, ab, einfuegen, modusSetzen,
    get modus() { return st.modus; },
    // Leserecht kam oder ging (zugriffSetzen in notiz-sitzung.js)
    zugriffGeaendert() { if (!darfSchreiben() && st.modus === 'zeichnen') modusSetzen('text'); else leisteZeigen(); },
    beenden() {
      st.offen = false;
      karte.unobserveDeep(beobachter);
      groesse.disconnect();
      document.removeEventListener('pointerdown', daneben, true);
      document.removeEventListener('keydown', tasten);
      tippenAus();
      try { rueck.destroy(); } catch (_) {}
      ansichten.clear();
      if (_nzSitzung === steuerung) _nzSitzung = null;
    },
  };
  _nzSitzung = steuerung;
  return steuerung;
}
