// Reste beim Löschen (R27, 28.09.2026).
//
// Der Fremdschlüssel-Schutz ist bewusst aus (sql.js schaltete ihn beim Speichern ohnehin ab) — „ON DELETE
// CASCADE" wirkt nicht. Die Regeln stehen in reste.js. Geprüft:
//   A. Der Schutz ist verlässlich aus: nach dem Start UND nach dem Speichern (vorher: an bis zum ersten Autosave).
//   B. Jeder Fremdschlüssel des Schemas ist eingeordnet — Anhängsel ODER Inhalt, genau einmal; keine Liste
//      nennt einen Verweis, den es nicht gibt. Eine neue Tabelle mit Verweis macht diesen Test rot.
//   C. aufraeumen(): entfernt genau die Anhängsel ohne Gegenstück (auch zweite Stufe), lässt Gültiges und
//      ALLEN Inhalt stehen, protokolliert einmal; zweiter Lauf findet nichts. nachLoeschen() nur das Betroffene.
//   D. Quelltext-Wächter: `DELETE FROM planning_entries` nur in planungenLoeschen; jeder Weg, der eine Tabelle
//      mit Anhängseln hart löscht, räumt sie mit ab.
//   E. Über die Schnittstelle (Server ohne Neustart, Tageslauf ruht): Planung löschen (einzeln, Gruppe, Gruppe
//      ersetzen, Serie), Projekt endgültig löschen, Konto endgültig löschen → keine Reste; Inhalt bleibt.
//
//   node tests/reste.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');
const reste = require('../reste');

const PORT = 3346, DB = '/tmp/reste.db', LOG = '/tmp/reste.log', LEER = '/tmp/reste-leer.db';
const WURZEL = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const werte = (db, sql, p) => { const s = db.prepare(sql); if (p) s.bind(p); const z = []; while (s.step()) z.push(s.get()); s.free(); return z; };
const eins = (db, sql, p) => (werte(db, sql, p)[0] || [])[0];

// Wie der Server startet — in einem eigenen Prozess (init hat einen Autosave-Takt), danach speichern.
function starteInit(dbPfad, nachher) {
  const skript = `process.env.DB_PATH=${JSON.stringify(dbPfad)};process.env.JWT_SECRET='x'.repeat(40);
    const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))});
    m.initDatabase().then(() => { const d = m.getDb(); const vor = d.prepare('PRAGMA foreign_keys').get();
      m.saveToFile(); const nach = d.prepare('PRAGMA foreign_keys').get(); ${nachher || ''}
      console.log('FK=' + JSON.stringify([vor, nach])); process.exit(0); });`;
  return spawnSync('node', ['-e', skript], { encoding: 'utf8', timeout: 120000 });
}

(async () => {
  const SQL = await initSqlJs();

  // ── A: Schutz verlässlich aus ───────────────────────────────────────────────────────────────────
  console.log('A. Fremdschlüssel-Schutz');
  try { fs.unlinkSync(LEER); } catch (_) {}
  const lauf = starteInit(LEER);
  const fk = JSON.parse(((lauf.stdout || '').match(/FK=(.*)/) || [])[1] || 'null');
  ok('nach dem Start aus und nach dem Speichern aus (nicht mehr: an bis zum ersten Autosave)',
    fk && fk[0].foreign_keys === 0 && fk[1].foreign_keys === 0, JSON.stringify(fk) + ' ' + (lauf.stderr || '').slice(0, 200));

  // ── B: jeder Fremdschlüssel eingeordnet ─────────────────────────────────────────────────────────
  console.log('B. Jeder Verweis ist eingeordnet');
  const leer = new SQL.Database(fs.readFileSync(LEER));
  const tabellen = werte(leer, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(z => z[0]);
  const schema = [];
  for (const t of tabellen) for (const v of werte(leer, `PRAGMA foreign_key_list(${t})`)) schema.push({ tabelle: t, spalte: v[3], auf: v[2], nach: v[4] });
  const schluessel = (x) => `${x.tabelle}.${x.spalte}→${x.auf}`;
  const eingeordnet = [...reste.ANHAENGSEL, ...reste.BLEIBT].map(schluessel);
  const ohne = schema.filter(x => !eingeordnet.includes(schluessel(x))).map(schluessel);
  ok(`alle ${schema.length} Verweise stehen in reste.js (Anhängsel oder Inhalt)`, ohne.length === 0, 'nicht eingeordnet: ' + ohne.join(', '));
  const doppelt = eingeordnet.filter((k, i) => eingeordnet.indexOf(k) !== i);
  ok('keiner steht doppelt', doppelt.length === 0, doppelt.join(', '));
  const erfunden = eingeordnet.filter(k => !schema.some(x => schluessel(x) === k));
  ok('die Listen nennen keinen Verweis, den es nicht gibt', erfunden.length === 0, erfunden.join(', '));
  ok('alle Verweise zeigen auf die Nummer (id) ihres Gegenstücks', schema.every(x => x.nach === null || x.nach === 'id'),
    JSON.stringify(schema.filter(x => x.nach && x.nach !== 'id')));

  // ── C: aufraeumen / nachLoeschen an gebauten Daten ─────────────────────────────────────────────
  console.log('C. Aufräumen an gebauten Daten');
  // Die leere Datenbank ist der Grundstock (Seed-Konten, zwei Projekte). Darauf gezielt Reste und Gültiges.
  const wrap = (raw) => ({ prepare: (s) => ({ run: (...p) => { raw.run(s, p); return { changes: raw.getRowsModified() }; },
    get: (...p) => { const st = raw.prepare(s); st.bind(p); const r = st.step() ? st.getAsObject() : undefined; st.free(); return r; } }) });
  const baue = () => {
    const d = new SQL.Database(fs.readFileSync(LEER));
    const admin = eins(d, "SELECT id FROM users WHERE username='admin'");
    const projekt = eins(d, 'SELECT MIN(id) FROM projects');
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to) VALUES (500, ?, '2026-09-01', '07:00', '15:00')", [admin]);
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (500, ?)', [admin]);   // gültig
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (999, ?)', [admin]);   // Planung weg
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (500, 777)');         // Konto weg
    d.run("INSERT INTO planning_reminders (id, user_id, entry_id, lead_num, lead_unit) VALUES (40, ?, 500, 1, 'day')", [admin]);
    d.run("INSERT INTO planning_reminders (id, user_id, entry_id, lead_num, lead_unit) VALUES (41, 777, 500, 1, 'day')"); // Konto weg
    d.run("INSERT INTO planning_reminder_sent (reminder_id, occ_key) VALUES (40, 'a')");         // gültig
    d.run("INSERT INTO planning_reminder_sent (reminder_id, occ_key) VALUES (41, 'b')");         // zweite Stufe
    d.run("INSERT INTO planning_reminder_sent (reminder_id, occ_key) VALUES (42, 'c')");         // Erinnerung weg
    d.run("INSERT INTO user_target_hours (user_id, hours_per_week, valid_from) VALUES (777, 40, '2026-01-01')");
    d.run("INSERT INTO user_seen (user_id, topic) VALUES (777, 'notes')");
    d.run('INSERT INTO project_assignments (project_id, user_id) VALUES (888, ?)', [admin]);
    d.run('INSERT INTO project_milestones (project_id, title) VALUES (888, ?)', ['Rohbau']);
    // Inhalt mit Verweis ins Leere — muss bleiben
    d.run("INSERT INTO entries (user_id, date, time_from, time_to, net_hours, project_id, project_text) VALUES (777, '2026-03-20', '07:00', '12:00', 5, 888, 'Altprojekt')");
    d.run("INSERT INTO entries (user_id, date, time_from, time_to, net_hours, project_id) VALUES (?, '2026-03-21', '07:00', '12:00', 5, 888)", [admin]);
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to, project_id) VALUES (501, 777, '2026-09-02', '07:00', '15:00', 888)");
    d.run("INSERT INTO absences (user_id, type, date_from, date_to) VALUES (777, 'urlaub', '2026-03-23', '2026-03-24')");
    return { d, admin, projekt };
  };
  const inhalt = (d) => ['entries', 'planning_entries', 'absences', 'notes', 'projects', 'users']
    .map(t => t + ':' + JSON.stringify(werte(d, `SELECT * FROM ${t} ORDER BY rowid`))).join('|');

  {
    const { d, admin } = baue();
    const inhaltVorher = inhalt(d);
    const protokollVorher = eins(d, 'SELECT COUNT(*) FROM audit_logs');
    const weg = reste.aufraeumen(wrap(d), 'Probe');
    const zahl = (text) => (weg.find(w => w.text === text) || {}).anzahl || 0;
    ok('Zuweisung zu gelöschter Planung und an gelöschtes Konto entfernt, gültige bleibt',
      zahl('Planungs-Zuweisungen zu gelöschten Planungen') === 1 && zahl('Planungs-Zuweisungen an gelöschte Konten') === 1
        && JSON.stringify(werte(d, 'SELECT planning_id, user_id FROM planning_assignments')) === JSON.stringify([[500, admin]]), JSON.stringify(weg));
    ok('zweite Stufe: Erinnerung eines gelöschten Kontos samt ihrem Versand-Merker weg, gültiger Merker bleibt',
      JSON.stringify(werte(d, 'SELECT id FROM planning_reminders')) === '[[40]]'
        && JSON.stringify(werte(d, 'SELECT reminder_id, occ_key FROM planning_reminder_sent')) === '[[40,"a"]]',
      JSON.stringify(werte(d, 'SELECT reminder_id, occ_key FROM planning_reminder_sent')));
    ok('Soll-Stunden, Gesehen-Merker, Zuteilung und Zwischenziel ohne Gegenstück weg',
      eins(d, 'SELECT COUNT(*) FROM user_target_hours WHERE user_id = 777') === 0 && eins(d, 'SELECT COUNT(*) FROM user_seen WHERE user_id = 777') === 0
        && eins(d, 'SELECT COUNT(*) FROM project_assignments WHERE project_id = 888') === 0 && eins(d, 'SELECT COUNT(*) FROM project_milestones WHERE project_id = 888') === 0);
    ok('INHALT unverändert: Zeiteinträge, Planungen, Abwesenheiten mit Verweis ins Leere bleiben zeichengleich', inhalt(d) === inhaltVorher);
    const prot = werte(d, "SELECT username, action, details FROM audit_logs WHERE action = 'reste_aufgeraeumt'");
    ok('genau ein Protokolleintrag „System", mit Anlass und Zahlen', eins(d, 'SELECT COUNT(*) FROM audit_logs') === protokollVorher + 1
      && prot.length === 1 && prot[0][0] === 'System' && /^Probe: 1 Planungs-Zuweisungen zu gelöschten Planungen, /.test(prot[0][2]), JSON.stringify(prot));
    const zweit = reste.aufraeumen(wrap(d), 'Probe');
    ok('zweiter Lauf: nichts mehr da, kein weiterer Protokolleintrag', zweit.length === 0 && eins(d, "SELECT COUNT(*) FROM audit_logs WHERE action = 'reste_aufgeraeumt'") === 1);
    d.close();
  }
  {
    const { d } = baue();
    const w = reste.nachLoeschen(wrap(d), 'planning_entries');
    ok('nachLoeschen(planning_entries): nur die Zuweisung zur gelöschten Planung — Konto-Reste und Soll-Stunden bleiben liegen',
      w.length === 1 && w[0].anzahl === 1 && eins(d, 'SELECT COUNT(*) FROM planning_assignments WHERE user_id = 777') === 1
        && eins(d, 'SELECT COUNT(*) FROM user_target_hours WHERE user_id = 777') === 1 && eins(d, "SELECT COUNT(*) FROM audit_logs WHERE action='reste_aufgeraeumt'") === 0, JSON.stringify(w));
    const w2 = reste.nachLoeschen(wrap(d), 'planning_reminders');
    ok('nachLoeschen(planning_reminders): nur der Versand-Merker der fehlenden Erinnerung', w2.length === 1 && w2[0].anzahl === 1
      && eins(d, 'SELECT COUNT(*) FROM planning_reminder_sent') === 2, JSON.stringify(w2));
    const w3 = reste.nachLoeschen(wrap(d), 'users');
    ok('nachLoeschen(users): alles am fehlenden Konto, auch die zweite Stufe (Merker seiner Erinnerung)',
      eins(d, 'SELECT COUNT(*) FROM planning_reminders WHERE user_id = 777') === 0 && eins(d, "SELECT COUNT(*) FROM planning_reminder_sent WHERE occ_key = 'b'") === 0
        && eins(d, 'SELECT COUNT(*) FROM user_target_hours WHERE user_id = 777') === 0 && eins(d, 'SELECT COUNT(*) FROM entries WHERE user_id = 777') === 1, JSON.stringify(w3));
    d.close();
  }
  leer.close();

  // ── D: Quelltext-Wächter ───────────────────────────────────────────────────────────────────────
  console.log('D. Lösch-Wege im Quelltext');
  const dateien = [];
  const sammle = (dir) => { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n);
    if (['node_modules', 'public', 'tests', 'scripts', '.git', 'data'].includes(n)) continue;
    if (fs.statSync(p).isDirectory()) sammle(p); else if (n.endsWith('.js')) dateien.push(p); } };
  sammle(WURZEL);
  const quelle = Object.fromEntries(dateien.map(p => [path.relative(WURZEL, p), fs.readFileSync(p, 'utf8')]));
  const planungsStellen = Object.entries(quelle).flatMap(([f, s]) => s.split('\n').map((z, i) => ({ f, i, z })))
    .filter(x => /DELETE FROM planning_entries/.test(x.z));
  ok('`DELETE FROM planning_entries` steht nur in planungenLoeschen (routes/planning.js)',
    planungsStellen.length === 1 && planungsStellen[0].f === path.join('routes', 'planning.js')
      && /function planungenLoeschen/.test(quelle[path.join('routes', 'planning.js')].split('\n').slice(planungsStellen[0].i - 2, planungsStellen[0].i).join('\n')),
    planungsStellen.map(x => `${x.f}:${x.i + 1}`).join(', '));
  const eltern = [...new Set(reste.ANHAENGSEL.map(a => a.auf))];
  const luecken = [];
  for (const [f, s] of Object.entries(quelle)) {
    if (f === 'reste.js' || f.startsWith('database')) continue;
    for (const p of eltern) {
      if (!new RegExp(`DELETE FROM ${p}\\b`).test(s)) continue;
      if (p === 'planning_entries' && /reste\.nachLoeschen\(db, 'planning_entries'\)/.test(s)) continue;
      if (s.includes(`nachLoeschen(db, '${p}')`)) continue;
      // oder ausdrücklich jedes Anhängsel dieser Tabelle mitgelöscht
      const kinder = reste.ANHAENGSEL.filter(a => a.auf === p).map(a => a.tabelle);
      const fehlt = kinder.filter(k => !new RegExp(`DELETE FROM ${k}\\b|'${k}'`).test(s));
      if (fehlt.length) luecken.push(`${f}: löscht ${p}, lässt ${fehlt.join('/')} liegen`);
    }
  }
  ok('jeder Weg, der eine Tabelle mit Anhängseln hart löscht, räumt sie mit ab', luecken.length === 0, luecken.join(' | '));

  // ── E: über die Schnittstelle ──────────────────────────────────────────────────────────────────
  console.log('E. Lösch-Wege über die Schnittstelle');
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  let srv = spawn('node', ['server.js'], { cwd: WURZEL, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: ['ignore', lg, lg] });
  let beendet = false;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {}, t = {};
    for (const [u, n] of [['anna', 'Anna Berger'], ['tom', 'Tom Kraus'], ['olaf', 'Olaf Geht']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: 'mitarbeiter', hours_mon: 8 })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }
    const plane = async (b) => (await req('POST', '/api/planning', admin, { time_from: '07:00', time_to: '15:00', assigned_user_ids: [id.anna, id.tom], ...b })).body;
    // einzeln
    const einzel = (await plane({ date: '2026-10-05', client: 'Einzeln' })).entry;
    // Gruppe (mehrere Tage) — einmal löschen, einmal ersetzen
    const gruppe = await plane({ days: [{ date: '2026-10-06', time_from: '07:00', time_to: '15:00' }, { date: '2026-10-07', time_from: '07:00', time_to: '15:00' }], client: 'Gruppe' });
    const gruppe2 = await plane({ days: [{ date: '2026-10-08', time_from: '07:00', time_to: '15:00' }, { date: '2026-10-09', time_from: '07:00', time_to: '15:00' }], client: 'Gruppe 2' });
    // Serie
    const serie = await plane({ date: '2026-10-12', client: 'Serie', recurrence: { freq: 'weekly', end_type: 'count', end_count: 4 } });
    // bleibt stehen
    const bleibt = (await plane({ date: '2026-10-20', client: 'Bleibt' })).entry;
    const gid = (x) => x.group_id || (x.entry && x.entry.group_id) || (x.entries && x.entries[0] && x.entries[0].group_id);
    ok('Planungen angelegt (einzeln, 2 Gruppen, Serie, eine bleibt)', einzel && einzel.id && gid(gruppe) && gid(gruppe2) && serie.series_id && bleibt && bleibt.id,
      JSON.stringify({ einzel, g: gid(gruppe), g2: gid(gruppe2), s: serie.series_id }).slice(0, 300));

    ok('einzeln löschen', (await req('DELETE', `/api/planning/${einzel.id}`, admin)).status === 200);
    ok('Gruppe löschen', (await req('DELETE', `/api/planning/group/${gid(gruppe)}`, admin)).status === 200);
    const ersetzt = await req('PUT', `/api/planning/group/${gid(gruppe2)}`, admin, { days: [{ date: '2026-10-08', time_from: '08:00', time_to: '12:00' }],
      client: 'Gruppe 2 neu', assigned_user_ids: [id.anna] });
    ok('Gruppe ersetzen (alte Einträge weg, neue angelegt)', ersetzt.status === 200, JSON.stringify(ersetzt.body).slice(0, 200));
    ok('Serie ganz löschen', (await req('DELETE', `/api/planning/series/${serie.series_id}`, admin, { scope: 'series' })).status === 200);

    // Projekt mit Kategorie, Zuteilung, Zwischenziel und Zeiteintrag → Papierkorb → endgültig
    const kat = (await req('POST', '/api/projects/kategorien', admin, { name: 'Dach' })).body;
    const katId = kat.id || (kat.kategorie && kat.kategorie.id) || (kat.category && kat.category.id);
    const projekt = (await req('POST', '/api/projects', admin, { name: 'Halle 9', category_ids: [katId], assigned_user_ids: [id.anna],
      milestones: [{ title: 'Rohbau' }] })).body.project;
    const eintrag = await req('POST', '/api/entries', t.anna, { date: '2026-09-21', time_from: '07:00', time_to: '12:00', project_id: projekt.id });
    ok('Projekt mit Kategorie und Zeiteintrag angelegt', katId && projekt && projekt.id && eintrag.status < 300, JSON.stringify({ kat, e: eintrag.status, b: eintrag.body }).slice(0, 200));
    await req('DELETE', `/api/projects/${projekt.id}`, admin);
    ok('Projekt endgültig löschen', (await req('DELETE', `/api/projects/${projekt.id}/purge`, admin)).status === 200);

    // Konto mit Anhängseln → ausstellen → endgültig
    // Soll ab Jahresbeginn rückt den Eintritt nach vorn — erst dann lässt er sich rückwirkend ausstellen
    await req('POST', `/api/statistics/targets/${id.olaf}`, admin, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: '2026-01-01' });
    await req('POST', `/api/statistics/vacation/${id.olaf}`, admin, { valid_from: '2026-01-01', days: 30 });
    const notiz = (await req('POST', '/api/notes', admin, { title: 'Für Olaf', body: 'x' })).body;
    const notizId = notiz.id || (notiz.note && notiz.note.id);
    await req('PUT', `/api/notes/${notizId}/shares`, admin, { shares: [{ user_id: id.olaf, permission: 'read' }] });
    await req('POST', '/api/planning', admin, { date: '2026-10-21', time_from: '07:00', time_to: '15:00', client: 'Mit Olaf', assigned_user_ids: [id.olaf, id.tom] });
    const olafEintrag = await req('POST', '/api/entries', t.olaf, { date: '2026-09-22', time_from: '07:00', time_to: '12:00' });
    const aus = await req('POST', `/api/users/${id.olaf}/deactivate`, admin, { employed_until: '2026-09-22' });
    const hart = await req('DELETE', `/api/users/${id.olaf}`, admin);
    ok('Konto endgültig löschen', hart.status === 200 && olafEintrag.status < 300,
      JSON.stringify({ eintrag: [olafEintrag.status, olafEintrag.body], aus: [aus.status, aus.body], hart: [hart.status, hart.body] }).slice(0, 400));

    // Server regulär beenden (speichert) — OHNE Neustart: sonst räumte der Start auf und verdeckte Lücken
    srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r)); beendet = true;
    const d = new SQL.Database(fs.readFileSync(DB));
    const ohne = (a) => eins(d, `SELECT COUNT(*) FROM ${a.tabelle} WHERE ${a.spalte} IS NOT NULL AND ${a.spalte} NOT IN (SELECT id FROM ${a.auf})`);
    const reste_ = reste.ANHAENGSEL.map(a => ({ k: `${a.tabelle}.${a.spalte}`, n: ohne(a) })).filter(x => x.n);
    ok('nirgends ein Anhängsel ohne Gegenstück', reste_.length === 0, JSON.stringify(reste_));
    ok('die übrigen Planungen samt Zuweisungen stehen (bleibt: Anna+Tom; ersetzte Gruppe: Anna; Olafs Planung: Tom)',
      JSON.stringify(werte(d, `SELECT pe.client, group_concat(pa.user_id) FROM planning_entries pe JOIN planning_assignments pa ON pa.planning_id = pe.id
        GROUP BY pe.id ORDER BY pe.date`)) === JSON.stringify([['Gruppe 2 neu', String(id.anna)], ['Bleibt', `${id.anna},${id.tom}`], ['Mit Olaf', String(id.tom)]]),
      JSON.stringify(werte(d, 'SELECT pe.client, group_concat(pa.user_id) FROM planning_entries pe JOIN planning_assignments pa ON pa.planning_id = pe.id GROUP BY pe.id ORDER BY pe.date')));
    ok('Anhängsel dieses Projekts weg (Kategorie-Zuordnung, Zuteilung, Zwischenziel), Kategorie selbst bleibt',
      eins(d, 'SELECT COUNT(*) FROM project_category_links WHERE project_id = ?', [projekt.id]) === 0
        && eins(d, 'SELECT COUNT(*) FROM project_assignments WHERE project_id = ?', [projekt.id]) === 0
        && eins(d, 'SELECT COUNT(*) FROM project_categories WHERE id = ?', [katId]) === 1);
    ok('der Zeiteintrag zum gelöschten Projekt bleibt — mit Projektname als Text',
      JSON.stringify(werte(d, "SELECT project_text FROM entries WHERE date = '2026-09-21'")) === '[["Halle 9"]]');
    ok('Olafs Anhängsel weg (Freigabe, Urlaubsanspruch, Soll-Stunden, Anstellung, Planungs-Zuweisung)',
      ['note_shares', 'vacation_entitlements', 'user_target_hours', 'employment_periods', 'planning_assignments']
        .every(tb => eins(d, `SELECT COUNT(*) FROM ${tb} WHERE user_id = ?`, [id.olaf]) === 0));
    ok('Olafs INHALT bleibt: sein Zeiteintrag steht (wie bisher in der Praxis)', eins(d, 'SELECT COUNT(*) FROM entries WHERE user_id = ?', [id.olaf]) === 1);
    ok('kein Protokolleintrag „Datenreste aufgeräumt" — die Wege räumen selbst auf, nicht der Start',
      eins(d, "SELECT COUNT(*) FROM audit_logs WHERE action = 'reste_aufgeraeumt'") === 0);
    d.close();
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (!beendet) { srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); }); }
  }

  console.log(`\nReste beim Löschen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
