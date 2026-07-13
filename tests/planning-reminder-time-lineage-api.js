// API-Test: Benachrichtigungs-ZEIT über Takt-Sprünge hinweg. Serie → Takt ab 5 → Takt ab 9 → Zeit ab 7
// „folgende" muss von 7 bis unendlich gelten (trotz Takt-Sprung) → verlangt gemeinsame reminder_group über
// Takte. Dann Takt ab 3 + neue Zeit ab 3: erste 2 eigener Takt+Zeit, 3+ eigener Takt+Zeit. Keine Waisen.
// Start: node tests/planning-reminder-time-lineage-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3166, DB = '/tmp/rem-time-lineage.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) { return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
  const r = http.request({ host:'localhost', port:PORT, path:p, method:m, headers:{ 'Content-Type':'application/json', ...(t?{Authorization:'Bearer '+t}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
  r.on('error', rej); if (d) r.write(d); r.end(); }); }
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/rem-time-lineage-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/rem-time-lineage-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const a = (await req('POST','/api/users', admin, { username:'a', password:'p', name:'A', role:'mitarbeiter', hours_mon:8 })).body.user;

    // Vorkommen geordnet + Reminder-Zeit/-Id/-Vorlauf
    const oi = async () => { const es = ((await req('GET','/api/planning', admin)).body.entries||[]).filter(e=>e.client==='TZ' && e.occurrence_date); const seen={}; const out=[]; for (const e of es.sort((x,y)=>x.occurrence_date<y.occurrence_date?-1:1)) { if(seen[e.occurrence_date])continue; seen[e.occurrence_date]=1; const rs=(await req('GET','/api/planning/reminders?group_id='+e.group_id,admin)).body.reminders||[]; out.push({od:e.occurrence_date,sid:e.series_id,gid:e.group_id,rt:rs[0]&&rs[0].remind_time,rid:rs[0]&&rs[0].id,ln:rs[0]&&rs[0].lead_num,lu:rs[0]&&rs[0].lead_unit,n:rs.length}); } return out; };
    const cad = (o) => new Set(o.map(x=>x.sid)).size;
    const orph = async () => { const all=((await req('GET','/api/planning',admin)).body.entries||[]); const g=new Set(all.filter(e=>e.group_id).map(e=>e.group_id)); const i=new Set(all.map(e=>e.id)); return ((await req('GET','/api/planning/reminders/mine',admin)).body.reminders).filter(r=>(r.group_id&&!g.has(r.group_id))||(r.entry_id&&!i.has(r.entry_id))).length; };
    const retakt = (sid, od, freq) => req('POST','/api/planning/series/'+sid+'/retakt', admin, { scope:'following', occurrence_date:od, days:[{ date:od, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq, end_type:'count', end_count:12 }, assigned_user_ids:[a.id], client:'TZ' });

    const s = (await req('POST','/api/planning', admin, { date:'2027-06-07', time_from:'07:00', time_to:'15:30', client:'TZ', assigned_user_ids:[a.id], recurrence:{ freq:'weekly', end_type:'count', end_count:12 } })).body;
    let o = await oi();
    await req('POST','/api/planning/reminders', admin, { series_id:s.series_id, occurrence_date:o[0].od, group_id:o[0].gid, scope:'all', lead_num:1, lead_unit:'week', remind_time:'07:00' });
    await retakt(o[4].sid, o[4].od, 'monthly_date'); o = await oi();  // Takt ab 5
    await retakt(o[6].sid, o[6].od, 'weekly'); o = await oi();         // Takt ab 7 (overall)
    ok('3 Takte, alle Zeiten 07:00, keine Waisen', cad(o)===3 && o.every(x=>x.rt==='07:00') && await orph()===0);

    // Zeit ab dem 7. „folgende" → 18:00 (muss über den Takt-Sprung 9 hinweg gelten)
    await req('PUT','/api/planning/reminders/'+o[6].rid, admin, { lead_num:o[6].ln, lead_unit:o[6].lu, remind_time:'18:00', scope:'following' });
    o = await oi();
    ok('Zeit ab 7 = 18:00 gilt bis unendlich (über Takt-Sprung); 1–6 bleiben 07:00', o.slice(0,6).every(x=>x.rt==='07:00') && o.slice(6).every(x=>x.rt==='18:00') && await orph()===0, 'zeiten='+o.map(x=>x.rt).join(','));

    // Takt ab dem 3. + neue Zeit ab dem 3. → 09:00
    await retakt(o[2].sid, o[2].od, 'monthly_date'); o = await oi();
    await req('PUT','/api/planning/reminders/'+o[2].rid, admin, { lead_num:o[2].ln, lead_unit:o[2].lu, remind_time:'09:00', scope:'following' });
    o = await oi();
    ok('nach Takt@3 + Zeit@3: genau 2 Takte', cad(o)===2);
    ok('erste 2: eigener Takt + Zeit 07:00', o.slice(0,2).every(x=>x.rt==='07:00') && o[0].sid===o[1].sid);
    ok('3–unendlich: eigener Takt + Zeit 09:00, alle mit Benachrichtigung, keine Waisen', o.slice(2).every(x=>x.rt==='09:00' && x.n===1) && o[2].sid!==o[0].sid && await orph()===0, 'zeiten='+o.map(x=>x.rt).join(','));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Reminder-Time-Lineage-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
