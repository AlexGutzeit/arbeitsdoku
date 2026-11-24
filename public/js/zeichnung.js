// Zeichenflächen in Notizen (Alex, 24.11.2026) — was eine Zeichnung ist und wie sie aussieht.
//
// EINE Datei für Browser und Server: Im Browser ein klassisches Skript (window.NotizZeichnung), auf dem
// Server per require (notiz-dokument.js prüft damit, notiz-export.js zeichnet damit PDF/Word/ODT). So
// sehen Schreibfeld, Vorschau, Druck und Dateien gleich aus, und der Server lässt genau das durch, was
// die Knopfleiste anbieten kann.
//
// Eine Zeichnung steht im gemeinsamen Dokument der Notiz:
//   * im Text als Block an ihrer Stelle:  { insert: { zeichnung: '<id>' } }
//   * ihr Inhalt in der Karte 'zeichnungen':  id → Y.Map { b, h, e, s }
//       b, h  Breite und Höhe in Einheiten (1 Einheit = 1 Bildschirmpunkt bei voller Größe)
//       e     Einzug von links, ebenfalls in Einheiten
//       s     Y.Array der Striche, je Strich ein schlichtes Objekt:
//             { k: Kennung, t: 'frei'|'linie'|'pfeil'|'kasten'|'kreis', f: Farbname, d: Dicke, p: [x0, y0, x1, y1, …] }
//             Bei Formen sind es genau zwei Punkte (Anfang, Ende), bei 'frei' die ganze Spur.
// Ist die Fläche breiter als der Platz (Handy), wird sie samt Einzug verkleinert angezeigt — gezeichnet
// wird immer in Einheiten, darum sieht sie auf jedem Gerät gleich aus.
'use strict';
(function (wurzel) {
  // Farbe der Striche: Schwarz (Schriftfarbe der App) und dieselben sechs Farben wie bei der Schrift
  const FARBEN = { schwarz: '#1e293b', rot: '#dc2626', orange: '#c2410c', gruen: '#15803d', blau: '#1d4ed8', lila: '#7e22ce', grau: '#6b7280' };
  const ARTEN = ['frei', 'linie', 'pfeil', 'kasten', 'kreis'];
  const DICKEN = [2, 4, 8];   // dünn, mittel, dick
  const GRENZEN = { b: [80, 2000], h: [60, 3000], e: [0, 1500] };
  const MAX_STRICHE = 3000;      // je Fläche
  const MAX_ZAHLEN = 4000;       // Koordinaten je Strich (2000 Punkte)
  const MAX_FLAECHEN = 200;      // je Notiz
  const KOORDINATE = [-500, 3500];
  const ID = /^[a-z0-9]{6,24}$/;
  const STRICH_ID = /^[a-z0-9]{4,16}$/;
  const ganz = (x) => Number.isInteger(x);
  const zwischen = (x, [a, b]) => ganz(x) && x >= a && x <= b;
  const eng = (x, [a, b]) => Math.min(b, Math.max(a, Math.round(Number(x) || 0)));

  /** Ist das ein zulässiger Strich? (Server-Prüfung — streng, alles andere ist ein manipulierter Browser) */
  function strichOk(st) {
    if (!st || typeof st !== 'object' || Array.isArray(st) || Object.getPrototypeOf(st) !== Object.prototype) return false;
    const schluessel = Object.keys(st);
    if (schluessel.length !== 5 || !['k', 't', 'f', 'd', 'p'].every(k => schluessel.includes(k))) return false;
    if (typeof st.k !== 'string' || !STRICH_ID.test(st.k)) return false;
    if (!ARTEN.includes(st.t) || !Object.prototype.hasOwnProperty.call(FARBEN, st.f) || !DICKEN.includes(st.d)) return false;
    const p = st.p;
    if (!Array.isArray(p) || p.length % 2 || p.length < 2 || p.length > MAX_ZAHLEN) return false;
    if (st.t !== 'frei' && p.length !== 4) return false;
    return p.every(x => zwischen(x, KOORDINATE));
  }

  /** Größe/Einzug zulässig? */
  const massOk = (b, h, e) => zwischen(b, GRENZEN.b) && zwischen(h, GRENZEN.h) && zwischen(e, GRENZEN.e);

  /** Eine Zeichnung aus fremden Daten (gespeicherte Vorschau, Kopie) — nur Zulässiges bleibt übrig */
  function bereinigt(z) {
    z = z && typeof z === 'object' ? z : {};
    return {
      b: eng(z.b ?? 600, GRENZEN.b), h: eng(z.h ?? 300, GRENZEN.h), e: eng(z.e ?? 0, GRENZEN.e),
      s: (Array.isArray(z.s) ? z.s : []).filter(strichOk).slice(0, MAX_STRICHE),
    };
  }

  // ─── Aussehen ────────────────────────────────────────────────────────────────────────────────

  /** Spitze eines Pfeils: drei Punkte (Spitze, links, rechts), passend zur Dicke */
  function pfeilSpitze(x0, y0, x1, y1, d) {
    const lang = Math.max(12, d * 4), w = Math.atan2(y1 - y0, x1 - x0), a = Math.PI / 7;
    return [[x1, y1], [x1 - lang * Math.cos(w - a), y1 - lang * Math.sin(w - a)], [x1 - lang * Math.cos(w + a), y1 - lang * Math.sin(w + a)]];
  }

  const r1 = (x) => Math.round(x * 10) / 10;
  /** Freihand-Spur als geglätteter SVG-Pfad (Kurven durch die Mitten zwischen den Punkten) */
  function freiPfad(p) {
    if (p.length <= 2) return `M${p[0]} ${p[1]}l0 0`;   // ein Tupfer
    if (p.length === 4) return `M${p[0]} ${p[1]}L${p[2]} ${p[3]}`;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) {
      d += `Q${p[i]} ${p[i + 1]} ${r1((p[i] + p[i + 2]) / 2)} ${r1((p[i + 1] + p[i + 3]) / 2)}`;
    }
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
  }

  /** Ein Strich als SVG-Element (Text). Werte nur aus der festen Liste bzw. als Zahl — nie fremder Text. */
  function strichSvg(st) {
    const farbe = FARBEN[st.f] || FARBEN.schwarz, d = Number(st.d) || 2;
    const p = st.p.map(Number);
    const stil = `fill="none" stroke="${farbe}" stroke-width="${d}" stroke-linecap="round" stroke-linejoin="round"`;
    if (st.t === 'frei') return `<path d="${freiPfad(p)}" ${stil}/>`;
    const [x0, y0, x1, y1] = p;
    if (st.t === 'linie') return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" ${stil}/>`;
    if (st.t === 'pfeil') {
      const sp = pfeilSpitze(x0, y0, x1, y1, d);
      return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" ${stil}/>`
        + `<polygon points="${sp.map(([x, y]) => r1(x) + ',' + r1(y)).join(' ')}" fill="${farbe}" stroke="${farbe}" stroke-width="${d}" stroke-linejoin="round"/>`;
    }
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (st.t === 'kasten') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${stil}/>`;
    if (st.t === 'kreis') return `<ellipse cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" rx="${r1(w / 2)}" ry="${r1(h / 2)}" ${stil}/>`;
    return '';
  }

  /** Die ganze Zeichnung als <svg> (Text): Vorschau, Druck und — auf dem Server — Bild für Word/ODT */
  function svg(z, { pixelBreite } = {}) {
    const { b, h, s } = bereinigt(z);
    const groesse = pixelBreite ? ` width="${pixelBreite}" height="${Math.round(pixelBreite * h / b)}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${b} ${h}"${groesse} preserveAspectRatio="xMinYMin meet">`
      + s.map(strichSvg).join('') + '</svg>';
  }

  // ─── Treffer (Radierer) ──────────────────────────────────────────────────────────────────────

  /** Ein Strich als Linienzug (Formen umgerechnet) — zum Treffen mit dem Radierer */
  function linienzug(st) {
    const p = st.p;
    if (st.t === 'frei' || st.t === 'linie') return p;
    const [x0, y0, x1, y1] = p;
    if (st.t === 'pfeil') { const sp = pfeilSpitze(x0, y0, x1, y1, st.d); return [x0, y0, x1, y1, sp[1][0], sp[1][1], x1, y1, sp[2][0], sp[2][1]]; }
    if (st.t === 'kasten') return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2, aus = [];
    for (let i = 0; i <= 36; i++) { const w = i / 36 * 2 * Math.PI; aus.push(cx + rx * Math.cos(w), cy + ry * Math.sin(w)); }
    return aus;
  }

  /** Abstand eines Punkts zum Strich (in Einheiten) */
  function abstand(st, x, y) {
    const p = linienzug(st);
    if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y);
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
    }
    return best;
  }

  /** Spur ausdünnen (Ramer-Douglas-Peucker): weniger Punkte, gleiche Form — hält die Notiz klein */
  function ausduennen(p, toleranz = 0.8) {
    const n = p.length / 2;
    if (n <= 2) return p.slice();
    const behalten = new Uint8Array(n); behalten[0] = behalten[n - 1] = 1;
    const stapel = [[0, n - 1]];
    while (stapel.length) {
      const [a, b] = stapel.pop();
      const ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * b], by = p[2 * b + 1];
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
      let max = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const dd = Math.abs(dy * p[2 * i] - dx * p[2 * i + 1] + bx * ay - by * ax) / l;
        if (dd > max) { max = dd; idx = i; }
      }
      if (max > toleranz && idx > 0) { behalten[idx] = 1; stapel.push([a, idx], [idx, b]); }
    }
    const aus = [];
    for (let i = 0; i < n; i++) if (behalten[i]) aus.push(p[2 * i], p[2 * i + 1]);
    return aus;
  }

  const api = { FARBEN, ARTEN, DICKEN, GRENZEN, MAX_STRICHE, MAX_ZAHLEN, MAX_FLAECHEN, ID, STRICH_ID,
    strichOk, massOk, bereinigt, pfeilSpitze, freiPfad, strichSvg, svg, linienzug, abstand, ausduennen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else wurzel.NotizZeichnung = api;
})(typeof window !== 'undefined' ? window : globalThis);
