// Reste aufräumen an echten Daten (R27 + Altlasten gelöschter Konten, Prod-Klon, 28.09.2026).
//
// Alex' Bedingung: kein Verlust an Produktivdaten. Freigegeben zum Aufräumen: die Anhängsel ohne Gegenstück
// (Einteilungen zu gelöschten Planungen, Kleinkram gelöschter Konten) und der Inhalt früh gelöschter
// Testkonten („Können weg. Waren Testläufe."). Zwei Beweise an Kopien der Produktivdaten:
//
// 1. ZEILE FÜR ZEILE (frische Rohkopie, der Start wie im Betrieb). Was fehlen darf, wird HIER unabhängig
//    berechnet — aus SQLite selbst (PRAGMA foreign_key_check) und aus „gehört einem Konto, das es nicht mehr
//    gibt", nicht aus reste.js / konto-loeschen.js. Genau das fehlt, jede andere Zeile jeder Tabelle ist
//    zeichengleich. Die harten Zusicherungen: KEIN Zeiteintrag, keine Abwesenheit, keine Notiz eines
//    vorhandenen Kontos fehlt; KEINE sichtbare Planung (Ersteller vorhanden), in der ein vorhandenes Konto
//    eingeteilt ist, fehlt. Nur die
//    freigegebenen Tabellen ändern sich (feste Liste im Test). Zweiter Start: nichts mehr.
//
// 2. WAS DIE APP ZEIGT (Nullprobe): zwei Server auf je einer Kopie derselben Daten — der Stand VOR dieser
//    Arbeit (/tmp/nullprobe-stand) und der aktuelle. Planung (alle Tage, jede einzeln), Konten, Projekte,
//    Abwesenheiten und Überstunden jedes Kontos müssen gleich sein — bis auf genau die Planungen, die nur
//    noch gelöschten Konten gehörten. Gegenprobe: eine geänderte Planung fällt dem Vergleich auf.
//
// Voraussetzung (fehlt etwas, wird der jeweilige Teil übersprungen):
//   /tmp/prodklon-frisch-roh.db   frische Rohkopie (nur lesend geholt)
//   git worktree add --detach /tmp/nullprobe-stand <commit vor R27>; node_modules verlinken
//
//   node tests/reste-prodklon.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const WURZEL = path.join(__dirname, '..');
// Nur die FRISCHE Rohkopie: Sie steht auf dem Schema des laufenden Betriebs, beim Start läuft außer dem Aufräumen
// nichts. Ältere Kopien (z. B. /tmp/prodklon-echt.db) ziehen noch frühere Umstellungen hoch — dort ändern sich
// Zeilen aus anderem Grund, ein Zeichengleich-Vergleich wäre sinnlos.
const ROH = ['/tmp/prodklon-frisch-roh.db'].filter(p => fs.existsSync(p));
// Der Klon für die Nullprobe wird HIER frisch aus der Rohkopie gebaut: /tmp/prodklon.db beschreiben andere
// Tests (sie starten Server direkt darauf) — dann ist dort schon aufgeräumt, und der Vergleich misst nichts.
const KLON = '/tmp/reste-prodklon-klon.db', ALT_DIR = '/tmp/nullprobe-stand';
const PORT_ALT = 3347, PORT_NEU = 3348, DB_ALT = '/tmp/reste-null-alt.db', DB_NEU = '/tmp/reste-null-neu.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
// Was sich überhaupt ändern darf — fest, unabhängig vom Code (sonst bliebe eine Fehl-Einordnung dort grün)
const DUERFEN = ['planning_assignments', 'user_target_hours', 'user_seen', 'planning_reminder_sent',
  'entries', 'entry_history', 'absences', 'absence_history', 'notes', 'note_shares', 'planning_entries', 'tool_checkouts', 'settings', 'audit_logs'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const summe = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const werte = (db, sql) => { const r = db.exec(sql); return r.length ? r[0].values : []; };
const zeile = (v) => JSON.stringify(v.map(x => x instanceof Uint8Array ? 'b64:' + Buffer.from(x).toString('base64') : x));

function bestand(db) {
  const b = {};
  for (const [t] of werte(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const ohneRowid = /WITHOUT ROWID/i.test(werte(db, `SELECT sql FROM sqlite_master WHERE name='${t}'`)[0][0]);
    b[t] = new Map(werte(db, ohneRowid ? `SELECT * FROM ${t}` : `SELECT rowid, * FROM ${t}`)
      .map((v, i) => ohneRowid ? [String(i) + zeile(v), zeile(v)] : [v[0], zeile(v.slice(1))]));
  }
  return b;
}
const liste = (db, sql) => new Set(werte(db, sql).map(v => v[0]));

// Was fehlen darf — unabhängig vom Code berechnet
function erwartung(db) {
  const e = {};
  const dazu = (t, ids) => { e[t] = e[t] || new Set(); for (const i of ids) e[t].add(i); };
  // a) Anhängsel ohne Gegenstück, wie SQLite sie meldet (Tabellen, die die Anhängsel-Regel betrifft)
  const anhaengsel = ['planning_assignments', 'planning_reminder_sent', 'user_target_hours', 'user_seen', 'note_shares', 'note_offers',
    'project_assignments', 'project_category_links', 'project_milestones', 'product_barcodes', 'product_suppliers', 'tool_checkouts',
    'employment_periods', 'vacation_entitlements', 'user_sitzung', 'user_avatars', 'geburtstag_freigabe', 'push_prefs', 'push_subscriptions',
    'summary_schedules', 'warnung_prefs', 'twofa_secrets', 'twofa_devices', 'planning_reminders'];
  for (const [t, rowid] of werte(db, 'PRAGMA foreign_key_check')) if (anhaengsel.includes(t)) dazu(t, [rowid]);
  // b) Inhalt von Konten, die es nicht mehr gibt (und die in keiner Abrechnung stehen)
  const fehlend = `(SELECT id FROM (SELECT user_id AS id FROM entries UNION SELECT user_id FROM absences UNION SELECT user_id FROM notes
    UNION SELECT user_id FROM planning_assignments UNION SELECT created_by FROM planning_entries UNION SELECT user_id FROM tool_checkouts)
    WHERE id IS NOT NULL AND id NOT IN (SELECT id FROM users) AND id NOT IN (SELECT user_id FROM payroll_closure_rows))`;
  dazu('entries', liste(db, `SELECT rowid FROM entries WHERE user_id IN ${fehlend}`));
  dazu('entry_history', liste(db, `SELECT rowid FROM entry_history WHERE entry_id IN (SELECT id FROM entries WHERE user_id IN ${fehlend})`));
  dazu('absences', liste(db, `SELECT rowid FROM absences WHERE user_id IN ${fehlend}`));
  dazu('absence_history', liste(db, `SELECT rowid FROM absence_history WHERE absence_id IN (SELECT id FROM absences WHERE user_id IN ${fehlend})`));
  dazu('notes', liste(db, `SELECT rowid FROM notes WHERE user_id IN ${fehlend}`));
  dazu('note_shares', liste(db, `SELECT rowid FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE user_id IN ${fehlend})`));
  dazu('tool_checkouts', liste(db, `SELECT rowid FROM tool_checkouts WHERE user_id IN ${fehlend}`));
  // Planungen: von einem gelöschten Konto angelegt, oder eingeteilt nur noch gelöschte Konten
  const planungen = liste(db, `SELECT id FROM planning_entries pe WHERE created_by IN ${fehlend}
    OR (EXISTS (SELECT 1 FROM planning_assignments pa WHERE pa.planning_id = pe.id)
        AND NOT EXISTS (SELECT 1 FROM planning_assignments pa JOIN users u ON u.id = pa.user_id WHERE pa.planning_id = pe.id))`);
  dazu('planning_entries', liste(db, `SELECT rowid FROM planning_entries WHERE id IN (${[...planungen].join(',') || 0})`));
  dazu('planning_assignments', liste(db, `SELECT rowid FROM planning_assignments WHERE planning_id IN (${[...planungen].join(',') || 0})`));
  for (const t of Object.keys(e)) if (!e[t].size) delete e[t];
  return { weg: e, planungen };
}

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
const alsListe = (text) => { const j = JSON.parse(text); return Array.isArray(j) ? j : (j.entries || j.planning || []); };

(async () => {
  const SQL = await initSqlJs();

  // ── 1: Zeile für Zeile ─────────────────────────────────────────────────────────────────────────
  if (!ROH.length) console.log('Rohkopie fehlt — Teil 1 übersprungen');
  for (const vorlage of ROH) {
    console.log(`\n1. Zeile für Zeile: ${vorlage}`);
    const summeVorlage = summe(vorlage);
    const alt = new SQL.Database(fs.readFileSync(vorlage));
    const vorher = bestand(alt);
    const { weg: erwartet } = erwartung(alt);
    const inhaltVorhandener = (db) => ['entries', 'absences', 'notes'].map(t =>
      t + ':' + zeile(werte(db, `SELECT rowid, * FROM ${t} WHERE user_id IN (SELECT id FROM users) ORDER BY rowid`).map(zeile))).join('|');
    // Sichtbar war eine Planung nur mit vorhandenem Ersteller (die Planung verknüpfte ihn fest) — eine von einem
    // gelöschten Konto angelegte war seither für niemanden zu sehen (die freigegebene Test-Planung).
    const planungMitVorhandenen = (db) => zeile(werte(db, `SELECT rowid, * FROM planning_entries pe
      WHERE pe.created_by IN (SELECT id FROM users) AND EXISTS
      (SELECT 1 FROM planning_assignments pa JOIN users u ON u.id = pa.user_id WHERE pa.planning_id = pe.id) ORDER BY rowid`).map(zeile));
    const inhaltAlt = inhaltVorhandener(alt), planungAlt = planungMitVorhandenen(alt);
    // Seit dem Deploy (28.09.2026) ist Produktion schon aufgeräumt: Die Kopie bringt die Protokolleinträge von
    // damals und den Merker mit. Zählen darf nur, was DIESER Start schreibt — sonst „erklärt" das alte
    // Protokoll Zeilen, die hier gar nicht weg sind (am 29.09. rot: „2659 von 0").
    const protokollVorher = new Set(werte(alt, "SELECT id FROM audit_logs WHERE action = 'reste_aufgeraeumt'").map(v => v[0]));
    const schonAufgeraeumt = werte(alt, "SELECT 1 FROM settings WHERE key = 'altlasten_geloeschte_konten'").length > 0;
    alt.close();

    const kopie = '/tmp/reste-prodklon-' + path.basename(vorlage);
    fs.copyFileSync(vorlage, kopie);
    const lauf = start(kopie);
    ok('Start läuft durch', lauf.status === 0, (lauf.stderr || '').slice(0, 300));
    for (const m of (lauf.stdout || '').match(/\[reste\] .*/g) || []) console.log('    ' + m);

    const neu = new SQL.Database(fs.readFileSync(kopie));
    const nachher = bestand(neu);
    const protokoll = werte(neu, "SELECT id, username, details FROM audit_logs WHERE action = 'reste_aufgeraeumt' ORDER BY id")
      .filter(p => !protokollVorher.has(p[0]));
    const merker = werte(neu, "SELECT rowid FROM settings WHERE key = 'altlasten_geloeschte_konten'").map(v => v[0]);
    const inhaltNeu = inhaltVorhandener(neu), planungNeu = planungMitVorhandenen(neu);
    const verstoesseNachher = werte(neu, 'PRAGMA foreign_key_check').map(v => v[0]);
    neu.close();

    ok('dieselben Tabellen wie vorher', JSON.stringify(Object.keys(nachher)) === JSON.stringify(Object.keys(vorher)));
    const abweichung = []; let entfernt = 0;
    for (const t of Object.keys(vorher)) {
      const v = vorher[t], n = nachher[t] || new Map(), w = erwartet[t] || new Set();
      for (const [rid, inhalt] of v) {
        if (w.has(rid)) { if (n.has(rid)) abweichung.push(`${t} #${rid}: sollte weg sein`); else entfernt++; continue; }
        if (!n.has(rid)) abweichung.push(`${t} #${rid}: FEHLT`);
        else if (n.get(rid) !== inhalt) abweichung.push(`${t} #${rid}: GEÄNDERT`);
      }
      for (const rid of n.keys()) {
        if (v.has(rid) || (t === 'audit_logs' && protokoll.some(p => p[0] === rid)) || (t === 'settings' && merker.includes(rid))) continue;
        abweichung.push(`${t} #${rid}: NEU`);
      }
    }
    const erwartetZahl = Object.values(erwartet).reduce((s, x) => s + x.size, 0);
    console.log('    weg je Tabelle: ' + Object.entries(erwartet).map(([t, s]) => `${t} ${s.size}`).join(', '));
    ok(`genau die ${erwartetZahl} unabhängig berechneten Zeilen sind weg, jede andere Zeile jeder Tabelle zeichengleich`,
      abweichung.length === 0 && entfernt === erwartetZahl, `${entfernt} entfernt · ` + abweichung.slice(0, 8).join(' | ') + (abweichung.length > 8 ? ` … (${abweichung.length})` : ''));
    const geaendert = Object.keys(vorher).filter(t => JSON.stringify([...vorher[t]]) !== JSON.stringify([...(nachher[t] || new Map())]));
    ok('geändert haben sich nur freigegebene Tabellen: ' + geaendert.join(', '), geaendert.every(t => DUERFEN.includes(t)), JSON.stringify(geaendert.filter(t => !DUERFEN.includes(t))));
    ok('KEIN Zeiteintrag, keine Abwesenheit, keine Notiz eines vorhandenen Kontos fehlt oder ist verändert', inhaltNeu === inhaltAlt);
    ok('KEINE sichtbare Planung (Ersteller vorhanden), in der ein vorhandenes Konto eingeteilt ist, fehlt oder ist verändert', planungNeu === planungAlt);
    ok('keine Konten verändert, keine Abrechnung verändert', ['users', 'payroll_closures', 'payroll_closure_rows']
      .every(t => JSON.stringify([...vorher[t]]) === JSON.stringify([...nachher[t]])));
    if (!schonAufgeraeumt) {
      ok('Protokoll: je ein Eintrag „System" für Altlasten und Anhängsel, Merker gesetzt',
        protokoll.length === 2 && protokoll.every(p => p[1] === 'System') && /^Inhalt früh gelöschter Konten/.test(protokoll[0][2])
          && /^Start: /.test(protokoll[1][2]) && merker.length === 1, JSON.stringify(protokoll));
    } else {
      // Schon aufgeräumt: Die Altlasten kommen nie ein zweites Mal; ein Eintrag „Start" nur, wenn etwas weg ist.
      ok(`Protokoll (Kopie war schon aufgeräumt): keine Altlasten mehr, ${entfernt ? 'ein Eintrag „Start"' : 'kein neuer Eintrag'}, Merker bleibt`,
        protokoll.every(p => p[1] === 'System') && !protokoll.some(p => /^Inhalt früh gelöschter Konten/.test(p[2]))
          && (entfernt ? protokoll.length === 1 && /^Start: /.test(protokoll[0][2]) : protokoll.length === 0) && merker.length === 1,
        JSON.stringify(protokoll));
    }
    // Das Protokoll muss jede entfernte Zeile erklären (Verlauf zählt mit seinem Eintrag, nicht einzeln)
    const imProtokoll = protokoll.map(p => p[2].replace(/\(Nr\.[^)]*\)/, '')).join(' ').match(/\d+/g) || [];
    const erklaert = imProtokoll.reduce((s, x) => s + Number(x), 0);
    const ohneVerlauf = entfernt - ['entry_history', 'absence_history'].reduce((s, t) => s + ((erwartet[t] || new Set()).size), 0);
    ok(`das Protokoll erklärt jede entfernte Zeile (${erklaert} von ${ohneVerlauf})`, erklaert === ohneVerlauf, JSON.stringify(protokoll.map(p => p[2])));
    ok('danach Verweise ins Leere nur noch bei Inhalt, der bleibt (Einträge/Planungen gelöschter Projekte)',
      verstoesseNachher.every(t => ['entries', 'planning_entries'].includes(t)), JSON.stringify([...new Set(verstoesseNachher)]));
    const zweit = start(kopie);
    ok('zweiter Start: nichts mehr aufzuräumen', zweit.status === 0 && !/\[reste\]/.test(zweit.stdout || ''), (zweit.stdout || '').match(/\[reste\].*/g));
    ok('die Vorlage selbst ist unverändert', summe(vorlage) === summeVorlage);
    try { fs.unlinkSync(kopie); } catch (_) {}
  }

  // ── 2: Was die App zeigt ───────────────────────────────────────────────────────────────────────
  if (ROH.length) spawnSync('node', [path.join(WURZEL, 'scripts', 'prodklon-vorbereiten.js'), ROH[0], KLON], { encoding: 'utf8', timeout: 120000 });
  if (!ROH.length || !fs.existsSync(KLON) || !fs.existsSync(path.join(ALT_DIR, 'server.js'))) {
    console.log('\n2. Nullprobe übersprungen (' + (ROH.length ? ALT_DIR : 'Rohkopie') + ' fehlt)');
  } else {
    console.log('\n2. Was die App zeigt: vorher (' + ALT_DIR + ') gegen jetzt');
    fs.copyFileSync(KLON, DB_ALT); fs.copyFileSync(KLON, DB_NEU);
    const db = new SQL.Database(fs.readFileSync(KLON));
    const konten = werte(db, 'SELECT id FROM users ORDER BY id').map(v => v[0]);
    const adminId = werte(db, "SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 LIMIT 1")[0][0];
    const planungen = werte(db, 'SELECT id FROM planning_entries ORDER BY id').map(v => v[0]);
    const wegPlanungen = [...erwartung(db).planungen];
    db.close();
    console.log(`    ${konten.length} Konten · ${planungen.length} Planungen · gehörten nur gelöschten Konten: ${JSON.stringify(wegPlanungen)}`);
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
      // Die Gesamtliste: beim alten Stand die weggefallenen Planungen herausnehmen, dann muss sie gleich sein
      const gesamt = '/api/planning?date_from=2000-01-01&date_to=2100-12-31';
      const [ga, gn] = await Promise.all([hole(PORT_ALT, gesamt, token), hole(PORT_NEU, gesamt, token)]);
      const la = alsListe(ga.text), ln = alsListe(gn.text);
      const sichtbarWeg = la.filter(p => wegPlanungen.includes(p.id)).map(p => `${p.id} (${p.date}, „${p.client || p.project_text || ''}")`);
      console.log(`    im alten Stand sichtbar und jetzt weg: ${sichtbarWeg.join(', ') || 'keine'}`);
      ok(`Planung gesamt: ${la.length} → ${ln.length}, sonst zeichengleich`,
        ga.status === 200 && gn.status === 200 && JSON.stringify(la.filter(p => !wegPlanungen.includes(p.id))) === JSON.stringify(ln)
          && la.length - ln.length === sichtbarWeg.length);
      const pfade = ['/api/users', '/api/projects', '/api/absences', '/api/bulletin', '/api/orders',
        ...planungen.filter(p => !wegPlanungen.includes(p)).map(p => `/api/planning/${p}`), ...konten.map(k => `/api/statistics/overtime?user_id=${k}`)];
      const anders = [];
      for (const p of pfade) {
        const [a, n] = await Promise.all([hole(PORT_ALT, p, token), hole(PORT_NEU, p, token)]);
        if (a.status !== n.status || a.text !== n.text) anders.push(`${p} (${a.status}/${n.status})`);
      }
      ok(`${pfade.length} weitere Abfragen zeichengleich (jede verbliebene Planung einzeln, Konten, Projekte, Abwesenheiten, Aushänge, Bestellungen, Überstunden je Konto)`,
        anders.length === 0, anders.slice(0, 6).join(' | '));
      const wegNeu = await Promise.all(wegPlanungen.map(p => hole(PORT_NEU, `/api/planning/${p}`, token)));
      ok('die weggefallenen Planungen gibt es im neuen Stand nicht mehr (404)', wegNeu.every(r => r.status === 404), wegNeu.map(r => r.status).join(','));
      // Gegenprobe: misst der Vergleich überhaupt? Eine Planung im neuen Server ändern → muss auffallen
      const ziel = planungen.filter(p => !wegPlanungen.includes(p)).pop();
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
