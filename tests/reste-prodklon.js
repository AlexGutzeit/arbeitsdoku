// Reste aufräumen an echten Daten (R27, Prod-Klon, 28.09.2026).
//
// Alex' Bedingung: kein Verlust an Produktivdaten. Deshalb zwei Beweise an Kopien der Produktivdaten:
//
// 1. ZEILE FÜR ZEILE (frische Rohkopie, der Start wie im Betrieb): Nach dem Start fehlen GENAU die Zeilen, die
//    SQLite selbst als „Anhängsel ohne Gegenstück" meldet (PRAGMA foreign_key_check, unabhängig von
//    reste.js berechnet) — jede andere Zeile jeder Tabelle ist zeichengleich da. Dazu genau EIN
//    Protokolleintrag „Datenreste aufgeräumt". Inhalt mit Verweis ins Leere (Zeiteinträge gelöschter Konten
//    und Projekte, Planungen) bleibt, seine Verstöße zählen gleich viel wie vorher. Zweiter Start: nichts mehr.
//
// 2. WAS DIE APP ZEIGT (Nullprobe): zwei Server auf je einer Kopie derselben Daten — der Stand VOR dieser
//    Arbeit (/tmp/nullprobe-stand) und der aktuelle, der beim Start aufräumt. Planung (alle Tage, jede
//    einzeln), Konten, Projekte, Abwesenheiten und Überstunden jedes Kontos müssen zeichengleich sein.
//    Gegenprobe im Test: dieselbe Abfrage auf eine GEÄNDERTE Planung muss einen Unterschied finden.
//
// Voraussetzung (fehlt etwas, wird der jeweilige Teil übersprungen):
//   /tmp/prodklon-frisch-roh.db   frische Rohkopie (nur lesend geholt)
//   /tmp/prodklon.db              daraus gebaut: node scripts/prodklon-vorbereiten.js <roh> /tmp/prodklon.db
//   git worktree add --detach /tmp/nullprobe-stand <commit vor R27>; node_modules verlinken
//
//   node tests/reste-prodklon.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const reste = require('../reste');

const WURZEL = path.join(__dirname, '..');
// Nur die FRISCHE Rohkopie: Sie steht auf dem Schema des laufenden Betriebs, beim Start läuft außer dem Aufräumen
// nichts. Ältere Kopien (z. B. /tmp/prodklon-echt.db) ziehen noch frühere Umstellungen hoch — dort ändern sich
// Zeilen aus anderem Grund, ein Zeichengleich-Vergleich wäre sinnlos.
const ROH = ['/tmp/prodklon-frisch-roh.db'].filter(p => fs.existsSync(p));
const KLON = '/tmp/prodklon.db', ALT_DIR = '/tmp/nullprobe-stand';
const PORT_ALT = 3347, PORT_NEU = 3348, DB_ALT = '/tmp/reste-null-alt.db', DB_NEU = '/tmp/reste-null-neu.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const summe = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const werte = (db, sql) => { const r = db.exec(sql); return r.length ? r[0].values : []; };
const zeile = (v) => JSON.stringify(v.map(x => x instanceof Uint8Array ? 'b64:' + Buffer.from(x).toString('base64') : x));

// Alle Zeilen aller Tabellen, je Tabelle als Map rowid → Inhalt
function bestand(db) {
  const b = {};
  for (const [t] of werte(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const ohneRowid = /WITHOUT ROWID/i.test(werte(db, `SELECT sql FROM sqlite_master WHERE name='${t}'`)[0][0]);
    b[t] = new Map(werte(db, ohneRowid ? `SELECT * FROM ${t}` : `SELECT rowid, * FROM ${t}`)
      .map((v, i) => ohneRowid ? [String(i) + zeile(v), zeile(v)] : [v[0], zeile(v.slice(1))]));
  }
  return b;
}
// Verstöße je „tabelle.spalte→eltern" mit den rowids
function verstoesse(db) {
  const m = {};
  for (const [t, rowid, auf, fkid] of werte(db, 'PRAGMA foreign_key_check')) {
    const fk = werte(db, `PRAGMA foreign_key_list(${t})`).find(v => v[0] === fkid);
    const k = `${t}.${fk[3]}→${auf}`;
    (m[k] = m[k] || []).push(rowid);
  }
  return m;
}
const istAnhaengsel = (k) => reste.ANHAENGSEL.some(a => `${a.tabelle}.${a.spalte}→${a.auf}` === k);

function start(dbPfad) {
  const skript = `process.env.DB_PATH=${JSON.stringify(dbPfad)};process.env.JWT_SECRET='x'.repeat(40);
    const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))});
    m.initDatabase().then(() => { m.saveToFile(); process.exit(0); });`;
  return spawnSync('node', ['-e', skript], { encoding: 'utf8', timeout: 180000 });
}

function hole(port, pfad, token) {
  return new Promise((res, rej) => {
    const r = http.request({ host: 'localhost', port, path: pfad, method: 'GET', headers: { Authorization: 'Bearer ' + token } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res({ status: x.statusCode, text: s })); });
    r.on('error', rej); r.end();
  });
}
const gesund = (port) => new Promise(res => {
  const r = http.request({ host: 'localhost', port, path: '/health', method: 'GET' }, x => { x.resume(); res(x.statusCode === 200); });
  r.on('error', () => res(false)); r.end();
});

(async () => {
  const SQL = await initSqlJs();

  // ── 1: Zeile für Zeile ─────────────────────────────────────────────────────────────────────────
  if (!ROH.length) console.log('Rohkopie fehlt — Teil 1 übersprungen');
  for (const vorlage of ROH) {
    console.log(`\n1. Zeile für Zeile: ${vorlage}`);
    const summeVorlage = summe(vorlage);
    const alt = new SQL.Database(fs.readFileSync(vorlage));
    const vorher = bestand(alt);
    const vVorher = verstoesse(alt);
    alt.close();
    // Was SQLite selbst als Anhängsel ohne Gegenstück meldet — das und nur das darf fehlen
    const erwartet = {};
    for (const [k, rowids] of Object.entries(vVorher)) if (istAnhaengsel(k)) {
      const t = k.split('.')[0]; (erwartet[t] = erwartet[t] || new Set()); rowids.forEach(r => erwartet[t].add(r));
    }
    const kopie = '/tmp/reste-prodklon-' + path.basename(vorlage);
    fs.copyFileSync(vorlage, kopie);
    const lauf = start(kopie);
    ok('Start läuft durch', lauf.status === 0, (lauf.stderr || '').slice(0, 300));
    const meldung = ((lauf.stdout || '').match(/\[reste\] (.*)/) || [])[1] || '(keine)';
    console.log('    Start meldet: ' + meldung);

    const neu = new SQL.Database(fs.readFileSync(kopie));
    const nachher = bestand(neu);
    const vNachher = verstoesse(neu);
    const protokoll = werte(neu, "SELECT id, username, action, details FROM audit_logs WHERE action = 'reste_aufgeraeumt'");
    neu.close();

    ok('dieselben Tabellen wie vorher', JSON.stringify(Object.keys(nachher)) === JSON.stringify(Object.keys(vorher)));
    const abweichung = [];
    let entfernt = 0;
    for (const t of Object.keys(vorher)) {
      const v = vorher[t], n = nachher[t] || new Map(), weg = erwartet[t] || new Set();
      for (const [rid, inhalt] of v) {
        if (weg.has(rid)) { if (n.has(rid)) abweichung.push(`${t} #${rid}: sollte weg sein`); else entfernt++; continue; }
        if (!n.has(rid)) abweichung.push(`${t} #${rid}: FEHLT`);
        else if (n.get(rid) !== inhalt) abweichung.push(`${t} #${rid}: GEÄNDERT`);
      }
      for (const rid of n.keys()) if (!v.has(rid) && !(t === 'audit_logs' && protokoll.some(p => p[0] === rid))) abweichung.push(`${t} #${rid}: NEU`);
    }
    const erwartetZahl = Object.values(erwartet).reduce((s, x) => s + x.size, 0);
    ok(`genau die ${erwartetZahl} gemeldeten Anhängsel sind weg, jede andere Zeile jeder Tabelle zeichengleich`,
      abweichung.length === 0 && entfernt === erwartetZahl, `${entfernt} entfernt · ` + abweichung.slice(0, 8).join(' | ') + (abweichung.length > 8 ? ` … (${abweichung.length})` : ''));
    console.log('    entfernt je Tabelle: ' + Object.entries(erwartet).map(([t, s]) => `${t} ${s.size}`).join(', '));
    // Unabhängig von der Einordnung in reste.js (sonst bliebe eine Fehl-Einordnung hier grün): Ändern dürfen sich
    // NUR diese Tabellen — das, was Alex zum Aufräumen freigegeben hat (Zuweisungs-Reste + Kleinkram) — und das
    // Protokoll um genau einen Eintrag. Alles andere, allem voran Zeiteinträge und Planungen, bleibt vollständig.
    const DUERFEN = ['planning_assignments', 'user_target_hours', 'user_seen', 'planning_reminder_sent', 'audit_logs'];
    const geaendert = Object.keys(vorher).filter(t => JSON.stringify([...vorher[t]]) !== JSON.stringify([...(nachher[t] || new Map())]));
    ok('geändert haben sich nur ' + DUERFEN.join(', '), geaendert.every(t => DUERFEN.includes(t)), JSON.stringify(geaendert));
    ok('Zeiteinträge, Abwesenheiten, Planungen, Notizen, Projekte, Konten: vollständig und zeichengleich',
      ['entries', 'absences', 'planning_entries', 'planning_series', 'notes', 'projects', 'users']
        .every(t => JSON.stringify([...vorher[t]]) === JSON.stringify([...nachher[t]])));
    ok('genau ein Protokolleintrag „System · Datenreste aufgeräumt" mit den Zahlen', erwartetZahl === 0
      ? protokoll.length === 0
      : protokoll.length === 1 && protokoll[0][1] === 'System' && /^Start: /.test(protokoll[0][3]), JSON.stringify(protokoll));
    const bleibtVorher = Object.fromEntries(Object.entries(vVorher).filter(([k]) => !istAnhaengsel(k)).map(([k, r]) => [k, r.length]));
    const bleibtNachher = Object.fromEntries(Object.entries(vNachher).filter(([k]) => !istAnhaengsel(k)).map(([k, r]) => [k, r.length]));
    ok('danach keine Anhängsel-Verstöße mehr', Object.keys(vNachher).every(k => !istAnhaengsel(k)), JSON.stringify(Object.keys(vNachher)));
    ok('Inhalt mit Verweis ins Leere unverändert da: ' + JSON.stringify(bleibtVorher), JSON.stringify(bleibtNachher) === JSON.stringify(bleibtVorher), JSON.stringify(bleibtNachher));
    const zweit = start(kopie);
    ok('zweiter Start: nichts mehr aufzuräumen', zweit.status === 0 && !/\[reste\]/.test(zweit.stdout || ''), (zweit.stdout || '').match(/\[reste\].*/));
    ok('die Vorlage selbst ist unverändert', summe(vorlage) === summeVorlage);
    try { fs.unlinkSync(kopie); } catch (_) {}
  }

  // ── 2: Was die App zeigt ───────────────────────────────────────────────────────────────────────
  if (!fs.existsSync(KLON) || !fs.existsSync(path.join(ALT_DIR, 'server.js'))) {
    console.log('\n2. Nullprobe übersprungen (' + (fs.existsSync(KLON) ? ALT_DIR : KLON) + ' fehlt)');
  } else {
    console.log('\n2. Was die App zeigt: vorher (' + ALT_DIR + ') gegen jetzt');
    fs.copyFileSync(KLON, DB_ALT); fs.copyFileSync(KLON, DB_NEU);
    const db = new SQL.Database(fs.readFileSync(KLON));
    const konten = werte(db, 'SELECT id FROM users ORDER BY id').map(v => v[0]);
    const adminId = werte(db, "SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 LIMIT 1")[0][0];
    const planungen = werte(db, 'SELECT id FROM planning_entries ORDER BY id').map(v => v[0]);
    // Planungen, deren Zuweisungen an gelöschte Konten jetzt wegfallen — die interessantesten
    const betroffen = werte(db, 'SELECT DISTINCT planning_id FROM planning_assignments WHERE user_id NOT IN (SELECT id FROM users) AND planning_id IN (SELECT id FROM planning_entries)').map(v => v[0]);
    db.close();
    console.log(`    ${konten.length} Konten · ${planungen.length} Planungen · betroffen: ${JSON.stringify(betroffen)}`);
    const token = jwt.sign({ userId: adminId, role: 'admin' }, SECRET, { expiresIn: '2h' });
    const los = (dir, port, dbPfad, log) => spawn('node', ['server.js'], { cwd: dir,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPfad, JWT_SECRET: SECRET }, stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] });
    const sAlt = los(ALT_DIR, PORT_ALT, DB_ALT, '/tmp/reste-null-alt.log');
    const sNeu = los(WURZEL, PORT_NEU, DB_NEU, '/tmp/reste-null-neu.log');
    try {
      for (let i = 0; i < 160; i++) { if (await gesund(PORT_ALT) && await gesund(PORT_NEU)) break; await sleep(250); }
      ok('beide Server laufen', await gesund(PORT_ALT) && await gesund(PORT_NEU));
      ok('der neue hat beim Start aufgeräumt, der alte nicht',
        /\[reste\] Start: /.test(fs.readFileSync('/tmp/reste-null-neu.log', 'utf8')) && !/\[reste\]/.test(fs.readFileSync('/tmp/reste-null-alt.log', 'utf8')));
      const pfade = ['/api/planning?date_from=2000-01-01&date_to=2100-12-31', '/api/users', '/api/projects', '/api/absences',
        ...planungen.map(p => `/api/planning/${p}`), ...konten.map(k => `/api/statistics/overtime?user_id=${k}`)];
      const anders = [];
      let geprueft = 0;
      for (const p of pfade) {
        const [a, n] = await Promise.all([hole(PORT_ALT, p, token), hole(PORT_NEU, p, token)]);
        geprueft++;
        if (a.status !== n.status || a.text !== n.text) anders.push(`${p} (${a.status}/${n.status})`);
      }
      ok(`${geprueft} Abfragen zeichengleich (Planung gesamt + jede einzeln, Konten, Projekte, Abwesenheiten, Überstunden je Konto)`,
        anders.length === 0, anders.slice(0, 6).join(' | '));
      const probe = await hole(PORT_NEU, `/api/planning/${betroffen[0] || planungen[0]}`, token);
      ok('betroffene Planung ist abrufbar (keine Fehlermeldung)', probe.status === 200, probe.text.slice(0, 160));
      // Gegenprobe: misst der Vergleich überhaupt? Eine Planung im neuen Server ändern → muss auffallen
      const ziel = planungen[planungen.length - 1];
      const vorAend = (await hole(PORT_NEU, `/api/planning/${ziel}`, token)).text;
      await new Promise((res, rej) => { const d = JSON.stringify({ description: 'Gegenprobe', assigned_user_ids: [adminId] });
        const r = http.request({ host: 'localhost', port: PORT_NEU, path: `/api/planning/${ziel}`, method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, x => { x.resume(); x.on('end', res); });
        r.on('error', rej); r.write(d); r.end(); });
      const [a2, n2] = await Promise.all([hole(PORT_ALT, `/api/planning/${ziel}`, token), hole(PORT_NEU, `/api/planning/${ziel}`, token)]);
      ok('Gegenprobe: eine geänderte Planung fällt dem Vergleich auf', a2.text !== n2.text && n2.text !== vorAend, n2.text.slice(0, 120));
    } finally {
      for (const s of [sAlt, sNeu]) s.kill('SIGTERM');
      await sleep(800);
    }
  }

  console.log(`\nReste aufräumen (Prod-Klon): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
