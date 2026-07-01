// API-Test der geplanten Zusammenfassungen (Digest-Push): CRUD, Validierung, Ownership, Rollenfilter
// (orders nur Chef/Admin), Einzel-Pause + Global-Pause. Start: node tests/push-summaries.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3102;
const DB = '/tmp/push-summaries-test.db';

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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/push-summaries-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/push-summaries-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    await req('POST','/api/users', admin, { username:'xma', password:'test', name:'XMA', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    await req('POST','/api/users', admin, { username:'xma2', password:'test', name:'XMA2', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const t1 = await tok('xma'), t2 = await tok('xma2');
    ok('Setup (admin + 2 MA)', !!(admin && t1 && t2));

    // Anlegen mit Name
    let r = await req('POST','/api/push/summaries', admin, { name:'Einkaufen', weekdays:[1,3,5], time:'17:30', cats:['orders','notes','absences','bulletin'] });
    ok('POST anlegen → 201 mit Name/Feldern', r.status===201 && r.body.schedule.name==='Einkaufen' && r.body.schedule.time==='17:30' && r.body.schedule.weekdays.join()==='1,3,5', JSON.stringify(r.body));
    const id = r.body.schedule.id;
    ok('  cats vollständig (admin darf orders)', r.body.schedule.cats.sort().join()==='absences,bulletin,notes,orders', JSON.stringify(r.body.schedule.cats));

    // Liste
    r = await req('GET','/api/push/summaries', admin);
    ok('GET Liste enthält den Plan + pausedAll=false', r.status===200 && r.body.schedules.length===1 && r.body.pausedAll===false, JSON.stringify(r.body));

    // Validierung
    ok('leere Wochentage → 400', (await req('POST','/api/push/summaries', admin, { weekdays:[], time:'10:00', cats:['notes'] })).status===400);
    ok('ungültige Uhrzeit → 400', (await req('POST','/api/push/summaries', admin, { weekdays:[1], time:'25:99', cats:['notes'] })).status===400);
    ok('leere Kategorien → 400', (await req('POST','/api/push/summaries', admin, { weekdays:[1], time:'10:00', cats:[] })).status===400);

    // Rollenfilter: MA darf kein 'orders'
    r = await req('POST','/api/push/summaries', t1, { name:'MA-Plan', weekdays:[2], time:'09:00', cats:['orders','notes'] });
    ok('MA: orders wird verworfen (nur notes bleibt)', r.status===201 && r.body.schedule.cats.join()==='notes', JSON.stringify(r.body.schedule.cats));
    ok('MA: nur orders → 400 (nach Filter leer)', (await req('POST','/api/push/summaries', t1, { weekdays:[2], time:'09:00', cats:['orders'] })).status===400);

    // Bearbeiten (Zeit + Name)
    r = await req('PUT','/api/push/summaries/'+id, admin, { name:'Feierabend', time:'18:00' });
    ok('PUT bearbeiten (Name+Zeit) → 200', r.status===200 && r.body.schedule.name==='Feierabend' && r.body.schedule.time==='18:00', JSON.stringify(r.body.schedule));

    // Einzel-Pause
    r = await req('PUT','/api/push/summaries/'+id, admin, { paused:true });
    ok('PUT paused=true → 200', r.status===200 && r.body.schedule.paused===true);

    // Ownership: MA darf fremden Plan nicht ändern/löschen
    ok('MA PUT fremder Plan → 404', (await req('PUT','/api/push/summaries/'+id, t1, { paused:false })).status===404);
    ok('MA DELETE fremder Plan → 404', (await req('DELETE','/api/push/summaries/'+id, t1)).status===404);

    // Global-Pause
    r = await req('PUT','/api/push/summaries/pause-all', admin, { paused:true });
    ok('pause-all=true → 200', r.status===200 && r.body.pausedAll===true);
    r = await req('GET','/api/push/summaries', admin);
    ok('GET zeigt pausedAll=true', r.body.pausedAll===true);
    await req('PUT','/api/push/summaries/pause-all', admin, { paused:false });

    // Löschen
    ok('DELETE eigener Plan → 200', (await req('DELETE','/api/push/summaries/'+id, admin)).status===200);
    ok('DELETE erneut → 404', (await req('DELETE','/api/push/summaries/'+id, admin)).status===404);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPush-Summaries (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
