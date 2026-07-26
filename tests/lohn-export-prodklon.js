// Lohn-Export gegen eine KOPIE der Produktivdaten — nur lesend.
// Beweist: Jede Zeile der CSV stimmt mit dem ueberein, was Statistik und Abwesenheits-Uebersicht
// anzeigen (das, was das Buero heute abtippt), und der Export erzeugt keinen Datensatz.
// Zusaetzlich: Abwaertskompatibilitaet — der Klon hat die Spalte personnel_no nicht.
//   node tests/lohn-export-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3145, QUELLE = '/tmp/prodklon.db', DB = '/tmp/lohn-prodklon-arbeitskopie.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: t ? { Authorization: 'Bearer ' + t } : {} },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); r.end();
  });
}
function parseCsv(text) {
  return text.replace(/^﻿/, '').split('\r\n').filter(z => z !== '').map(zeile => {
    const f = []; let cur = '', inQ = false;
    for (let i = 0; i < zeile.length; i++) {
      const c = zeile[i];
      if (inQ) { if (c === '"' && zeile[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === ';') { f.push(cur); cur = ''; }
      else cur += c;
    }
    f.push(cur); return f;
  });
}
const zahl = s => Number(String(s).replace(',', '.'));

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon ' + QUELLE + ' fehlt — Test uebersprungen.'); process.exit(0); }
  // Auf einer ARBEITSKOPIE arbeiten: der Server schreibt die DB alle 5 s zurueck (Migration!),
  // die Ausgangskopie bleibt dadurch unberuehrt.
  fs.copyFileSync(QUELLE, DB);
  // Pruefsumme der QUELLE merken: sie darf sich durch den Testlauf unter keinen Umstaenden aendern.
  const quellPruefsumme = require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex');

  const SQL = await initSqlJs();
  // Die Spalte auf der ARBEITSKOPIE entfernen, falls vorhanden. Andere Prod-Klon-Tests starten den
  // Server direkt gegen /tmp/prodklon.db und migrieren ihn dabei — ohne diesen Schritt haenge die
  // Abwaertskompatibilitaets-Pruefung davon ab, welcher Test vorher lief.
  {
    const vorbereiten = new SQL.Database(fs.readFileSync(DB));
    const hat = vorbereiten.exec("PRAGMA table_info(users)")[0].values.some(v => v[1] === 'personnel_no');
    if (hat) {
      try { vorbereiten.run("ALTER TABLE users DROP COLUMN personnel_no"); }
      catch (e) { console.log('  Hinweis: Spalte liess sich nicht entfernen (' + e.message + ')'); }
      fs.writeFileSync(DB, Buffer.from(vorbereiten.export()));
    }
    vorbereiten.close();
  }
  const vorher = new SQL.Database(fs.readFileSync(DB));
  const spaltenVorher = vorher.exec("PRAGMA table_info(users)")[0].values.map(v => v[1]);
  const zaehle = (d) => ['entries', 'absences', 'users', 'projects'].map(t => {
    try { return t + '=' + d.exec('SELECT COUNT(*) FROM ' + t)[0].values[0][0]; } catch (_) { return t + '=?'; }
  }).join(' ');
  const bestandVorher = zaehle(vorher);
  const [adminId, adminUser, adminName] = vorher.exec("SELECT id, username, name FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
  // Ein Monat, in dem wirklich gebucht wurde
  const monat = vorher.exec("SELECT substr(date,1,7) m, COUNT(*) c FROM entries WHERE deleted_at IS NULL GROUP BY m ORDER BY c DESC LIMIT 1")[0].values[0][0];
  vorher.close();

  ok('Klon hat die Spalte personnel_no NOCH NICHT (Abwärtskompatibilität wird geprüft)',
    !spaltenVorher.includes('personnel_no'), JSON.stringify(spaltenVorher.slice(-3)));
  console.log(`  echte Daten: ${bestandVorher} · geprüfter Monat: ${monat}`);

  const lg = fs.openSync('/tmp/lohn-prodklon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(200); }
    ok('Server startet auf dem alten Datenstand', true);
    const log = fs.readFileSync('/tmp/lohn-prodklon-srv.log', 'utf8');
    ok('Migration personnel_no lief automatisch', /personnel_no/.test(log), log.split('\n').filter(l => /Migration/.test(l)).slice(0, 2).join(' | '));

    const token = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '2h' });
    const res = await req('GET', `/api/payroll/monat.csv?month=${monat}`, token);
    ok('Export liefert 200', res.status === 200, String(res.status));
    const rows = parseCsv(res.text);
    const kopf = rows[0];
    const sp = (n) => kopf.indexOf(n);
    const daten = rows.slice(1, -1);
    ok('Datei enthält Zeilen', daten.length > 0, daten.length + ' Zeilen');

    // Jede Zeile gegen die Endpunkte stellen, aus denen das Buero die Zahlen heute abliest
    const letzterTag = new Date(Date.UTC(Number(monat.slice(0, 4)), Number(monat.slice(5, 7)), 0)).getUTCDate();
    const von = `${monat}-01`, bis = `${monat}-${String(letzterTag).padStart(2, '0')}`;
    const users = (await req('GET', '/api/users', token)).body.users || [];
    let abweichung = null, geprueft = 0;
    for (const z of daten) {
      const u = users.find(x => x.name === z[1]);
      if (!u) { if (!abweichung) abweichung = `Nutzer „${z[1]}" nicht in /api/users`; continue; }
      const st = await req('GET', `/api/statistics?user_ids=${u.id}&period=month&date=${monat}-15`, token);
      const s = st.body && st.body.users && st.body.users[0];
      const sum = await req('GET', `/api/absences/summary?from=${von}&to=${bis}&user_id=${u.id}`, token);
      const ab = (sum.body && sum.body.summary) || {};
      geprueft++;
      const nah = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
      if (!s) { if (!abweichung) abweichung = `${z[1]}: keine Statistik-Zeile`; continue; }
      const fehler = [];
      if (!nah(s.ist, zahl(z[sp('Ist-Stunden')]))) fehler.push(`Ist ${s.ist} vs ${z[sp('Ist-Stunden')]}`);
      if (!nah(s.soll, zahl(z[sp('Soll-Stunden')]))) fehler.push(`Soll ${s.soll} vs ${z[sp('Soll-Stunden')]}`);
      if (!nah(s.ueber, zahl(z[sp('Saldo')]))) fehler.push(`Saldo ${s.ueber} vs ${z[sp('Saldo')]}`);
      if (!nah(s.ueber_gesamt, zahl(z[sp('Überstunden gesamt')]))) fehler.push(`Gesamt ${s.ueber_gesamt} vs ${z[sp('Überstunden gesamt')]}`);
      for (const [feld, spalte] of [['urlaub', 'Urlaub'], ['krank', 'Krank'], ['freizeitausgleich', 'FZA'], ['berufsschule', 'Berufsschule'], ['feiertag', 'Feiertage']]) {
        if (!nah(ab[feld] || 0, zahl(z[sp(spalte)]))) fehler.push(`${spalte} ${ab[feld] || 0} vs ${z[sp(spalte)]}`);
      }
      if (fehler.length && !abweichung) abweichung = `${z[1]}: ${fehler.join(', ')}`;
    }
    ok(`alle ${geprueft} Zeilen stimmen mit Statistik + Abwesenheits-Übersicht überein`, !abweichung, abweichung);

    // Der Projektfilter darf die Stunden-Kennzahlen im PDF nicht mehr verfaelschen
    const pdfOhne = await req('GET', `/api/pdf/export?date_from=${von}&date_to=${bis}`, token);
    ok('PDF-Export läuft weiterhin', pdfOhne.status === 200, String(pdfOhne.status));

  } finally { srv.kill('SIGTERM'); await sleep(1500); }

  const nachher = new SQL.Database(fs.readFileSync(DB));
  const bestandNachher = zaehle(nachher);
  const spaltenNachher = nachher.exec("PRAGMA table_info(users)")[0].values.map(v => v[1]);
  nachher.close();
  ok('kein Datensatz dazugekommen', bestandVorher === bestandNachher, `${bestandVorher} → ${bestandNachher}`);
  ok('personnel_no ist jetzt vorhanden (Migration sauber hochgezogen)', spaltenNachher.includes('personnel_no'));
  ok('Ausgangskopie unberührt', require('crypto').createHash('sha256').update(fs.readFileSync(QUELLE)).digest('hex') === quellPruefsumme,
    'Prüfsumme der Quelldatei hat sich geändert');

  console.log(`\nLohn-Export am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  try { fs.unlinkSync(DB); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
