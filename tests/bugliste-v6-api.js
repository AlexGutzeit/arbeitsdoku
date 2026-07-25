// API-Test Bugliste v6:
//  A2  POST /api/planning/to-series darf FREMDE Planungen nicht löschen (Self-Planer).
//  A7  PUT /api/planning/series/:id darf als Self-Planer niemanden ausser sich selbst zuweisen.
//  A4  Auftrags-Statistik + CSV zählen SOFT-GELÖSCHTE Zeiteinträge nicht mit.
//   node tests/bugliste-v6-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3223, DB = '/tmp/bugliste-v6.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) { j = s; } res({ status: x.statusCode, body: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const login = (u, pw) => req('POST', '/api/auth/login', null, { username: u, password: pw });
const DAY = '2027-05-10';

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/bugliste-v6-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 40; i++) { try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {} await sleep(150); }
    const apw = (fs.readFileSync('/tmp/bugliste-v6-srv.log', 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await login('admin', apw)).body.token;

    // Zwei MA: „opfer" (fremde Planung) und „self" (Self-Planer: can_plan, KEIN can_plan_all)
    const opfer = (await req('POST', '/api/users', admin, { username: 'v6opfer', password: 'Test1234!', name: 'V6 Opfer', role: 'mitarbeiter' })).body.user;
    const self = (await req('POST', '/api/users', admin, { username: 'v6self', password: 'Test1234!', name: 'V6 Self', role: 'mitarbeiter', can_plan: true })).body.user;
    const selfTok = (await login('v6self', 'Test1234!')).body.token;
    ok('Setup: Opfer + Self-Planer', !!(opfer && self && selfTok));

    // ── A2: fremde Planung (gehört „opfer") darf NICHT über to-series gelöscht werden ──
    console.log('A2 — to-series darf fremde Planungen nicht löschen:');
    const fremd = (await req('POST', '/api/planning', admin, { date: DAY, time_from: '08:00', time_to: '16:00', assigned_user_ids: [opfer.id] })).body.entry;
    ok('fremde Planung angelegt', !!fremd);
    let r = await req('POST', '/api/planning/to-series', selfTok, {
      entry_id: fremd.id, date: DAY, time_from: '08:00', time_to: '16:00',
      assigned_user_ids: [self.id], recurrence: { freq: 'weekly', end_type: 'count', end_count: 2 } });
    ok('Self-Planer → fremde entry_id: 403', r.status === 403, 'status=' + r.status + ' ' + JSON.stringify(r.body));
    const stillThere = ((await req('GET', `/api/planning?date_from=${DAY}&date_to=${DAY}`, admin)).body.entries || []).some(e => e.id === fremd.id);
    ok('fremde Planung existiert noch (nicht gelöscht!)', stillThere);

    // Gruppen-Variante
    const grp = await req('POST', '/api/planning', admin, { days: [{ date: DAY, time_from: '08:00', time_to: '12:00' }, { date: '2027-05-11', time_from: '08:00', time_to: '12:00' }], assigned_user_ids: [opfer.id] });
    const gid = grp.body.group_id;
    r = await req('POST', '/api/planning/to-series', selfTok, {
      group_id: gid, date: DAY, time_from: '08:00', time_to: '12:00',
      assigned_user_ids: [self.id], recurrence: { freq: 'weekly', end_type: 'count', end_count: 2 } });
    ok('Self-Planer → fremde group_id: 403', r.status === 403, 'status=' + r.status);
    const grpLeft = (await req('GET', `/api/planning/group/${gid}`, admin)).body;
    ok('fremde Gruppe existiert noch', !!(grpLeft && (grpLeft.entries || []).length === 2), JSON.stringify(grpLeft && (grpLeft.entries || []).length));

    // Eigene Planung darf er sehr wohl umwandeln
    const eigen = (await req('POST', '/api/planning', selfTok, { date: '2027-05-12', time_from: '09:00', time_to: '10:00', assigned_user_ids: [self.id] })).body.entry;
    r = await req('POST', '/api/planning/to-series', selfTok, {
      entry_id: eigen.id, date: '2027-05-12', time_from: '09:00', time_to: '10:00',
      assigned_user_ids: [self.id], recurrence: { freq: 'weekly', end_type: 'count', end_count: 2 } });
    ok('eigene Planung → Serie: 201 (Funktion bleibt nutzbar)', r.status === 201, 'status=' + r.status + ' ' + JSON.stringify(r.body));
    const seriesId = r.body && r.body.series_id;

    // ── A7: Serien-Route darf Fremde nicht zuweisen ──
    console.log('A7 — Serien-Route: kein Fremd-Zuweisen als Self-Planer:');
    r = await req('PUT', `/api/planning/series/${seriesId}`, selfTok, { scope: 'series', assigned_user_ids: [opfer.id, self.id] });
    ok('Self-Planer weist Fremden zu: 403', r.status === 403, 'status=' + r.status);
    r = await req('PUT', `/api/planning/series/${seriesId}`, selfTok, { scope: 'series', assigned_user_ids: [self.id], client: 'nur ich' });
    ok('sich selbst zuweisen: erlaubt', r.status === 200, 'status=' + r.status);

    // ── A4: Projekt-Auswertung ohne soft-gelöschte Einträge ──
    console.log('A4 — Auftrags-Auswertung ignoriert gelöschte Einträge:');
    const proj = (await req('POST', '/api/projects', admin, { name: 'V6-Projekt' })).body.project;
    const e1 = (await req('POST', '/api/entries', admin, { user_id: opfer.id, date: DAY, time_from: '08:00', time_to: '12:00', project_id: proj.id })).body.entry;
    const e2 = (await req('POST', '/api/entries', admin, { user_id: opfer.id, date: DAY, time_from: '13:00', time_to: '17:00', project_id: proj.id })).body.entry;
    let st = (await req('GET', `/api/projects/${proj.id}/stats`, admin)).body;
    ok('vor dem Löschen: 8 Stunden', st.total_hours === 8, 'hours=' + st.total_hours);
    const del = await req('DELETE', `/api/entries/${e2.id}`, admin, { reason: 'Test' });
    ok('Eintrag gelöscht (soft)', del.status === 200 || del.status === 204, 'status=' + del.status);
    st = (await req('GET', `/api/projects/${proj.id}/stats`, admin)).body;
    ok('Statistik zählt nur noch 4 Stunden', st.total_hours === 4, 'hours=' + st.total_hours);
    const csv = await req('GET', `/api/projects/${proj.id}/entries.csv`, admin);
    const lines = String(csv.body).split('\n').filter(l => l.includes('13:00'));
    ok('CSV enthält den gelöschten Eintrag NICHT', lines.length === 0, JSON.stringify(lines));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nBugliste-v6-API: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
