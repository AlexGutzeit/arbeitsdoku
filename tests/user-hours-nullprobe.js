// NULLPROBE: Eine Änderung an der Stunden-Rechnung darf bestehende Stände NICHT verschieben.
//
// Der gefährlichste Fehler beim Einbau der Überstunden-Auszahlung wäre nicht ein kaputter neuer
// Knopf, sondern eine stillschweigend verschobene alte Zahl. Ein Test, der nur die neue Funktion
// prüft, sieht so etwas nie.
//
// Deshalb wie tests/stunden-vorher-nachher.js: ZWEI Server auf je einer Kopie DERSELBEN
// Produktivdaten — einer mit dem Vergleichsstand, einer mit dem aktuellen Code. Verglichen wird,
// was die App ausliefert, für JEDEN Mitarbeiter über alle Monate, Jahre und den Gesamtzeitraum.
//
// Der Unterschied zu stunden-vorher-nachher: DORT wurde bewiesen, dass sich eine Zahl ÄNDERT
// (die korrigierte Projektfilter-Rechnung). Hier wird das Gegenteil verlangt — überall Gleichheit.
// Beide Richtungen braucht man; verwechselt man sie, beweist der Test das Gegenteil von dem,
// was man glaubt.
//
// Voraussetzung — fehlt eines, überspringt sich der Test:
//   /tmp/prodklon.db                (frische Kopie der Produktivdaten, nur lesend geholt)
//   git worktree add --detach /tmp/nullprobe-stand <commit-vor-der-aenderung>
//   ln -sfn <projekt>/node_modules /tmp/nullprobe-stand/node_modules
//
//   node tests/user-hours-nullprobe.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const ALT_DIR = '/tmp/nullprobe-stand';
const QUELLE = '/tmp/prodklon.db';
const PORT_ALT = 3151, PORT_NEU = 3152;
const DB_ALT = '/tmp/null-alt.db', DB_NEU = '/tmp/null-neu.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const rund = (n) => Math.round((Number(n) || 0) * 100) / 100;

function hole(port, pfad, token, roh) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port, path: pfad, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => {
        if (roh) return res({ status: x.statusCode, text: s });
        let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); r.end();
  });
}
const gesund = (port) => new Promise(res => {
  const r = http.request({ host: 'localhost', port, path: '/health', method: 'GET' }, x => { x.resume(); res(x.statusCode === 200); });
  r.on('error', () => res(false)); r.end();
});

(async () => {
  if (!fs.existsSync(QUELLE)) { console.log('Prod-Klon fehlt — Test uebersprungen.'); process.exit(0); }
  if (!fs.existsSync(path.join(ALT_DIR, 'server.js'))) {
    console.log('Vergleichsstand unter ' + ALT_DIR + ' fehlt — Test uebersprungen.');
    console.log('  Anlegen mit: git worktree add --detach ' + ALT_DIR + ' <commit>');
    process.exit(0);
  }
  fs.copyFileSync(QUELLE, DB_ALT);
  fs.copyFileSync(QUELLE, DB_NEU);

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(QUELLE));
  const nutzer = db.exec('SELECT id, name FROM users ORDER BY id')[0].values.map(v => ({ id: v[0], name: v[1] }));
  const [adminId] = db.exec("SELECT id FROM users WHERE role='admin' AND (active IS NULL OR active=1) LIMIT 1")[0].values[0];
  const monate = db.exec("SELECT DISTINCT substr(date,1,7) m FROM entries WHERE deleted_at IS NULL ORDER BY m")[0].values.map(v => v[0]);
  db.close();
  const token = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '4h' });
  console.log(`  ${nutzer.length} Nutzer · ${monate.length} Monate (${monate[0]} bis ${monate[monate.length - 1]})`);

  const start = (dir, port, dbPfad, log) => spawn('node', ['server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(port), DB_PATH: dbPfad, JWT_SECRET: SECRET },
    stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log + '.err', 'w')],
  });
  const alt = start(ALT_DIR, PORT_ALT, DB_ALT, '/tmp/null-alt.log');
  const neu = start(process.cwd(), PORT_NEU, DB_NEU, '/tmp/null-neu.log');

  try {
    for (let i = 0; i < 120; i++) { if (await gesund(PORT_ALT) && await gesund(PORT_NEU)) break; await sleep(250); }
    ok('Vergleichsstand läuft', await gesund(PORT_ALT));
    ok('aktueller Stand läuft', await gesund(PORT_NEU));

    // ── Statistik ──────────────────────────────────────────────────────────────────────────────
    const perioden = [];
    for (const m of monate) perioden.push(['month', `${m}-15`]);
    for (const j of [...new Set(monate.map(m => m.slice(0, 4)))]) {
      perioden.push(['year', `${j}-06-15`]); perioden.push(['total', `${j}-12-31`]);
    }
    let n1 = 0; const abw1 = [];
    for (const u of nutzer) for (const [period, datum] of perioden) {
      const pfad = `/api/statistics?user_ids=${u.id}&period=${period}&date=${datum}`;
      const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token), hole(PORT_NEU, pfad, token)]);
      const ua = a.body && a.body.users && a.body.users[0];
      const un = n.body && n.body.users && n.body.users[0];
      n1++;
      if (!ua && !un) continue;
      if (!ua || !un) { abw1.push(`${u.name} ${period}/${datum}: Zeile fehlt`); continue; }
      for (const f of ['ist', 'soll', 'ueber', 'start_overtime', 'ueber_gesamt']) {
        if (rund(ua[f]) !== rund(un[f])) abw1.push(`${u.name} ${period}/${datum} ${f}: ${rund(ua[f])} → ${rund(un[f])}`);
      }
    }
    ok(`Statistik unverändert (${n1} Abfragen über alle Nutzer und Zeiträume)`, abw1.length === 0, abw1.slice(0, 5).join(' | '));

    // ── Überstundenstand (die Zahl, um die es hier geht) ────────────────────────────────────────
    let n2 = 0; const abw2 = [];
    for (const u of nutzer) for (const tag of [monate[monate.length - 1] + '-28', monate[0] + '-15', '2027-12-31']) {
      const pfad = `/api/statistics/overtime?user_id=${u.id}&date_to=${tag}`;
      const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token), hole(PORT_NEU, pfad, token)]);
      n2++;
      if (rund(a.body && a.body.overtime) !== rund(n.body && n.body.overtime)) {
        abw2.push(`${u.name} bis ${tag}: ${a.body && a.body.overtime} → ${n.body && n.body.overtime}`);
      }
    }
    ok(`Überstundenstand unverändert (${n2} Abfragen)`, abw2.length === 0, abw2.slice(0, 5).join(' | '));

    // ── Lohn-Export: die Datei, die das Lohnbüro bekommt ────────────────────────────────────────
    const abw3 = [];
    for (const m of monate) {
      const pfad = `/api/payroll/monat.csv?month=${m}`;
      const [a, n] = await Promise.all([hole(PORT_ALT, pfad, token, true), hole(PORT_NEU, pfad, token, true)]);
      if (a.text !== n.text) abw3.push(m);
    }
    ok(`Lohn-Export Zeichen für Zeichen gleich (${monate.length} Monate)`, abw3.length === 0, 'abweichende Monate: ' + abw3.join(', '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.message);
  } finally {
    alt.kill(); neu.kill();
  }

  console.log(`\nNullprobe: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
})();
