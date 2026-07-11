// API-Test: Planungs-Erinnerungen (CRUD, mehrere pro Termin, Rechte, occurrence vs series vs Einzeltag).
// Start: node tests/planning-reminders-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3198, DB = '/tmp/planning-reminders-api.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const nextMon = () => { const d = new Date(); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
const addCal = (isoStr, n) => { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const groupOf = async (t, id) => ((await req('GET','/api/planning', t)).body.entries || []).find(e => e.id === id);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-reminders-api-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-reminders-api-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    // anna + bob: Mitarbeiter OHNE Planungsrecht
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'annapw', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const bob  = (await req('POST','/api/users', admin, { username:'bob',  password:'bobpw',  name:'Bob',  role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const annaT = await tok('anna','annapw');
    const bobT  = await tok('bob','bobpw');
    const MON = nextMon();

    // Einzeltag-Planung für Anna (keine group_id → entry_id-Ziel)
    const eA = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'KundeA', assigned_user_ids:[anna.id] })).body.entry;
    ok('Einzelplanung hat keine group_id', !eA.group_id);
    // Mehrtägige Planung für Anna (group_id)
    const gRes = (await req('POST','/api/planning', admin, { days:[
      { date:MON, time_from:'07:00', time_to:'15:30' }, { date:addCal(MON,1), time_from:'07:00', time_to:'15:30' } ],
      client:'KundeG', assigned_user_ids:[anna.id] })).body;
    const gA = gRes.group_id;
    ok('Mehrtag-Planung hat group_id', !!gA);
    // Einzelplanung für Bob
    const eB = (await req('POST','/api/planning', admin, { date:MON, time_from:'09:00', time_to:'12:00', client:'KundeB', assigned_user_ids:[bob.id] })).body.entry;

    // 1) Anna setzt Erinnerung auf eigene Einzelplanung (entry_id) + zweite (mehrere erlaubt)
    const r1 = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eA.id, lead_num:1, lead_unit:'week' });
    ok('Anna: Erinnerung (1 Woche) angelegt', r1.status === 201 && r1.body.reminder.entry_id === eA.id);
    const r2 = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eA.id, lead_num:1, lead_unit:'day' });
    ok('Anna: zweite Erinnerung (1 Tag) angelegt', r2.status === 201);
    const dup = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eA.id, lead_num:1, lead_unit:'week' });
    ok('Duplikat (gleicher Vorlauf) → idempotent, keine neue', dup.status === 200 && dup.body.reminder.id === r1.body.reminder.id);
    const list1 = (await req('GET','/api/planning/reminders?entry_id='+eA.id, annaT)).body.reminders;
    ok('Anna sieht genau 2 Erinnerungen', list1.length === 2, JSON.stringify(list1.map(x=>x.lead_unit)));

    // 2) Rechte: Anna darf NICHT auf Bobs Planung
    const forbidden = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eB.id, lead_num:1, lead_unit:'day' });
    ok('Anna auf Bobs Termin → 403', forbidden.status === 403);
    // Admin darf auf Bobs Planung (canPlanAll)
    const adminOnBob = await req('POST','/api/planning/reminders', admin, { target_type:'occurrence', entry_id:eB.id, lead_num:2, lead_unit:'hour' });
    ok('Admin auf Bobs Termin → 201', adminOnBob.status === 201);

    // 3) Gruppen-Ziel (group_id)
    const rg = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', group_id:gA, lead_num:3, lead_unit:'day' });
    ok('Anna: Gruppen-Erinnerung angelegt', rg.status === 201 && rg.body.reminder.group_id === gA);
    const listG = (await req('GET','/api/planning/reminders?group_id='+gA, annaT)).body.reminders;
    ok('Gruppen-Liste zeigt 1', listG.length === 1);

    // 4) Serien-Ziel
    const s = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'KundeS', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    const rs = await req('POST','/api/planning/reminders', annaT, { target_type:'series', series_id:s.series_id, lead_num:2, lead_unit:'day' });
    ok('Anna: Serien-Erinnerung angelegt', rs.status === 201 && rs.body.reminder.target_type === 'series');
    const listS = (await req('GET','/api/planning/reminders?series_id='+s.series_id, annaT)).body.reminders;
    ok('Serien-Liste zeigt 1', listS.length === 1);

    // 4b) scheduled-Flag (in geplanter Zusammenfassung vs. exakt)
    const eSch = (await req('POST','/api/planning', admin, { date:MON, time_from:'10:00', time_to:'11:00', client:'Sched', assigned_user_ids:[anna.id] })).body.entry;
    const defSch = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eSch.id, lead_num:1, lead_unit:'day' });
    ok('scheduled default = false', defSch.body.reminder.scheduled === false);
    const onSch = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eSch.id, lead_num:1, lead_unit:'day', scheduled:true });
    ok('scheduled=true angelegt (nicht als Duplikat)', onSch.status === 201 && onSch.body.reminder.scheduled === true && onSch.body.reminder.id !== defSch.body.reminder.id);
    const schList = (await req('GET','/api/planning/reminders?entry_id='+eSch.id, annaT)).body.reminders;
    ok('beide Varianten (exakt + geplant) getrennt gelistet', schList.length === 2 && schList.filter(x=>x.scheduled).length === 1);

    // 5) Validierung
    const bad1 = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eA.id, lead_num:0, lead_unit:'day' });
    ok('lead_num 0 → 400', bad1.status === 400);
    const bad2 = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', entry_id:eA.id, lead_num:1, lead_unit:'year' });
    ok('lead_unit "year" → 400', bad2.status === 400);
    const bad3 = await req('POST','/api/planning/reminders', annaT, { target_type:'occurrence', lead_num:1, lead_unit:'day' });
    ok('ohne Ziel → 400', bad3.status === 400);

    // 6) Löschen — nur eigene
    const delOther = await req('DELETE','/api/planning/reminders/'+adminOnBob.body.reminder.id, annaT);
    ok('Anna kann fremde Erinnerung nicht löschen → 404', delOther.status === 404);
    const del = await req('DELETE','/api/planning/reminders/'+r2.body.reminder.id, annaT);
    ok('Anna löscht eigene Erinnerung → success', del.status === 200 && del.body.success);
    const list2 = (await req('GET','/api/planning/reminders?entry_id='+eA.id, annaT)).body.reminders;
    ok('nach Löschen nur noch 1', list2.length === 1);
    const delAgain = await req('DELETE','/api/planning/reminders/'+r2.body.reminder.id, annaT);
    ok('erneutes Löschen → 404', delAgain.status === 404);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Reminders-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
