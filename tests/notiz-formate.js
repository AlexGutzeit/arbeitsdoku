// Schriftfarbe, Schriftgröße und Durchstreichen in Notizen — Server und Dateien (24.11.2026).
//
// Ohne laufenden Server; geprüft wird:
//   * EINE Liste: Farben und Größen stehen an drei Stellen (Schreibfeld notiz-sitzung.js, Prüfung und
//     Farbwerte notiz-dokument.js, CSS) — sie müssen gleich sein, sonst weist der Server ab, was die
//     Knopfleiste anbietet, oder eine Farbe erscheint im Schreibfeld anders als im PDF.
//   * Die Prüfung (zulaessig): die neuen Formate gehen durch, freie Farben/Größen/fremde Formate nicht.
//   * PDF: farbiger Text ist farbig (Bild gerendert, Bildpunkte gezählt), große Schrift ist größer
//     (Wortkästen von pdftotext), Durchgestrichenes hat einen Strich.
//   * Word/ODT: die richtigen Angaben im XML (Word-Reihenfolge in <w:rPr>), und LibreOffice öffnet beide
//     und liest den Text unverändert.
//
//   node tests/notiz-formate.js
const fs = require('fs'); const path = require('path'); const os = require('os'); const vm = require('vm');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const APP = path.join(__dirname, '..');
const dok = require(path.join(APP, 'notiz-dokument'));
const exporte = require(path.join(APP, 'notiz-export'));
const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), 'notiz-formate-'));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const hatProgramm = (p) => spawnSync('which', [p]).status === 0;

(async () => {
  console.log('\nEine Liste an drei Stellen');
  const quelle = fs.readFileSync(path.join(APP, 'public/js/notiz-sitzung.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext((quelle.match(/const NOTIZ_FARBEN = [\s\S]*?\};/) || [''])[0].replace('const ', 'this.') + '\n'
    + (quelle.match(/const NOTIZ_GROESSEN = [\s\S]*?\};/) || [''])[0].replace('const ', 'this.')
    + '\n' + (quelle.match(/const NOTIZ_FORMATE = [^\n]*/) || [''])[0].replace('const ', 'this.'), ctx);
  const client = Object.fromEntries(Object.entries(ctx.NOTIZ_FARBEN || {}).map(([k, [, hex]]) => [k, hex]));
  ok('Schreibfeld und Server: dieselben Farbnamen mit denselben Werten', JSON.stringify(client) === JSON.stringify(dok.FARBEN) && Object.keys(client).length === 6,
    JSON.stringify([client, dok.FARBEN]));
  ok('Schreibfeld und Server: dieselben Größen', JSON.stringify(Object.keys(ctx.NOTIZ_GROESSEN || {})) === JSON.stringify(Object.keys(dok.GROESSEN)),
    JSON.stringify([ctx.NOTIZ_GROESSEN, dok.GROESSEN]));
  ok('Schreibfeld lässt strike, color und size zu', ['strike', 'color', 'size'].every(f => (ctx.NOTIZ_FORMATE || []).includes(f)), JSON.stringify(ctx.NOTIZ_FORMATE));
  const css = fs.readFileSync(path.join(APP, 'public/css/style.css'), 'utf8');
  const cssFalsch = Object.entries(dok.FARBEN).filter(([k, hex]) =>
    !new RegExp(`\\.notiz-inhalt \\.ql-color-${k} \\{ color: ${hex}; \\}`).test(css)
    || !new RegExp(`\\.ql-picker-item\\[data-value=${k}\\] \\{ background-color: ${hex} !important; \\}`).test(css)
    || !new RegExp(`\\.ql-picker-label\\[data-value=${k}\\] \\.ql-color-label \\{ stroke: ${hex} !important; \\}`).test(css));
  ok('CSS: Text, Farbfeld und Farbstrich je Farbe mit demselben Wert', cssFalsch.length === 0, JSON.stringify(cssFalsch));

  console.log('\nPrüfung des Dokuments (zulaessig)');
  const mitDelta = (delta) => { const d = new dok.Y.Doc(); d.getText(dok.TEXT).applyDelta(delta); const r = dok.zulaessig(d); d.destroy(); return r; };
  ok('Farbe, Größe, Durchstreichen (auch kombiniert und wieder entfernt) gehen durch',
    mitDelta([{ insert: 'a', attributes: { color: 'rot', size: 'huge', strike: true, bold: true } }, { insert: 'b', attributes: { color: 'grau', size: 'small' } }, { insert: '\n' }])
    && mitDelta([{ insert: 'x', attributes: { color: false, size: false, strike: false } }, { insert: '\n' }]));
  const abgewiesen = [{ color: '#ff0000' }, { color: 'red' }, { color: 'rgb(1,2,3)' }, { size: '40px' }, { size: 'large ' }, { strike: 'ja' },
    { font: 'serif' }, { background: 'gelb' }, { link: 'https://x' }, { constructor: true }];
  const durch = abgewiesen.filter(a => mitDelta([{ insert: 'x', attributes: a }, { insert: '\n' }]));
  ok('freie Farbe, Größe in px, fremde Formate (Schriftart, Hintergrund, Link) werden abgewiesen', durch.length === 0, JSON.stringify(durch));

  console.log('\nDateien');
  const DELTA = [
    { insert: 'Schwarz ' }, { insert: 'ROTWORT', attributes: { color: 'rot' } }, { insert: ' normal' }, { insert: '\n' },
    { insert: 'RIESIG', attributes: { size: 'huge' } }, { insert: ' klein', attributes: { size: 'small', color: 'blau' } }, { insert: '\n' },
    { insert: 'Weg damit', attributes: { strike: true } }, { insert: '\n' },
    { insert: 'Erledigt grün', attributes: { color: 'gruen' } }, { insert: '\n', attributes: { list: 'checked' } },
  ];
  const daten = { titel: 'Formate', deltaJson: JSON.stringify(DELTA), klartext: '', stand: '24.11.2026, 10:00' };
  const z = exporte.zeilen(daten.deltaJson);
  ok('Zwischenschritt: Farbe als Wert, Größe als Faktor, Durchstreichen',
    z[0].teile[1].farbe === '#dc2626' && z[0].teile[0].farbe === null && z[1].teile[0].faktor === 2.5 && z[1].teile[1].faktor === 0.75
    && z[1].teile[1].farbe === '#1d4ed8' && z[2].teile[0].strike === true && z[0].teile[0].faktor === 1, JSON.stringify(z));

  // PDF
  const pdf = await exporte.pdf(daten);
  const pdfDatei = path.join(ORDNER, 'f.pdf'); fs.writeFileSync(pdfDatei, pdf);
  if (hatProgramm('pdftotext') && hatProgramm('pdftoppm')) {
    const bbox = spawnSync('pdftotext', ['-bbox', pdfDatei, '-'], { encoding: 'utf8' }).stdout;
    const hoehe = (w) => { const m = bbox.match(new RegExp(`yMin="([\\d.]+)" xMax="[\\d.]+" yMax="([\\d.]+)">${w}<`)); return m ? m[2] - m[1] : 0; };
    ok('PDF: „RIESIG" ist mehr als doppelt so hoch wie normaler Text, „klein" kleiner',
      hoehe('RIESIG') > 2 * hoehe('Schwarz') && hoehe('klein') < hoehe('Schwarz') && hoehe('Schwarz') > 0,
      JSON.stringify({ riesig: hoehe('RIESIG'), normal: hoehe('Schwarz'), klein: hoehe('klein') }));
    // Gerendert: rote Bildpunkte nur dort, wo ROTWORT steht
    spawnSync('pdftoppm', ['-r', '100', '-png', '-singlefile', pdfDatei, path.join(ORDNER, 'f')]);
    const { data, info } = await sharp(path.join(ORDNER, 'f.png')).raw().toBuffer({ resolveWithObject: true });
    let rot = 0, blau = 0, gruen = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 180 && g < 90 && b < 90) rot++;
      if (b > 170 && r < 80 && g < 120) blau++;
      if (g > 100 && r < 60 && b < 100) gruen++;
    }
    ok('PDF: roter und blauer Text sind farbig; abgehakter grüner Text ist grau (erledigt gewinnt)', rot > 30 && blau > 10 && gruen === 0, JSON.stringify({ rot, blau, gruen }));
    const zeile = bbox.split('\n').find(l => />Weg</.test(l));
    ok('PDF: durchgestrichener Text steht drin', !!zeile);
  } else console.log('    (pdftotext/pdftoppm fehlen — PDF nicht gelesen)');

  // Word
  const docx = await exporte.docx(daten);
  const docXml = new AdmZip(docx).readAsText('word/document.xml');
  const lauf = (wort) => (docXml.match(new RegExp(`<w:r><w:rPr>((?:(?!</w:rPr>).)*)</w:rPr><w:t xml:space="preserve">${wort}</w:t>`)) || [])[1];
  ok('Word: Farbe, Größe (Halbpunkte), Durchstreichen am richtigen Wort',
    lauf('ROTWORT') === '<w:color w:val="DC2626"/>' && lauf('RIESIG') === '<w:sz w:val="55"/><w:szCs w:val="55"/>'
    && lauf(' klein') === '<w:color w:val="1D4ED8"/><w:sz w:val="17"/><w:szCs w:val="17"/>' && lauf('Weg damit') === '<w:strike/>'
    && lauf('Erledigt grün') === '<w:strike/><w:color w:val="6B7280"/>',
    JSON.stringify(['ROTWORT', 'RIESIG', ' klein', 'Weg damit', 'Erledigt grün'].map(lauf)));
  // Reihenfolge laut Schema: b, i, strike, color, sz, u
  const reihenfolge = ['<w:b/>', '<w:i/>', '<w:strike/>', '<w:color', '<w:sz ', '<w:u '];
  const alleRpr = [...docXml.matchAll(/<w:rPr>(.*?)<\/w:rPr>/g)].map(m => m[1]);
  const falsch = alleRpr.filter(r => { const pos = reihenfolge.map(t => r.indexOf(t)).filter(p => p >= 0); return pos.some((p, i) => i && p < pos[i - 1]); });
  const voll = await exporte.docx({ ...daten, deltaJson: JSON.stringify([{ insert: 'alles', attributes: { bold: true, italic: true, underline: true, strike: true, color: 'lila', size: 'large' } }, { insert: '\n' }]) });
  const vollRpr = (new AdmZip(voll).readAsText('word/document.xml').match(/<w:rPr>(<w:b\/>.*?)<\/w:rPr><w:t xml:space="preserve">alles/) || [])[1] || '';
  ok('Word: Reihenfolge in <w:rPr> wie vom Format verlangt (b, i, strike, color, sz, u)',
    falsch.length === 0 && vollRpr === '<w:b/><w:i/><w:strike/><w:color w:val="7E22CE"/><w:sz w:val="33"/><w:szCs w:val="33"/><w:u w:val="single"/>', JSON.stringify([falsch, vollRpr]));

  // ODT
  const odt = await exporte.odt(daten);
  const inhalt = new AdmZip(odt).readAsText('content.xml');
  const stilVon = (wort) => { const n = (inhalt.match(new RegExp(`<text:span text:style-name="([^"]+)">${wort}</text:span>`)) || [])[1];
    return n ? (inhalt.match(new RegExp(`<style:style style:name="${n}" style:family="text"><style:text-properties([^/]*)/>`)) || [])[1] : null; };
  ok('ODT: Farbe, Größe, Durchstreichen am richtigen Wort; erledigt bleibt grau',
    /fo:color="#dc2626"/.test(stilVon('ROTWORT')) && /fo:font-size="27.5pt"/.test(stilVon('RIESIG'))
    && /fo:font-size="8.25pt"/.test(stilVon(' klein')) && /fo:color="#1d4ed8"/.test(stilVon(' klein'))
    && /line-through-style="solid"/.test(stilVon('Weg damit')) && /fo:color="#6b7280"/.test(stilVon('Erledigt grün')),
    JSON.stringify(['ROTWORT', 'RIESIG', ' klein', 'Weg damit', 'Erledigt grün'].map(stilVon)));

  if (hatProgramm('soffice')) {
    for (const [endung, buf] of [['docx', docx], ['odt', odt]]) {
      const datei = path.join(ORDNER, 'f.' + endung); fs.writeFileSync(datei, buf);
      const aus = path.join(ORDNER, 'txt-' + endung);
      spawnSync('soffice', ['-env:UserInstallation=file://' + path.join(ORDNER, 'lo'), '--headless', '--convert-to', 'txt:Text', '--outdir', aus, datei], { timeout: 120000 });
      const txt = path.join(aus, 'f.txt');
      const zeilen = fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').replace(/^﻿/, '').split('\n').map(s => s.trim()).filter(Boolean) : [];
      ok(`${endung}: LibreOffice öffnet die Datei, Text unverändert`,
        JSON.stringify(zeilen.slice(2)) === JSON.stringify(['Schwarz ROTWORT normal', 'RIESIG klein', 'Weg damit', '☑ Erledigt grün']), JSON.stringify(zeilen));
    }
  } else console.log('    (LibreOffice fehlt — Word/ODT nicht geöffnet)');

  fs.rmSync(ORDNER, { recursive: true, force: true });
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
