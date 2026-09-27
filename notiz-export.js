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
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const { ZONE } = require('./zeit');

// Erst beim ersten PDF aufgelöst: Fehlt das Schriftpaket, scheitert nur das PDF (mit Meldung) — nicht
// der Start des Servers, der diese Datei über routes/notes.js schon beim Hochfahren lädt.
const schriften = () => path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

// ─── Gemeinsamer Zwischenschritt ─────────────────────────────────────────────────────────────

/** Delta (JSON-Text) → [{ teile: [{ t, bold, italic, underline }], liste: null|'bullet'|'ordered'|'checked'|'unchecked', nr }] */
function zeilen(deltaJson, klartext) {
  let ops = null;
  try { ops = JSON.parse(deltaJson || ''); } catch (_) { /* Rückfall auf Klartext */ }
  if (!Array.isArray(ops)) ops = [{ insert: String(klartext || '') + '\n' }];
  const aus = []; let teile = [];
  for (const op of ops) {
    if (typeof op.insert !== 'string') continue;
    const a = op.attributes || {};
    op.insert.split('\n').forEach((t, i, alle) => {
      if (t) teile.push({ t, bold: !!a.bold, italic: !!a.italic, underline: !!a.underline });
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
      const einzug = z.liste ? 22 : 0;
      doc.font('R').fontSize(GROESSE);
      const zeilenHoehe = doc.currentLineHeight(true) + 2;
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
        z.teile.forEach((teil, i) => {
          const schrift = teil.bold && teil.italic ? 'BI' : teil.bold ? 'B' : teil.italic ? 'I' : 'R';
          const optionen = { width: breite - einzug, lineGap: 2, continued: i < z.teile.length - 1,
            underline: teil.underline, strike: erledigt };
          doc.font(schrift).fontSize(GROESSE).fillColor(erledigt ? LEISE : TEXT);
          if (i === 0) doc.text(lesbar(teil.t), links + einzug, y, optionen);
          else doc.text(lesbar(teil.t), optionen);
        });
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

// ─── Zip-Hilfe (DOCX, ODT) ───────────────────────────────────────────────────────────────────

function zip(dateien) {
  return new Promise((fertig, fehler) => {
    const a = archiver('zip', { zlib: { level: 9 } });
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

function docx({ titel, deltaJson, klartext, stand, jetzt = new Date() }) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const alle = zeilen(deltaJson, klartext);
  // Jede nummerierte Liste bekommt eine eigene Nummerierung, damit sie wieder bei 1 beginnt
  let listen = 0; const nums = [];
  for (let i = 0; i < alle.length; i++) {
    if (alle[i].liste === 'ordered' && (i === 0 || alle[i - 1].liste !== 'ordered')) { listen++; nums.push(2 + listen); }
    if (alle[i].liste === 'ordered') alle[i].numId = 2 + listen;
  }
  const lauf = (text, { bold, italic, underline, erledigt, symbol } = {}) =>
    `<w:r><w:rPr>${symbol ? '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:eastAsia="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>' : ''}`
    + `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${underline ? '<w:u w:val="single"/>' : ''}${erledigt ? '<w:strike/><w:color w:val="6B7280"/>' : ''}`
    + `</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const absaetze = alle.map(z => {
    const erledigt = z.liste === 'checked';
    let pPr = '';
    if (z.liste === 'bullet') pPr = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
    else if (z.liste === 'ordered') pPr = `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${z.numId}"/></w:numPr></w:pPr>`;
    else if (HAKEN[z.liste]) pPr = '<w:pPr><w:ind w:left="357" w:hanging="357"/></w:pPr>';
    const haken = HAKEN[z.liste] ? lauf(HAKEN[z.liste] + ' ', { symbol: true, erledigt: false }) : '';
    return `<w:p>${pPr}${haken}${z.teile.map(t => lauf(t.t, { ...t, erledigt })).join('')}</w:p>`;
  }).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
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
</Relationships>` },
    { name: 'word/document.xml', inhalt: document },
    { name: 'word/styles.xml', inhalt: styles },
    { name: 'word/numbering.xml', inhalt: numbering },
    { name: 'docProps/core.xml', inhalt: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(titel)}</dc:title><dc:creator>Arbeitsdoku</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>` },
  ]);
}

// ─── ODT ─────────────────────────────────────────────────────────────────────────────────────

function odt({ titel, deltaJson, klartext, stand, jetzt = new Date() }) {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    + 'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';
  // Zeichenformate nach Bedarf: T_b, T_i, T_u, T_bi … und _x für „erledigt" (durchgestrichen, grau)
  const zeichen = new Map();
  const zeichenStil = (t, erledigt) => {
    const name = 'T_' + (t.bold ? 'b' : '') + (t.italic ? 'i' : '') + (t.underline ? 'u' : '') + (erledigt ? 'x' : '');
    if (name === 'T_') return null;
    if (!zeichen.has(name)) zeichen.set(name, `<style:style style:name="${name}" style:family="text"><style:text-properties`
      + (t.bold ? ' fo:font-weight="bold"' : '') + (t.italic ? ' fo:font-style="italic"' : '')
      + (t.underline ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : '')
      + (erledigt ? ' style:text-line-through-style="solid" fo:color="#6b7280"' : '') + '/></style:style>');
    return name;
  };
  const inhalt = (z) => {
    const erledigt = z.liste === 'checked';
    const haken = HAKEN[z.liste] ? xml(HAKEN[z.liste] + ' ') : '';
    return haken + z.teile.map(t => { const s = zeichenStil(t, erledigt); const x = xml(t.t);
      return s ? `<text:span text:style-name="${s}">${x}</text:span>` : x; }).join('');
  };
  const alle = zeilen(deltaJson, klartext);
  let koerper = '', offen = null;
  const zu = () => { if (offen) { koerper += '</text:list>'; offen = null; } };
  for (const z of alle) {
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
</manifest:manifest>` },
    { name: 'content.xml', inhalt: content },
    { name: 'styles.xml', inhalt: styles },
    { name: 'meta.xml', inhalt: meta },
  ]);
}

const FORMATE = {
  pdf: { bauen: pdf, typ: 'application/pdf' },
  docx: { bauen: docx, typ: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  odt: { bauen: odt, typ: 'application/vnd.oasis.opendocument.text' },
};

module.exports = { zeilen, standText, dateiname, pdf, docx, odt, FORMATE };
