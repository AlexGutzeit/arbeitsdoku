// Umlaute in Texten: kein „fuer", „geloescht", „Geraet" in dem, was Menschen lesen (R10, 25.09.2026).
//
// Gefunden wurden 82 Ersatzschreibungen — in Meldungen („Nur der Eigentuemer kann loeschen"), in
// Audit-Texten, in der Test-Benachrichtigung („Push funktioniert auf diesem Geraet") und in
// Server-Protokollen. Dieser Test hält den Stand: Er zerlegt jede Quelldatei in Texte
// (Zeichenketten, Vorlagen) und prüft deren WÖRTER. Nicht geprüft wird:
//   * Kommentare — dort sind ae/oe/ue gewollt und üblich;
//   * Kennungen — Routen (/api/backup/empfaenger), Datenfelder (haendler, uebertrag),
//     Datenbank-Werte (bestaetigt), Klassen und Kennungen im HTML (class="empf-pruefen"),
//     Funktionsnamen (ensureBackupEmpfaengerSchema), SQL. Die umzubenennen hieße, Schnittstellen und
//     gespeicherte Daten zu brechen;
//   * echte Wörter mit ae/oe/ue: neue, aktuell, Dauer, Steuer, zuerst, Quelle, Regenschauer …
//
//   node tests/umlaute-in-texten.js
const fs = require('fs'); const path = require('path');
const APP = path.join(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// ── Zerleger: Texte aus JavaScript holen, Kommentare und reguläre Ausdrücke überspringen ──
// Kein vollständiger Parser, aber genau genug. Code innerhalb von ${…} wird mit derselben Schleife
// zerlegt wie Code außerhalb — sonst hielte er ein Anführungszeichen in einem regulären Ausdruck
// innerhalb einer Vorlage für den Anfang eines Textes (so geschehen im Abwesenheitskalender).
function texte(quelle) {
  const aus = []; let i = 0, zeile = 1; const n = quelle.length;
  const regexDavor = /(^|[(,=:\[!&|?{};+\-*%<>~^])$/;
  const wortDavor = /(^|[^\w$])(return|typeof|case|of|in|delete|void|throw|new|yield|await)$/;
  function kommentar() {
    if (quelle[i + 1] === '/') { while (i < n && quelle[i] !== '\n') i++; return true; }
    if (quelle[i + 1] === '*') {
      i += 2;
      while (i < n && !(quelle[i] === '*' && quelle[i + 1] === '/')) { if (quelle[i] === '\n') zeile++; i++; }
      i += 2; return true;
    }
    return false;
  }
  function zeichenkette(ende) {
    const start = zeile; let s = ''; i++;
    while (i < n && quelle[i] !== ende) {
      if (quelle[i] === '\\') { s += quelle[i] + quelle[i + 1]; i += 2; continue; }
      if (quelle[i] === '\n') zeile++;
      s += quelle[i++];
    }
    i++; aus.push({ text: s, zeile: start });
  }
  function regex() {
    i++; let inKlasse = false;
    while (i < n) {
      const d = quelle[i];
      if (d === '\\') { i += 2; continue; }
      if (d === '[') inKlasse = true; else if (d === ']') inKlasse = false;
      else if (d === '/' && !inKlasse) { i++; break; }
      else if (d === '\n') break;
      i++;
    }
    while (/[a-z]/.test(quelle[i] || '')) i++;
  }
  function vorlage() {
    const start = zeile; let s = ''; i++;
    while (i < n && quelle[i] !== '`') {
      if (quelle[i] === '\\') { s += quelle[i] + quelle[i + 1]; i += 2; continue; }
      if (quelle[i] === '$' && quelle[i + 1] === '{') { s += '${…}'; i += 2; code(true); continue; }
      if (quelle[i] === '\n') zeile++;
      s += quelle[i++];
    }
    i++; aus.push({ text: s, zeile: start });
  }
  function code(bisKlammer) {
    let tiefe = 0;
    while (i < n) {
      const c = quelle[i];
      if (c === '\n') { zeile++; i++; continue; }
      if (c === '/' && kommentar()) continue;
      if (c === "'" || c === '"') { zeichenkette(c); continue; }
      if (c === '`') { vorlage(); continue; }
      if (c === '{') { tiefe++; i++; continue; }
      if (c === '}') { if (bisKlammer && tiefe === 0) { i++; return; } tiefe--; i++; continue; }
      if (c === '/') {
        const davor = quelle.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
        if (regexDavor.test(davor) || wortDavor.test(davor)) { regex(); continue; }
      }
      i++;
    }
  }
  code(false);
  return aus;
}

// ── Welche Wörter sind Ersatzschreibungen? ──
// Wortstämme, die im Deutschen mit Umlaut geschrieben werden. Echte Wörter mit ae/oe/ue stehen
// bewusst nicht darin. Wer hier ein neues Wort ergänzt, prüft es an den Beispielen unten.
const FALSCH = /(aehnlich|aender|aeumt|aufloes|auftraeg|waehl|beruehr|bestaetig|bloeck|eintraeg|eigentuem|empfaeng|endgueltig|schluess|flaeche|frueh|fuehr|gaeb|gehoer|geloesch|oeffn|geprueft|geraet|gruen|gueltig|haelt|haendl|haett|kaem|gefuegt|koenn|laeng|loesch|loest|buero|menue|muess|traeg|naechst|naenn|noetig|oeffentl|woert|pruef|rueck|stuend|taeglich|ueber|veraender|spruengl|verdaechtig|schlaeg|waer|woechentl|moeglich|wuerd|zaehl|zufaell|blaett|groess|spaet|faell|haeng|fuell|guenst|kuerz|muell|stueck|natuerl|verfueg|zustaend|gebuehr|beschraenk|erklaer|haeuf|laess|laeuft|koerper|uebl|ungefaehr|faehig)/i;
const FALSCH_GANZ = /^(fuer|Fuer|waere|waeren|haette|koennte|muesste)$/;
const SQL = /^\s*(CREATE|SELECT|INSERT|UPDATE|DELETE|ALTER|PRAGMA|DROP|WITH)\b/i;
const ATTR_KENNUNG = /^(class|id|for|name|type|href|src|style|data-[\w-]+|role|method|action|accept|autocomplete|inputmode|pattern|rel|target|lang|aria-controls|aria-describedby|aria-labelledby)$/i;

function funde(quelltext) {
  const aus = [];
  for (const t of texte(quelltext)) {
    if (SQL.test(t.text)) continue;
    const re = /[A-Za-zÄÖÜäöüß]+/g; let m;
    while ((m = re.exec(t.text))) {
      const w = m[0];
      if (!(FALSCH.test(w) || FALSCH_GANZ.test(w))) continue;
      if (/[a-z][A-Z]/.test(w)) continue;                                   // camelCase-Name
      const vor = t.text[m.index - 1] || '', nach = t.text[m.index + w.length] || '';
      if (/[-_./#\[=\d$]/.test(vor) || /[-_/\d(\[=]/.test(nach)) continue;   // Teil einer Kennung
      if (nach === '.' && /[a-z]/.test(t.text[m.index + w.length + 1] || '')) continue;   // obj.feld
      if (/^[a-z][A-Za-z0-9_]*$/.test(t.text) && t.text === w) continue;       // 'empfaenger'
      const davor = t.text.slice(0, m.index);
      if (davor.lastIndexOf('<!--') > davor.lastIndexOf('-->')) continue;      // HTML-Kommentar
      if (davor.lastIndexOf('<') > davor.lastIndexOf('>')) {                   // in einem Tag:
        const attr = davor.slice(davor.lastIndexOf('<')).match(/([\w-]+)\s*=\s*["'][^"']*$/);
        if (!attr || ATTR_KENNUNG.test(attr[1])) continue;                    // nur title/aria-label/…
      }
      aus.push({ zeile: t.zeile, wort: w, stelle: t.text.slice(Math.max(0, m.index - 25), m.index + w.length + 25).replace(/\s+/g, ' ') });
    }
  }
  return aus;
}

console.log('\nSelbstprüfung an Beispielen');
const beispiel = (code) => funde(code).map(f => f.wort);
ok('findet „fuer" in einer Meldung', beispiel("toast('Nur fuer Admins', 'error');").includes('fuer'));
ok('findet „geloescht" in einer Vorlage', beispiel('x = `Eintrag ${id} geloescht`;').includes('geloescht'));
ok('findet Ersatzschreibung im title-Attribut', beispiel('h = `<button title="Eintrag loeschen">x</button>`;').includes('loeschen'));
ok('ignoriert Kommentare', beispiel('// Frueher war das anders\n/* fuer alle */ x = 1;').length === 0);
ok('ignoriert echte Wörter (neue, aktuell, Dauer, zuerst, Quelle)', beispiel("t = 'Neue Dauer: zuerst aktuelle Quelle';").length === 0);
ok('ignoriert Kennungen: Route, Feld, DB-Wert, Klasse, Funktionsname',
  beispiel("api('GET', '/api/backup/empfaenger'); o.haendler; s = 'bestaetigt'; h = `<b class=\"empf-pruefen\" data-geraet=\"1\">ok</b>`; f('ensureBackupEmpfaengerSchema fehlgeschlagen');").length === 0,
  JSON.stringify(beispiel("api('GET', '/api/backup/empfaenger'); o.haendler; s = 'bestaetigt'; h = `<b class=\"empf-pruefen\" data-geraet=\"1\">ok</b>`; f('ensureBackupEmpfaengerSchema fehlgeschlagen');")));
ok('ignoriert SQL', beispiel("db.exec('CREATE TABLE backup_empfaenger (id INTEGER)');").length === 0);
ok('regulärer Ausdruck mit Anführungszeichen in ${…} bricht die Zerlegung nicht',
  beispiel("x = `a ${s.replace(/[\"']/g, '')} b`; // fuer\ny = 'ok';").length === 0);

// ── Der eigentliche Durchlauf ──
console.log('\nQuelltexte');
const ordner = ['routes', 'middleware', 'public/js', 'scripts', 'database'];
const dateien = [
  ...fs.readdirSync(APP).filter(f => f.endsWith('.js')),
  ...ordner.flatMap(o => fs.existsSync(path.join(APP, o)) ? fs.readdirSync(path.join(APP, o)).filter(f => f.endsWith('.js')).map(f => o + '/' + f) : []),
  'public/sw.js',
];
let alle = [], texteGesamt = 0, verdaechtig = [];
for (const d of dateien) {
  const quelle = fs.readFileSync(path.join(APP, d), 'utf8');
  const t = texte(quelle);
  texteGesamt += t.length;
  // Zerlegungsfehler zeigen sich als „Texte", die Code oder Kommentare enthalten
  for (const x of t) if (/\n\s*\/\/ /.test(x.text) || /\bconst \w+ = /.test(x.text) || /\bfunction \w+\(/.test(x.text)) verdaechtig.push(d + ':' + x.zeile);
  alle = alle.concat(funde(quelle).map(f => ({ ...f, datei: d })));
}
ok(`${dateien.length} Dateien zerlegt, ${texteGesamt} Texte — keiner sieht nach Code aus`, verdaechtig.length === 0 && texteGesamt > 5000,
  verdaechtig.slice(0, 5).join(', '));
ok('keine Ersatzschreibung in Texten', alle.length === 0,
  alle.length + ' Funde:\n      ' + alle.slice(0, 15).map(f => `${f.datei}:${f.zeile} [${f.wort}] …${f.stelle}…`).join('\n      '));

console.log(`\nUmlaute in Texten: ${pass} bestanden, ${fail} fehlgeschlagen`);
if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
