// Abrechnungs-Abschluss gegen eine KOPIE der Produktivdaten.
//
// Zwei Fragen, die nur echte Daten beantworten:
//   1. Zieht das neue Schema auf einem Bestand ohne diese Tabellen sauber hoch, ohne jemanden
//      auszusperren? (Der Wächter wird bei jeder Schreib-Anfrage aufgerufen.)
//   2. Verändert ein Abschluss auf ECHTEN Zahlen irgendeine angezeigte Zahl? Die erzeugten
//      Testdaten sind gleichmäßig; die Produktivdaten sind es nicht — Teilzeit, Aus- und
//      Wiedereintritte, Krankzeiten über Monatsgrenzen, alte Einträge ohne Soll-Stunden.
//
// Die Quelle wird nur gelesen; gearbeitet wird auf einer Kopie, deren Unversehrtheit am Ende
// per SHA-256 gegen die Quelle nachgewiesen wird.
//   node tests/abschluss-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const PORT = 3159, QUELLE = '/tmp/prodklon.db', DB = '/tmp/abschluss-klon.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test uebersprungen.'); process.exit(0); }
  fs.copyFileSync(QUELLE, DB);
  const quellPruefsumme = sha(QUELLE);

  const SQL = await initSqlJs();
  // Alten Datenstand nachstellen: Tabellen entfernen, falls die Arbeitskopie sie schon hat
  // (andere Klon-Tests migrieren dieselbe Quelldatei).
  {
    const d = new SQL.Database(fs.readFileSync(DB));
    d.run('DROP TABLE IF EXISTS payroll_adjustments');
    d.run('DROP TABLE IF EXISTS payroll_closure_rows');
    d.run('DROP TABLE IF EXISTS payroll_closures');
    fs.writeFileSync(DB, Buffer.from(d.export()));
    d.close();
  }
  let nutzer = [], adminId = null, adminName = '', fruehester = null;
  {
    const d = new SQL.Database(fs.readFileSync(DB));
    const tabellen = d.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'payroll%'");
    ok('Arbeitskopie hat die Abschluss-Tabellen NICHT (alter Datenstand nachgestellt)', tabellen.length === 0);
    [adminId, adminName] = d.exec("SELECT id, name FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
    nutzer = d.exec("SELECT id, name FROM users").map ? d.exec("SELECT id, name FROM users")[0].values.map(v => ({ id: v[0], name: v[1] })) : [];
    const f = d.exec("SELECT MIN(date) FROM entries WHERE deleted_at IS NULL");
    fruehester = f.length ? f[0].values[0][0] : null;
    d.close();
  }
  console.log(`  ${nutzer.length} echte Nutzer, frühester Zeiteintrag ${fruehester}, angemeldet als ${adminName}`);

  const lg = fs.openSync('/tmp/abschluss-klon-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(250); }
    ok('Server startet auf dem alten Datenstand', (await req('GET', '/health')).status === 200);

    const admin = jwt.sign({ userId: adminId }, SECRET, { expiresIn: '2h' });

    // Der Aussperr-Fall: Der Wächter läuft bei jeder Schreibanfrage. Fehlt die Tabelle, muss er
    // „nichts gesperrt" liefern statt zu werfen — sonst wäre die ganze App tot.
    let alleErreichbar = 0;
    for (const u of nutzer) {
      const t = jwt.sign({ userId: u.id }, SECRET, { expiresIn: '2h' });
      const r = await req('GET', '/api/auth/me', t);
      if (r.status === 200 || r.status === 401) alleErreichbar++;   // 401 = ausgestellt, auch ok
    }
    ok('kein Nutzer wird ausgesperrt', alleErreichbar === nutzer.length, `${alleErreichbar}/${nutzer.length}`);

    const stand0 = await req('GET', '/api/closure', admin);
    ok('Abschluss-Stand ist lesbar und leer', stand0.status === 200 && stand0.body.bis === null, JSON.stringify(stand0.body || {}).slice(0, 120));

    // ── Zahlen VOR dem Abschluss aufnehmen ────────────────────────────────────────────────
    const monate = [];
    if (fruehester) {
      const d = new Date(fruehester.slice(0, 7) + '-01T12:00:00Z');
      const heute = new Date();
      while (d < heute && monate.length < 40) {
        monate.push(d.toISOString().slice(0, 7));
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
      monate.pop();   // laufenden/letzten unvollstaendigen Monat weglassen
    }
    ok('genug Monate mit echten Daten gefunden', monate.length >= 3, `${monate.length}: ${monate.slice(0, 3).join(', ')} …`);

    const messen = async () => {
      const werte = {};
      for (const m of monate) {
        const csv = await req('GET', `/api/payroll/monat.csv?month=${m}`, admin);
        werte['CSV ' + m] = csv.text;
      }
      for (const u of nutzer) {
        const s = await req('GET', `/api/statistics?from=${fruehester}&to=2099-12-31&user_id=${u.id}`, admin);
        werte['STAT ' + u.id] = s.text;
        const o = await req('GET', `/api/statistics/overtime?user_id=${u.id}`, admin);
        werte['OT ' + u.id] = o.text;
      }
      return werte;
    };

    const vorher = await messen();
    const anzahlWerte = Object.keys(vorher).length;
    ok('Ausgangsmessung enthält Antworten', anzahlWerte > 5, String(anzahlWerte));
    const inhalt = Object.values(vorher).join('');
    ok('die Messung enthält echte Zahlen (nicht nur Fehlermeldungen)',
      inhalt.length > 500 && !/"error"/.test(inhalt), inhalt.slice(0, 160));

    // ── Monate abschließen ────────────────────────────────────────────────────────────────
    let geschlossen = 0;
    for (const m of monate) {
      const r = await req('POST', '/api/closure', admin, { month: m });
      if (r.status === 201) geschlossen++;
      else { console.log(`  Hinweis: ${m} nicht abgeschlossen (${r.status}: ${r.body?.error || ''})`); break; }
    }
    ok('mindestens drei echte Monate abgeschlossen', geschlossen >= 3, `${geschlossen} von ${monate.length}`);

    // ── Und wieder messen ─────────────────────────────────────────────────────────────────
    const nachher = await messen();
    const abweichungen = Object.keys(vorher).filter(k => vorher[k] !== nachher[k]);
    ok(`keine Antwort hat sich verändert (${anzahlWerte} verglichen, ${geschlossen} Abschlüsse)`,
      abweichungen.length === 0, abweichungen.slice(0, 3).join(', '));

    // Gegenprobe: Die Messung MUSS auf eine echte Änderung reagieren — sonst sagt sie nichts aus.
    const mitarbeiter = nutzer.find(u => u.id !== adminId);
    const neu = await req('POST', '/api/entries', admin, {
      date: new Date().toISOString().slice(0, 10), time_from: '20:00', time_to: '22:00',
      break_minutes: 0, user_id: mitarbeiter.id,
    });
    if (neu.status === 201) {
      const gestoert = await messen();
      ok('Gegenprobe: die Messung reagiert auf einen zusätzlichen Eintrag',
        Object.keys(vorher).some(k => gestoert[k] !== nachher[k]), 'keine Reaktion — Messung wertlos');
      await req('DELETE', `/api/entries/${neu.body.entry.id}`, admin, { reason: 'Testbereinigung' });
    } else {
      ok('Gegenprobe konnte durchgeführt werden', false, `Eintrag nicht anlegbar: ${neu.status}`);
    }

  } finally {
    srv.kill('SIGTERM'); await sleep(900);
  }

  ok('die Ausgangskopie wurde NICHT verändert', sha(QUELLE) === quellPruefsumme);
  try { fs.unlinkSync(DB); } catch (_) {}
  console.log(`\nAbschluss gegen Produktivdaten: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
