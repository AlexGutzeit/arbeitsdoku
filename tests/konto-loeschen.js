// Mitarbeiter endgültig löschen — Server (Alex, 28.09.2026; Regel in konto-loeschen.js).
//
// Geprüft über die Schnittstelle, dann in der Datenbank (Server ohne Neustart beendet):
//   * Vorschau nennt, was geht und was bleibt — und genau das passiert.
//   * geht: Zeiteinträge (auch im Papierkorb) samt Verlauf, Abwesenheit samt Verlauf, eigene (geteilte) Notiz,
//     Planung und Serie nur mit ihr, Erinnerung, Werkzeug-Ausleihe, Soll/Anstellung/Freigaben (Anhängsel).
//   * bleibt: Planung mit Anna (Tina ausgetragen), Planung + Serie, die Tina für Tom angelegt hat (Serie läuft
//     für Tom weiter, Tina nicht mehr in der Vorlage), Aushang und Bestellung — sichtbar als „Gelöschtes Konto".
//     Annas und Toms Daten unverändert.
//   * gesperrt: Paul steht in einer abgeschlossenen Abrechnung → 409, alles bleibt. Chef darf gar nicht (403).
//   * Altlasten früh gelöschter Konten: beim Start EINMAL weg (Merker), nicht bei Konten in einer Abrechnung;
//     ist der Merker gesetzt, bleibt ihr Inhalt. Beim Zurückspielen einer alten Sicherung ebenso.
//
//   node tests/konto-loeschen.js
process.env.JWT_SECRET = 'test-secret-mindestens-32-zeichen-lang';
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const initSqlJs = require('sql.js');
const reste = require('../reste');

const PORT = 3349, DB = '/tmp/konto-loeschen.db', LOG = '/tmp/konto-loeschen.log', LEER = '/tmp/konto-loeschen-leer.db';
const WURZEL = path.join(__dirname, '..');
const JAHR = new Date().getFullYear() - 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const heute = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const tag = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const werte = (db, sql, p) => { const s = db.prepare(sql); if (p) s.bind(p); const z = []; while (s.step()) z.push(s.get()); s.free(); return z; };
const eins = (db, sql, p) => (werte(db, sql, p)[0] || [])[0];
function starteInit(dbPfad) {
  const skript = `process.env.DB_PATH=${JSON.stringify(dbPfad)};process.env.JWT_SECRET='x'.repeat(40);
    const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))});
    m.initDatabase().then(() => { m.saveToFile(); process.exit(0); });`;
  return spawnSync('node', ['-e', skript], { encoding: 'utf8', timeout: 120000 });
}

(async () => {
  const SQL = await initSqlJs();
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: WURZEL, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: ['ignore', lg, lg] });
  let beendet = false;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const tok = async (u, pw) => (await req('POST', '/api/auth/login', null, { username: u, password: pw })).body.token;
    const admin = await tok('admin', (log.match(/admin\s+->\s+(\S+)/) || [])[1]);
    const id = {}, t = {};
    for (const [u, n, rolle] of [['carla', 'Carla Chef', 'chef'], ['tina', 'Tina Test', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter'],
      ['tom', 'Tom Kraus', 'mitarbeiter'], ['paul', 'Paul Abgerechnet', 'mitarbeiter']]) {
      id[u] = (await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: rolle, hours_mon: 8 })).body.user.id;
      t[u] = await tok(u, 'Test1234!');
    }
    const soll = (u, ab) => req('POST', `/api/statistics/targets/${id[u]}`, t.carla, { hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8, valid_from: ab });

    console.log('Tina legt an (Testkonto)');
    await soll('tina', tag(-30));
    const e1 = (await req('POST', '/api/entries', t.tina, { date: tag(-20), time_from: '07:00', time_to: '12:00', break_minutes: 0 })).body.entry;
    const e2 = (await req('POST', '/api/entries', t.tina, { date: tag(-19), time_from: '07:00', time_to: '12:00', break_minutes: 0 })).body.entry;
    await req('PUT', `/api/entries/${e1.id}`, t.tina, { date: tag(-20), time_from: '07:00', time_to: '13:00', break_minutes: 0 });   // Verlauf
    await req('DELETE', `/api/entries/${e2.id}`, t.tina, { reason: 'Test' });                                                          // Papierkorb
    const abw = await req('POST', '/api/absences', t.tina, { type: 'urlaub', date_from: tag(-10), date_to: tag(-9) });
    const tNotiz = (await req('POST', '/api/notes', t.tina, { title: 'Tinas Notiz', body: 'x' })).body;
    const tNotizId = tNotiz.id || (tNotiz.note && tNotiz.note.id);
    await req('PUT', `/api/notes/${tNotizId}/shares`, t.tina, { shares: [{ user_id: id.anna, permission: 'read' }] });
    const aNotiz = (await req('POST', '/api/notes', t.anna, { title: 'Annas Notiz', body: 'y' })).body;
    const aNotizId = aNotiz.id || (aNotiz.note && aNotiz.note.id);
    await req('PUT', `/api/notes/${aNotizId}/shares`, t.anna, { shares: [{ user_id: id.tina, permission: 'read' }] });
    const plane = async (wer, b) => (await req('POST', '/api/planning', t[wer], { time_from: '07:00', time_to: '15:00', ...b })).body;
    const solo = (await plane('tina', { date: tag(7), client: 'Nur Tina', assigned_user_ids: [id.tina] })).entry;
    await plane('tina', { date: tag(8), client: 'Tina und Anna', assigned_user_ids: [id.tina, id.anna] });
    await plane('tina', { date: tag(9), client: 'Für Tom', assigned_user_ids: [id.tom] });
    const soloSerie = await plane('tina', { date: tag(14), client: 'Serie Tina', assigned_user_ids: [id.tina], recurrence: { freq: 'weekly', end_type: 'count', end_count: 3 } });
    const gemSerie = await plane('tina', { date: tag(15), client: 'Serie Tina+Tom', assigned_user_ids: [id.tina, id.tom], recurrence: { freq: 'weekly', end_type: 'count', end_count: 3 } });
    const erinnerung = await req('POST', '/api/planning/reminders', t.tina, { entry_id: solo.id, lead_num: 1, lead_unit: 'day' });
    const werkzeug = (await req('POST', '/api/tools', t.carla, { name: 'Bohrhammer' })).body;
    const werkzeugId = werkzeug.id || (werkzeug.tool && werkzeug.tool.id);
    const ausleihe = await req('POST', `/api/tools/${werkzeugId}/checkout`, t.tina, {});
    const aushang = await req('POST', '/api/bulletin', t.tina, { title: 'Grillfest', text: 'Freitag' });
    const bestellung = await req('POST', '/api/orders', t.tina, { product: 'Kabelbinder', quantity: 2 });
    await req('POST', '/api/entries', t.anna, { date: tag(-5), time_from: '07:00', time_to: '15:00', break_minutes: 30 });
    ok('alles angelegt', e1 && e2 && abw.status < 300 && tNotizId && aNotizId && solo && soloSerie.series_id && gemSerie.series_id
      && erinnerung.status < 300 && ausleihe.status < 300 && aushang.status < 300 && bestellung.status < 300,
      JSON.stringify({ abw: abw.status, er: erinnerung.status, aus: ausleihe.status, ah: aushang.status, be: bestellung.status, bb: bestellung.body }).slice(0, 300));

    console.log('Paul: abgerechnet');
    await soll('paul', `${JAHR}-01-01`);
    // Der Abschluss beginnt beim ersten Monat mit Einträgen — Paul braucht einen im Januar
    await req('POST', '/api/entries', admin, { date: `${JAHR}-01-15`, time_from: '07:00', time_to: '15:00', break_minutes: 30, user_id: id.paul });
    const abschluss = await req('POST', '/api/closure/bis', t.carla, { month: `${JAHR}-01` });
    ok('Abschluss Januar angelegt', abschluss.status === 201 && abschluss.body.erledigt.length === 1, JSON.stringify(abschluss.body).slice(0, 200));

    for (const u of ['tina', 'paul']) {
      const r = await req('POST', `/api/users/${id[u]}/deactivate`, admin, { employed_until: tag(-1) });
      ok(`${u} ausgestellt`, r.status === 200, JSON.stringify(r.body).slice(0, 160));
    }
    ok('Chef darf nicht endgültig löschen (403)', (await req('DELETE', `/api/users/${id.tina}`, t.carla)).status === 403);
    ok('Chef bekommt auch keine Vorschau (403)', (await req('GET', `/api/users/${id.tina}/loeschen-vorschau`, t.carla)).status === 403);

    console.log('Sperre');
    const vPaul = (await req('GET', `/api/users/${id.paul}/loeschen-vorschau`, admin)).body;
    ok('Vorschau Paul: gesperrt mit Grund „abgeschlossene Abrechnung"', /abgeschlossenen Abrechnung/.test(vPaul.gesperrt || ''), JSON.stringify(vPaul));
    const dPaul = await req('DELETE', `/api/users/${id.paul}`, admin);
    ok('Löschen Paul: 409 mit demselben Grund', dPaul.status === 409 && dPaul.body.error === vPaul.gesperrt, JSON.stringify(dPaul));

    console.log('Vorschau Tina');
    const v = (await req('GET', `/api/users/${id.tina}/loeschen-vorschau`, admin)).body;
    ok('nicht gesperrt, Name dabei', v.gesperrt === null && v.name === 'Tina Test', JSON.stringify(v));
    const erwGeht = { eintraege: 2, abwesenheiten: 1, notizen: 1, planungen: 4, werkzeug: 1 };
    const erwBleibt = { planungenMitAnderen: 4, planungenFuerAndere: 1, bestellungen: 1, aushaenge: 1 };
    ok('geht: 2 Zeiteinträge (einer im Papierkorb), 1 Abwesenheit, 1 Notiz, 4 Planungen (1 + Serie 3), 1 Ausleihe',
      JSON.stringify(v.geht) === JSON.stringify(erwGeht), JSON.stringify(v.geht));
    ok('bleibt: 4 Planungen mit anderen (1 + Serie 3), 1 für Tom, 1 Bestellung, 1 Aushang',
      JSON.stringify(v.bleibt) === JSON.stringify(erwBleibt), JSON.stringify(v.bleibt));

    console.log('Löschen');
    const d = await req('DELETE', `/api/users/${id.tina}`, admin);
    const sortiert = (o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
    ok('200, gemeldet wird genau das Vorhergesagte', d.status === 200 && sortiert(d.body.geloescht) === sortiert(erwGeht), JSON.stringify(d.body));
    const plan = (await req('GET', `/api/planning?date_from=${tag(0)}&date_to=${tag(60)}`, admin)).body;
    const liste = Array.isArray(plan) ? plan : (plan.entries || plan.planning || []);
    const wer = (c) => liste.filter(p => p.client === c).map(p => (p.assigned || p.assigned_users || p.users || []).map(a => a.id || a.user_id || a).sort().join(','));
    ok('„Nur Tina" und die Serie nur mit ihr sind weg', wer('Nur Tina').length === 0 && wer('Serie Tina').length === 0, JSON.stringify(liste.map(p => p.client)));
    ok('„Tina und Anna" bleibt — nur mit Anna', JSON.stringify(wer('Tina und Anna')) === JSON.stringify([String(id.anna)]), JSON.stringify(wer('Tina und Anna')));
    const fuerTom = liste.filter(p => p.client === 'Für Tom');
    ok('„Für Tom" bleibt sichtbar, Ersteller „Gelöschtes Konto"', fuerTom.length === 1 && fuerTom[0].created_by_name === 'Gelöschtes Konto', JSON.stringify(fuerTom).slice(0, 200));
    ok('die gemeinsame Serie bleibt — drei Termine, nur mit Tom', JSON.stringify(wer('Serie Tina+Tom')) === JSON.stringify([String(id.tom), String(id.tom), String(id.tom)]), JSON.stringify(wer('Serie Tina+Tom')));
    const brett = (await req('GET', '/api/bulletin', t.anna)).body;
    const ah = (Array.isArray(brett) ? brett : (brett.entries || [])).find(b => b.title === 'Grillfest');
    ok('Aushang bleibt sichtbar, Verfasser „Gelöschtes Konto"', ah && ah.author_name === 'Gelöschtes Konto', JSON.stringify(brett).slice(0, 200));
    const best = (await req('GET', '/api/orders', t.carla)).body;
    const bs = JSON.stringify(best);
    ok('Bestellung bleibt sichtbar, für „Gelöschtes Konto"', /Kabelbinder/.test(bs) && /Gelöschtes Konto/.test(bs), bs.slice(0, 200));
    const annasNotizen = JSON.stringify((await req('GET', '/api/notes', t.anna)).body);
    ok('Tinas geteilte Notiz ist aus Annas Liste verschwunden, Annas eigene steht',
      !annasNotizen.includes('Tinas Notiz') && annasNotizen.includes('Annas Notiz'), annasNotizen.slice(0, 200));
    ok('Tinas Notiz: kein Zugriff mehr (Freigaben, Export)', [403, 404].includes((await req('GET', `/api/notes/${tNotizId}/shares`, t.anna)).status)
      && [403, 404].includes((await req('GET', `/api/notes/${tNotizId}/export/pdf`, t.anna)).status));
    const prot = JSON.stringify((await req('GET', '/api/audit?limit=20', admin)).body);
    ok('Protokoll: „Endgültig gelöscht: tina … — 2 Zeiteinträge, 1 Abwesenheit, 1 Notiz, 4 Planungen, 1 Werkzeug-Ausleihe"',
      prot.includes('Endgültig gelöscht: tina (chef, id=' + id.tina + ') — 2 Zeiteinträge, 1 Abwesenheit, 1 Notiz, 4 Planungen, 1 Werkzeug-Ausleihe'), prot.slice(0, 300));

    srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r)); beendet = true;
    const db = new SQL.Database(fs.readFileSync(DB));
    const bei = (tb, sp = 'user_id') => eins(db, `SELECT COUNT(*) FROM ${tb} WHERE ${sp} = ?`, [id.tina]);
    ok('in der Datenbank nichts mehr von Tina: Einträge, Abwesenheiten, Notizen, Ausleihen, Einteilungen, Erinnerungen, Soll, Anstellung, Freigaben',
      ['entries', 'absences', 'notes', 'tool_checkouts', 'planning_assignments', 'planning_reminders', 'user_target_hours', 'employment_periods', 'note_shares']
        .every(tb => bei(tb) === 0), JSON.stringify(['entries', 'absences', 'notes', 'tool_checkouts', 'planning_assignments'].map(tb => bei(tb))));
    ok('auch kein Verlauf ihrer Einträge und Abwesenheiten',
      eins(db, 'SELECT COUNT(*) FROM entry_history WHERE entry_id IN (?, ?)', [e1.id, e2.id]) === 0
        && eins(db, "SELECT COUNT(*) FROM absence_history WHERE absence_id NOT IN (SELECT id FROM absences)") === 0);
    ok('Serien: die nur mit ihr ist weg, die gemeinsame läuft mit Tom als einzigem in der Vorlage',
      eins(db, 'SELECT COUNT(*) FROM planning_series WHERE series_id = ?', [soloSerie.series_id]) === 0
        && JSON.stringify(JSON.parse(eins(db, 'SELECT template FROM planning_series WHERE series_id = ?', [gemSerie.series_id])).assigned_user_ids) === JSON.stringify([id.tom])
        && eins(db, 'SELECT active FROM planning_series WHERE series_id = ?', [gemSerie.series_id]) === 1);
    const ohne = reste.ANHAENGSEL.map(a => ({ k: `${a.tabelle}.${a.spalte}`, n: eins(db, `SELECT COUNT(*) FROM ${a.tabelle} WHERE ${a.spalte} IS NOT NULL AND ${a.spalte} NOT IN (SELECT id FROM ${a.auf})`) })).filter(x => x.n);
    ok('nirgends ein Anhängsel ohne Gegenstück', ohne.length === 0, JSON.stringify(ohne));
    ok('Anna, Tom, Paul unberührt (Einträge, Einteilungen, Paul im Abschluss)',
      eins(db, 'SELECT COUNT(*) FROM entries WHERE user_id = ?', [id.anna]) === 1 && eins(db, 'SELECT COUNT(*) FROM planning_assignments WHERE user_id = ?', [id.tom]) === 4
        && eins(db, 'SELECT COUNT(*) FROM users WHERE id = ?', [id.paul]) === 1 && eins(db, 'SELECT COUNT(*) FROM payroll_closure_rows WHERE user_id = ?', [id.paul]) >= 1);
    ok('Werkzeug wieder frei (keine offene Ausleihe)', eins(db, 'SELECT COUNT(*) FROM tool_checkouts WHERE tool_id = ? AND returned_at IS NULL', [werkzeugId]) === 0);
    db.close();
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, e && e.stack);
  } finally {
    if (!beendet) { srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); }); }
  }

  // ── Altlasten früh gelöschter Konten ───────────────────────────────────────────────────────────
  console.log('Altlasten beim Start');
  try { fs.unlinkSync(LEER); } catch (_) {}
  starteInit(LEER);
  const baue = (mitMerker) => {
    const d = new SQL.Database(fs.readFileSync(LEER));
    const admin = eins(d, "SELECT id FROM users WHERE username='admin'");
    if (!mitMerker) d.run("DELETE FROM settings WHERE key = 'altlasten_geloeschte_konten'");
    d.run("INSERT INTO entries (id, user_id, date, time_from, time_to, net_hours) VALUES (900, 777, '2026-03-20', '07:00', '12:00', 5)");
    d.run("INSERT INTO entry_history (entry_id, action, changed_by, snapshot) VALUES (900, 'create', 777, '{}')");
    d.run("INSERT INTO absences (user_id, type, date_from, date_to) VALUES (777, 'urlaub', '2026-03-23', '2026-03-23')");
    d.run("INSERT INTO notes (id, user_id, title, body) VALUES (900, 777, 'Alt', '')");
    d.run('INSERT INTO note_shares (note_id, user_id, permission) VALUES (900, ?, ?)', [admin, 'read']);
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to, client) VALUES (901, 777, '2026-03-20', '07:00', '12:00', 'von 777 für Admin')");
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (901, ?)', [admin]);
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to, client) VALUES (902, ?, '2026-03-26', '07:00', '12:00', 'nur 777')", [admin]);
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (902, 777)');
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to, client) VALUES (903, ?, '2026-03-21', '07:00', '12:00', '777 und Admin')", [admin]);
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (903, 777)');
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (903, ?)', [admin]);
    d.run("INSERT INTO planning_entries (id, created_by, date, time_from, time_to, client) VALUES (904, ?, '2026-03-22', '07:00', '12:00', 'nur Admin')", [admin]);
    d.run('INSERT INTO planning_assignments (planning_id, user_id) VALUES (904, ?)', [admin]);
    // Konto 888: steht in einer Abrechnung → bleibt unberührt
    d.run("INSERT INTO payroll_closures (id, period_from, period_to, closed_at) VALUES (50, '2026-01-01', '2026-01-31', '2026-02-01')");
    d.run("INSERT INTO payroll_closure_rows (closure_id, user_id, name) VALUES (50, 888, 'Alt Abgerechnet')");
    d.run("INSERT INTO entries (id, user_id, date, time_from, time_to, net_hours) VALUES (910, 888, '2026-01-20', '07:00', '12:00', 5)");
    const p = '/tmp/konto-loeschen-alt.db'; fs.writeFileSync(p, Buffer.from(d.export())); d.close();
    return { p, admin };
  };
  {
    const { p, admin } = baue(false);
    const lauf = starteInit(p);
    const d = new SQL.Database(fs.readFileSync(p));
    ok('Start meldet die Altlasten', /\[reste\] Inhalt früh gelöschter Konten \(Nr\. 777\): 1 Zeiteintrag, 1 Abwesenheit, 1 Notiz, 2 Planungen/.test(lauf.stdout || ''),
      (lauf.stdout || '').match(/\[reste\].*/g));
    ok('Inhalt von 777 weg: Eintrag samt Verlauf, Abwesenheit, Notiz samt Freigabe',
      eins(d, 'SELECT COUNT(*) FROM entries WHERE user_id = 777') === 0 && eins(d, 'SELECT COUNT(*) FROM entry_history WHERE entry_id = 900') === 0
        && eins(d, 'SELECT COUNT(*) FROM absences WHERE user_id = 777') === 0 && eins(d, 'SELECT COUNT(*) FROM notes WHERE id = 900') === 0
        && eins(d, 'SELECT COUNT(*) FROM note_shares WHERE note_id = 900') === 0);
    ok('Planungen: von 777 angelegt (bisher unsichtbar) und nur mit 777 → weg; mit Admin bzw. nur Admin → bleiben',
      JSON.stringify(werte(d, 'SELECT id FROM planning_entries WHERE id >= 900 ORDER BY id')) === '[[903],[904]]'
        && JSON.stringify(werte(d, 'SELECT user_id FROM planning_assignments WHERE planning_id = 903')) === JSON.stringify([[admin]]),
      JSON.stringify(werte(d, 'SELECT id FROM planning_entries WHERE id >= 900')));
    ok('Konto 888 steht in einer Abrechnung → sein Eintrag bleibt', eins(d, 'SELECT COUNT(*) FROM entries WHERE id = 910') === 1);
    ok('Merker gesetzt, Protokoll „System"', !!eins(d, "SELECT value FROM settings WHERE key = 'altlasten_geloeschte_konten'")
      && eins(d, "SELECT COUNT(*) FROM audit_logs WHERE action = 'reste_aufgeraeumt' AND details LIKE 'Inhalt früh gelöschter Konten%'") === 1);
    d.close();
    const zweit = starteInit(p);
    ok('zweiter Start: nichts mehr', !/\[reste\]/.test(zweit.stdout || ''), (zweit.stdout || '').match(/\[reste\].*/g));
  }
  {
    const { p } = baue(true);
    starteInit(p);
    const d = new SQL.Database(fs.readFileSync(p));
    ok('Merker schon gesetzt → Inhalt bleibt (nur die Anhängsel gehen)',
      eins(d, 'SELECT COUNT(*) FROM entries WHERE user_id = 777') === 1 && eins(d, 'SELECT COUNT(*) FROM planning_entries WHERE id IN (901, 902)') === 2
        && eins(d, 'SELECT COUNT(*) FROM planning_assignments WHERE user_id = 777') === 0);
    d.close();
  }
  {
    // Zurückspielen einer alten Sicherung (ohne Merker): wird beim Vorbereiten ebenso aufgeräumt
    const { p } = baue(false);
    const skript = `process.env.DB_PATH=${JSON.stringify(LEER)};process.env.JWT_SECRET='x'.repeat(40);
      const m = require(${JSON.stringify(path.join(WURZEL, 'database', 'init'))});
      m.initDatabase().then(() => { const neu = m.datenbankVorbereiten(require('fs').readFileSync(${JSON.stringify(p)}));
        console.log('ERG=' + JSON.stringify({ e: neu.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = 777').get().n,
          pl: neu.prepare('SELECT COUNT(*) AS n FROM planning_entries WHERE id IN (901, 902)').get().n })); process.exit(0); });`;
    const r = spawnSync('node', ['-e', skript], { encoding: 'utf8', timeout: 120000 });
    const erg = JSON.parse(((r.stdout || '').match(/ERG=(.*)/) || [])[1] || 'null');
    ok('Zurückspielen einer alten Sicherung: Altlasten weg', erg && erg.e === 0 && erg.pl === 0, JSON.stringify(erg) + (r.stderr || '').slice(0, 200));
  }
  for (const f of ['/tmp/konto-loeschen-alt.db', LEER]) { try { fs.unlinkSync(f); } catch (_) {} }

  console.log(`\nKonto endgültig löschen: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
