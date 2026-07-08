// API-Test: Serientermine anlegen (Materialisierung, Vorkommen, Overlap-Flag, never-Horizont, Rechte).
// Start: node tests/planning-series.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3172;
const DB = '/tmp/planning-series-test.db';

function req(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{
      'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}),
    }}, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ '+n)) : (fail++, console.log('  ✗ '+n+(e?'  → '+e:'')));
const tok = async (u, pw='test') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const entriesOf = async (t, seriesId) => ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === seriesId);
const uniq = arr => [...new Set(arr)];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/planning-series-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mkUser = (o) => req('POST','/api/users', admin, { password:'test', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o }).then(r=>r.body.user);
    const anna = await mkUser({ username:'anna', name:'Anna' });

    // 1) wöchentlich, count=4, Einzeltag (08.07.2026 = Mi)
    let r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', break_minutes:30, assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } });
    ok('weekly count=4 → 201/series', r.status === 201 && r.body.series === true && r.body.count === 4, JSON.stringify(r.body));
    const s1 = r.body.series_id;
    let ents = await entriesOf(admin, s1);
    ok('4 Einträge mit gleicher series_id', ents.length === 4);
    ok('occurrence_date = die 4 Mittwoche', JSON.stringify(uniq(ents.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-08','2026-07-15','2026-07-22','2026-07-29']));
    ok('je Vorkommen eigene group_id (4 verschiedene)', uniq(ents.map(e=>e.group_id)).length === 4);
    ok('Anna überall zugewiesen', ents.every(e => (e.assigned_users||[]).some(a=>a.user_id===anna.id)));

    // 2) monatlich am Datum, count=3
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'08:00', time_to:'16:00', assigned_user_ids:[anna.id], recurrence:{ freq:'monthly_date', end_type:'count', end_count:3 } });
    ok('monthly_date count=3 → count 3', r.body.count === 3);
    ok('monthly_date occurrence_dates', JSON.stringify((await entriesOf(admin, r.body.series_id)).map(e=>e.occurrence_date).sort()) === JSON.stringify(['2026-07-08','2026-08-08','2026-09-08']));

    // 3) mehrtägig (2 Tage) × wöchentlich count=2 → 2 Vorkommen à 2 Tage = 4 Zeilen, 1 series, 2 groups
    r = await req('POST','/api/planning', admin, { days:[{date:'2026-07-08',time_from:'07:00',time_to:'15:30',break_minutes:30},{date:'2026-07-09',time_from:'07:00',time_to:'15:30',break_minutes:30}], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('mehrtägig×weekly: count=2, days_per_occurrence=2', r.body.count === 2 && r.body.days_per_occurrence === 2);
    ents = await entriesOf(admin, r.body.series_id);
    ok('mehrtägig: 4 Zeilen, 2 group_ids', ents.length === 4 && uniq(ents.map(e=>e.group_id)).length === 2);
    ok('mehrtägig: Tage 08./09. + 15./16.', JSON.stringify(uniq(ents.map(e=>e.date)).sort()) === JSON.stringify(['2026-07-08','2026-07-09','2026-07-15','2026-07-16']));

    // 4) Overlap-Flag: Spanne 8 Tage (Offsets 0 und 8), wöchentlich (Abstand 7) → overlap true
    r = await req('POST','/api/planning', admin, { days:[{date:'2026-07-08',time_from:'07:00',time_to:'15:30'},{date:'2026-07-16',time_from:'07:00',time_to:'15:30'}], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('overlap=true bei Spanne ≥ Intervall', r.body.overlap === true, 'overlap=' + r.body.overlap);
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('overlap=false bei Einzeltag', r.body.overlap === false);

    // 5) never → viele Vorkommen (~24 Monate) + planning_series-Regel
    const todayISO = new Date().toISOString().slice(0,10);
    r = await req('POST','/api/planning', admin, { date:todayISO, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'never' } });
    ok('never: > 90 Vorkommen materialisiert (24 Monate)', r.body.count > 90, 'count=' + r.body.count);

    // 6) ungültige Wiederholung → 400
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'nope', end_type:'count', end_count:3 } });
    ok('ungültige freq → 400', r.status === 400);

    // 7) Self-Planer darf nur sich selbst als Serie planen
    const self = await mkUser({ username:'selfp', name:'Self', can_plan:1, can_plan_all:0 });
    const selfTok = await tok('selfp');
    r = await req('POST','/api/planning', selfTok, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('Self-Planer: Serie für andere → 403', r.status === 403, 'status ' + r.status);
    r = await req('POST','/api/planning', selfTok, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[self.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('Self-Planer: Serie für sich selbst → 201', r.status === 201, 'status ' + r.status);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
