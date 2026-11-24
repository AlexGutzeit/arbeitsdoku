// Notiz als Datei: PDF, Word (.docx), OpenDocument (.odt) — Etappe B der Live-Notizen (27.09.2026).
//
// Alle drei Formate entstehen aus demselben Zwischenschritt: der Formatierung der Notiz (Quill-Delta,
// `body_delta` bzw. der Stand einer gerade offenen Notiz) als Liste von Zeilen mit Textstücken.
// Kopf überall gleich (Alex): Titel und darunter klein „Stand: TT.MM.JJJJ, HH:MM".
//
//   * PDF mit pdfkit und eingebetteter DejaVu Sans: Die eingebauten PDF-Schriften (Helvetica)
//     können nur Westeuropäisch — „→", „✓" oder „☐" würden zu Zeichensalat. Emojis hat auch
//     DejaVu nicht; sie werden durch „□" ersetzt statt still zu verschwinden.
//   * DOCX und ODT ohne zusätzliche Bibliothek: Beides sind Zip-Dateien mit XML, gepackt mit dem
//     ohnehin vorhandenen archiver. Geprüft wird in den Tests, indem LibreOffice sie öffnet.
//
// Diese Datei gehoert in die feste Dateiliste von deploy.sh (STAMMDATEIEN, aus Git abgeleitet).
'use strict';
const path = require('path');
const { ZipArchive } = require('archiver');
const PDFDocument = require('pdfkit');
const { ZONE } = require('./zeit');
const sharp = require('sharp');
const { FARBEN, GROESSEN } = require('./notiz-dokument');
const Z = require('./public/js/zeichnung');

// Zeichenflächen (24.11.2026): Im Schreibfeld ist 1 Einheit = 1 Bildschirmpunkt bei 16-px-Schrift; die
// Dateien haben 11 pt. Im selben Verhältnis umgerechnet steht eine Zeichnung zum Text wie am Bildschirm —
// ist sie dafür zu breit (oder zu hoch), wird sie auf die Seite verkleinert.
const PT_JE_EINHEIT = 11 / 16;
const SATZBREITE_PT = 481.9;   // A4 mit 2 cm Rand (Word/ODT); das PDF rechnet mit seiner eigenen Breite
const massstab = (z, breite, hoehe = Infinity) => Math.min(PT_JE_EINHEIT, breite / (z.b + z.e), hoehe / z.h);
/** Zeichnung als PNG (Word/ODT können kein eingebettetes SVG verlässlich) — doppelt aufgelöst, höchstens 4000 px */
function zeichnungPng(z) {
  const f = Math.min(2, 4000 / Math.max(z.b, z.h));
  return sharp(Buffer.from(Z.svg(z, { pixelBreite: Math.round(z.b * f) }))).png().toBuffer();
}

// Erst beim ersten PDF aufgelöst: Fehlt das Schriftpaket, scheitert nur das PDF (mit Meldung) — nicht
// der Start des Servers, der diese Datei über routes/notes.js schon beim Hochfahren lädt.
const schriften = () => path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

// ─── Gemeinsamer Zwischenschritt ─────────────────────────────────────────────────────────────

/** Delta (JSON-Text) → [{ teile: [{ t, bold, italic, underline, strike, farbe, faktor }], liste: null|'bullet'|'ordered'|'checked'|'unchecked', nr }]
 *  farbe: '#rrggbb' oder null (Standard), faktor: Schriftgröße relativ zur Grundschrift (1 = normal).
 *  Eine Zeichenfläche ist eine eigene Zeile { zeichnung: { b, h, e, s } } — leere Flächen fallen weg. */
function zeilen(deltaJson, klartext) {
  let ops = null;
  try { ops = JSON.parse(deltaJson || ''); } catch (_) { /* Rückfall auf Klartext */ }
  if (!Array.isArray(ops)) ops = [{ insert: String(klartext || '') + '\n' }];
  const aus = []; let teile = [];
  for (const op of ops) {
    if (typeof op.insert !== 'string') {
      const z = op.insert && op.insert.zeichnung;
      if (z && typeof z === 'object') {
        if (teile.length) { aus.push({ teile, liste: null }); teile = []; }
        const d = Z.bereinigt(z);
        if (d.s.length) aus.push({ zeichnung: d, teile: [], liste: null });
      }
      continue;
    }
    const a = op.attributes || {};
    op.insert.split('\n').forEach((t, i, alle) => {
      if (t) teile.push({ t, bold: !!a.bold, italic: !!a.italic, underline: !!a.underline, strike: !!a.strike,
        farbe: Object.hasOwn(FARBEN, a.color) ? FARBEN[a.color] : null, faktor: Object.hasOwn(GROESSEN, a.size) ? GROESSEN[a.size] : 1 });
      if (i < alle.length - 1) {
        const liste = ['bullet', 'ordered', 'checked', 'unchecked'].includes(a.list) ? a.list : null;
        aus.push({ teile, liste }); teile = [];
      }
    });
  }
  if (teile.length) aus.push({ teile, liste: null });
  // Nummerierung: jede zusammenhängende nummerierte Liste beginnt bei 1
  let n = 0;
  for (const z of aus) { if (z.liste === 'ordered') z.nr = ++n; else n = 0; }
  return aus;
}

/** „27.09.2026, 14:32" in deutscher Ortszeit */
function standText(d = new Date()) {
  return d.toLocaleString('de-DE', { timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** „Material Montag – Stand 2026-09-27 14-32.pdf" — ohne Zeichen, die Windows im Dateinamen verbietet */
function dateiname(titel, endung, d = new Date()) {
  const iso = d.toLocaleString('sv-SE', { timeZone: ZONE }).slice(0, 16).replace(':', '-');
  const sauber = String(titel || 'Notiz').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Notiz';
  return `${sauber} – Stand ${iso}.${endung}`;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────────────────────

function pdf({ titel, deltaJson, klartext, stand }) {
  return new Promise((fertig, fehler) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true,
      info: { Title: titel, Creator: 'Arbeitsdoku' } });
    const stuecke = [];
    doc.on('data', b => stuecke.push(b));
    doc.on('end', () => fertig(Buffer.concat(stuecke)));
    doc.on('error', fehler);
    const SCHRIFTEN = schriften();
    doc.registerFont('R', path.join(SCHRIFTEN, 'DejaVuSans.ttf'));
    doc.registerFont('B', path.join(SCHRIFTEN, 'DejaVuSans-Bold.ttf'));
    doc.registerFont('I', path.join(SCHRIFTEN, 'DejaVuSans-Oblique.ttf'));
    doc.registerFont('BI', path.join(SCHRIFTEN, 'DejaVuSans-BoldOblique.ttf'));

    // Zeichen, die die Schrift nicht hat (Emojis), sichtbar ersetzen statt Zeichensalat
    doc.font('R');
    const hat = (() => { try { const f = doc._font.font; return (cp) => f.hasGlyphForCodePoint(cp); } catch (_) { return () => true; } })();
    const lesbar = (s) => Array.from(s).map(ch => (hat(ch.codePointAt(0)) ? ch : '□')).join('');

    const links = doc.page.margins.left, breite = doc.page.width - links - doc.page.margins.right;
    const unten = () => doc.page.height - doc.page.margins.bottom;
    const TEXT = '#1e293b', LEISE = '#6b7280', GROESSE = 11;

    doc.font('B').fontSize(18).fillColor(TEXT).text(lesbar(titel), links, doc.page.margins.top, { width: breite });
    doc.moveDown(0.2);
    doc.font('R').fontSize(9).fillColor(LEISE).text('Stand: ' + stand, { width: breite });
    doc.moveDown(1);

    for (const z of zeilen(deltaJson, klartext)) {
      if (z.zeichnung) { pdfZeichnung(doc, z.zeichnung, links, breite, unten); continue; }
      const einzug = z.liste ? 22 : 0;
      doc.font('R').fontSize(GROESSE);
      const groesste = Math.max(1, ...z.teile.map(t => t.faktor));
      const zeilenHoehe = doc.currentLineHeight(true) * groesste + 2;
      if (doc.y + zeilenHoehe > unten()) doc.addPage();
      const y = doc.y;
      if (z.liste === 'bullet') doc.fillColor(TEXT).text('•', links + 6, y, { lineBreak: false });
      if (z.liste === 'ordered') doc.fillColor(TEXT).text(z.nr + '.', links, y, { width: 18, align: 'right', lineBreak: false });
      if (z.liste === 'checked' || z.liste === 'unchecked') {
        const k = 9, kx = links + 4, ky = y + 2;
        doc.lineWidth(0.9).strokeColor(z.liste === 'checked' ? LEISE : TEXT).rect(kx, ky, k, k).stroke();
        if (z.liste === 'checked') doc.lineWidth(1.3).moveTo(kx + 2, ky + 4.8).lineTo(kx + 4, ky + 7).lineTo(kx + 7.6, ky + 1.8).stroke();
      }
      const erledigt = z.liste === 'checked';
      if (!z.teile.length) {
        doc.font('R').fillColor(TEXT).text(' ', links + einzug, y, { width: breite - einzug, lineGap: 2 });
      } else {
        // Verschiedene Schriftgrößen in einer Zeile: pdfkit setzt jedes Stück oben an die Zeile — kleine
        // Schrift hinge dann hochgestellt neben großer, und die nächste Zeile rückte nur um die Höhe des
        // LETZTEN Stücks weiter (lief in die große Schrift hinein). Deshalb jedes Stück so weit nach unten,
        // dass alle auf derselben Grundlinie stehen, und am Ende um die größte Zeilenhöhe weiter.
        const schriftVon = (t) => t.bold && t.italic ? 'BI' : t.bold ? 'B' : t.italic ? 'I' : 'R';
        const mass = z.teile.map(t => { doc.font(schriftVon(t)).fontSize(GROESSE * t.faktor);
          return { oben: doc._font.ascender / 1000 * doc._fontSize, hoehe: doc.currentLineHeight(true) + 2 }; });
        const grundlinie = Math.max(...mass.map(m => m.oben)), hoechste = Math.max(...mass.map(m => m.hoehe));
        let zeilenOben = y;
        z.teile.forEach((teil, i) => {
          const versatz = grundlinie - mass[i].oben, weiter = i < z.teile.length - 1;
          const optionen = { width: breite - einzug, lineGap: 2, continued: weiter,
            underline: teil.underline, strike: erledigt || teil.strike };
          doc.font(schriftVon(teil)).fontSize(GROESSE * teil.faktor).fillColor(erledigt ? LEISE : (teil.farbe || TEXT));
          if (i === 0) doc.text(lesbar(teil.t), links + einzug, y + versatz, optionen);
          else { doc.y = zeilenOben + versatz; doc.text(lesbar(teil.t), optionen); }
          // Nach einem Stück mit „continued" steht doc.y oben an der Zeile, in der es endet (ggf. umgebrochen);
          // nach dem letzten unter dessen eigener Zeile.
          zeilenOben = weiter ? doc.y - versatz : doc.y - mass[i].hoehe - versatz;
        });
        doc.y = zeilenOben + hoechste;
      }
      doc.moveDown(0.25);
    }

    // Seitenzahlen, wenn es mehr als eine Seite ist
    const seiten = doc.bufferedPageRange();
    if (seiten.count > 1) {
      for (let i = 0; i < seiten.count; i++) {
        doc.switchToPage(seiten.start + i);
        const alt = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        doc.font('R').fontSize(8).fillColor(LEISE).text(`Seite ${i + 1} von ${seiten.count}`, links, doc.page.height - 40, { width: breite, align: 'right', lineBreak: false });
        doc.page.margins.bottom = alt;
      }
    }
    doc.end();
  });
}

/** Zeichenfläche als Vektorgrafik ins PDF — dieselben Formen wie im SVG (zeichnung.js) */
function pdfZeichnung(doc, z, links, breite, unten) {
  const m = massstab(z, breite, doc.page.height - doc.page.margins.top - doc.page.margins.bottom);
  if (doc.y + z.h * m > unten()) doc.addPage();
  const x0 = links + z.e * m, y0 = doc.y + 2;
  doc.save();
  doc.rect(x0, y0, z.b * m, z.h * m).clip();
  doc.translate(x0, y0).scale(m);
  for (const st of z.s) {
    const farbe = Z.FARBEN[st.f], p = st.p;
    doc.lineWidth(st.d).strokeColor(farbe).fillColor(farbe).lineCap('round').lineJoin('round');
    const [x0s, y0s, x1, y1] = p;
    if (st.t === 'frei') doc.path(Z.freiPfad(p)).stroke();
    else if (st.t === 'linie') doc.moveTo(x0s, y0s).lineTo(x1, y1).stroke();
    else if (st.t === 'pfeil') {
      doc.moveTo(x0s, y0s).lineTo(x1, y1).stroke();
      doc.polygon(...Z.pfeilSpitze(x0s, y0s, x1, y1, st.d)).fillAndStroke(farbe, farbe);
    } else if (st.t === 'kasten') doc.rect(Math.min(x0s, x1), Math.min(y0s, y1), Math.abs(x1 - x0s), Math.abs(y1 - y0s)).stroke();
    else if (st.t === 'kreis') doc.ellipse((x0s + x1) / 2, (y0s + y1) / 2, Math.abs(x1 - x0s) / 2, Math.abs(y1 - y0s) / 2).stroke();
  }
  doc.restore();
  doc.x = links;
  doc.y = y0 + z.h * m + 6;
}

// ─── Zip-Hilfe (DOCX, ODT) ───────────────────────────────────────────────────────────────────

function zip(dateien) {
  return new Promise((fertig, fehler) => {
    const a = new ZipArchive({ zlib: { level: 9 } });
    const stuecke = [];
    a.on('data', b => stuecke.push(b));
    a.on('end', () => fertig(Buffer.concat(stuecke)));
    a.on('error', fehler);
    for (const d of dateien) a.append(d.inhalt, { name: d.name, store: !!d.unkomprimiert });
    a.finalize();
  });
}

// XML-Text: Sonderzeichen maskieren, in XML verbotene Steuerzeichen entfernen
const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HAKEN = { checked: '☑', unchecked: '☐' };   // ☑ ☐

// ─── DOCX ────────────────────────────────────────────────────────────────────────────────────

async function docx({ titel, deltaJson, klartext, stand, jetzt = new Date() }) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const NS_BILD = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const alle = zeilen(deltaJson, klartext);
  // Zeichnungen als Bilder: word/media/zeichnungN.png, je eine Beziehung rIdZN
  const bilder = [];
  for (const z of alle) if (z.zeichnung) { z.bildNr = bilder.length + 1; bilder.push(await zeichnungPng(z.zeichnung)); }
  const bildAbsatz = (z) => {
    const d = z.zeichnung, m = massstab(d, SATZBREITE_PT, 700), n = z.bildNr;
    const cx = Math.round(d.b * m * 12700), cy = Math.round(d.h * m * 12700);
    return `<w:p><w:pPr>${d.e ? `<w:ind w:left="${Math.round(d.e * m * 20)}"/>` : ''}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Zeichnung ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="zeichnung${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="rIdZ${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`
      + `</wp:inline></w:drawing></w:r></w:p>`;
  };
  // Jede nummerierte Liste bekommt eine eigene Nummerierung, damit sie wieder bei 1 beginnt
  let listen = 0; const nums = [];
  for (let i = 0; i < alle.length; i++) {
    if (alle[i].liste === 'ordered' && (i === 0 || alle[i - 1].liste !== 'ordered')) { listen++; nums.push(2 + listen); }
    if (alle[i].liste === 'ordered') alle[i].numId = 2 + listen;
  }
  // Die Reihenfolge in <w:rPr> schreibt das Format vor (rFonts, b, i, strike, color, sz, u) — Word ist da strenger als LibreOffice
  const lauf = (text, { bold, italic, underline, strike, farbe, faktor = 1, erledigt, symbol } = {}) => {
    const sz = Math.round(22 * faktor);
    return `<w:r><w:rPr>${symbol ? '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:eastAsia="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>' : ''}`
      + `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${strike || erledigt ? '<w:strike/>' : ''}`
      + `${erledigt ? '<w:color w:val="6B7280"/>' : farbe ? `<w:color w:val="${farbe.slice(1).toUpperCase()}"/>` : ''}`
      + `${faktor !== 1 ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}${underline ? '<w:u w:val="single"/>' : ''}`
      + `</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  };
  const absaetze = alle.map(z => {
    if (z.zeichnung) return bildAbsatz(z);
    const erledigt = z.liste === 'checked';
    let pPr = '';
    if (z.liste === 'bullet') pPr = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
    else if (z.liste === 'ordered') pPr = `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${z.numId}"/></w:numPr></w:pPr>`;
    else if (HAKEN[z.liste]) pPr = '<w:pPr><w:ind w:left="357" w:hanging="357"/></w:pPr>';
    const haken = HAKEN[z.liste] ? lauf(HAKEN[z.liste] + ' ', { symbol: true, erledigt: false }) : '';
    return `<w:p>${pPr}${haken}${z.teile.map(t => lauf(t.t, { ...t, erledigt })).join('')}</w:p>`;
  }).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${NS_BILD}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${lauf(titel)}</w:p>
<w:p><w:pPr><w:pStyle w:val="Stand"/></w:pPr>${lauf('Stand: ' + stand)}</w:p>
${absaetze}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Stand"><w:name w:val="Stand"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
</w:styles>`;
  const nummer = (id, abstrakt) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstrakt}"/>${abstrakt === 1 ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="357" w:hanging="357"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="357" w:hanging="357"/></w:pPr></w:lvl></w:abstractNum>
${nummer(1, 0)}${nums.map(id => nummer(id, 1)).join('')}
</w:numbering>`;
  const iso = jetzt.toISOString().replace(/\.\d+Z$/, 'Z');
  return zip([
    { name: '[Content_Types].xml', inhalt: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>` },
    { name: '_rels/.rels', inhalt: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
    { name: 'word/_rels/document.xml.rels', inhalt: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${bilder.map((_, i) => `<Relationship Id="rIdZ${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/zeichnung${i + 1}.png"/>`).join('\n')}
</Relationships>` },
    { name: 'word/document.xml', inhalt: document },
    { name: 'word/styles.xml', inhalt: styles },
    { name: 'word/numbering.xml', inhalt: numbering },
    ...bilder.map((png, i) => ({ name: `word/media/zeichnung${i + 1}.png`, inhalt: png })),
    { name: 'docProps/core.xml', inhalt: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(titel)}</dc:title><dc:creator>Arbeitsdoku</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>` },
  ]);
}

// ─── ODT ─────────────────────────────────────────────────────────────────────────────────────

async function odt({ titel, deltaJson, klartext, stand, jetzt = new Date() }) {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    + 'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    + 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  // Zeichenformate nach Bedarf: T_b, T_i, T_u, T_s, T_bi … und x für „erledigt" (durchgestrichen, grau),
  // dazu _<Farbwert> und _g<Faktor> (T_bs_dc2626_g15)
  const zeichen = new Map();
  const zeichenStil = (t, erledigt) => {
    const name = 'T_' + (t.bold ? 'b' : '') + (t.italic ? 'i' : '') + (t.underline ? 'u' : '') + (t.strike ? 's' : '') + (erledigt ? 'x' : '')
      + (t.farbe && !erledigt ? '_' + t.farbe.slice(1) : '') + (t.faktor && t.faktor !== 1 ? '_g' + String(t.faktor).replace('.', '') : '');
    if (name === 'T_') return null;
    const farbe = erledigt ? '#6b7280' : t.farbe;
    if (!zeichen.has(name)) zeichen.set(name, `<style:style style:name="${name}" style:family="text"><style:text-properties`
      + (t.bold ? ' fo:font-weight="bold"' : '') + (t.italic ? ' fo:font-style="italic"' : '')
      + (t.underline ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : '')
      + (erledigt || t.strike ? ' style:text-line-through-style="solid"' : '') + (farbe ? ` fo:color="${farbe}"` : '')
      + (t.faktor && t.faktor !== 1 ? ` fo:font-size="${11 * t.faktor}pt"` : '') + '/></style:style>');
    return name;
  };
  const inhalt = (z) => {
    const erledigt = z.liste === 'checked';
    const haken = HAKEN[z.liste] ? xml(HAKEN[z.liste] + ' ') : '';
    return haken + z.teile.map(t => { const s = zeichenStil(t, erledigt); const x = xml(t.t);
      return s ? `<text:span text:style-name="${s}">${x}</text:span>` : x; }).join('');
  };
  const alle = zeilen(deltaJson, klartext);
  // Zeichnungen als Bilder (Pictures/zeichnungN.png), je ein Absatz mit eigenem Einzug
  const bilder = [], bildStile = [];
  for (const z of alle) if (z.zeichnung) { z.bildNr = bilder.length + 1; bilder.push(await zeichnungPng(z.zeichnung)); }
  const bildAbsatz = (z) => {
    const d = z.zeichnung, m = massstab(d, SATZBREITE_PT, 700), n = z.bildNr;
    bildStile.push(`<style:style style:name="P_bild${n}" style:family="paragraph"><style:paragraph-properties fo:margin-left="${(d.e * m).toFixed(2)}pt" fo:margin-bottom="0.14cm"/></style:style>`);
    return `<text:p text:style-name="P_bild${n}"><draw:frame draw:name="Zeichnung ${n}" text:anchor-type="as-char" svg:width="${(d.b * m).toFixed(2)}pt" svg:height="${(d.h * m).toFixed(2)}pt" draw:z-index="0">`
      + `<draw:image xlink:href="Pictures/zeichnung${n}.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`;
  };
  let koerper = '', offen = null;
  const zu = () => { if (offen) { koerper += '</text:list>'; offen = null; } };
  for (const z of alle) {
    if (z.zeichnung) { zu(); koerper += bildAbsatz(z); continue; }
    const art = z.liste === 'bullet' ? 'L_punkt' : z.liste === 'ordered' ? 'L_zahl' : null;
    if (art !== offen) { zu(); if (art) { koerper += `<text:list text:style-name="${art}">`; offen = art; } }
    if (art) koerper += `<text:list-item><text:p text:style-name="P_text">${inhalt(z)}</text:p></text:list-item>`;
    else koerper += `<text:p text:style-name="${HAKEN[z.liste] ? 'P_haken' : 'P_text'}">${inhalt(z)}</text:p>`;
  }
  zu();
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3">
<office:automatic-styles>
<style:style style:name="P_titel" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.08cm"/><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
<style:style style:name="P_stand" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.42cm"/><style:text-properties fo:font-size="9pt" fo:color="#6b7280"/></style:style>
<style:style style:name="P_text" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.14cm"/></style:style>
<style:style style:name="P_haken" style:family="paragraph"><style:paragraph-properties fo:margin-left="0.63cm" fo:text-indent="-0.63cm" fo:margin-bottom="0.14cm"/></style:style>
${[...zeichen.values()].join('\n')}
${bildStile.join('\n')}
<text:list-style style:name="L_punkt"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.63cm" fo:text-indent="-0.63cm" fo:margin-left="0.63cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
<text:list-style style:name="L_zahl"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.63cm" fo:text-indent="-0.63cm" fo:margin-left="0.63cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>
</office:automatic-styles>
<office:body><office:text>
<text:p text:style-name="P_titel">${xml(titel)}</text:p>
<text:p text:style-name="P_stand">${xml('Stand: ' + stand)}</text:p>
${koerper}
</office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS} office:version="1.3"><office:styles>
<style:default-style style:family="paragraph"><style:text-properties style:font-name="Liberation Sans" fo:font-family="'Liberation Sans', Arial, sans-serif" fo:font-size="11pt" fo:language="de" fo:country="DE"/></style:default-style>
</office:styles></office:document-styles>`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS} office:version="1.3"><office:meta><dc:title>${xml(titel)}</dc:title><meta:generator>Arbeitsdoku</meta:generator><meta:creation-date>${jetzt.toISOString().replace(/\.\d+Z$/, '')}</meta:creation-date></office:meta></office:document-meta>`;
  return zip([
    // ODF verlangt: „mimetype" als ERSTE Datei und UNKOMPRIMIERT, sonst erkennen Programme die Datei nicht
    { name: 'mimetype', inhalt: 'application/vnd.oasis.opendocument.text', unkomprimiert: true },
    { name: 'META-INF/manifest.xml', inhalt: `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${bilder.map((_, i) => `<manifest:file-entry manifest:full-path="Pictures/zeichnung${i + 1}.png" manifest:media-type="image/png"/>`).join('\n')}
</manifest:manifest>` },
    { name: 'content.xml', inhalt: content },
    { name: 'styles.xml', inhalt: styles },
    { name: 'meta.xml', inhalt: meta },
    ...bilder.map((png, i) => ({ name: `Pictures/zeichnung${i + 1}.png`, inhalt: png })),
  ]);
}

const FORMATE = {
  pdf: { bauen: pdf, typ: 'application/pdf' },
  docx: { bauen: docx, typ: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  odt: { bauen: odt, typ: 'application/vnd.oasis.opendocument.text' },
};

module.exports = { zeilen, standText, dateiname, pdf, docx, odt, FORMATE };
