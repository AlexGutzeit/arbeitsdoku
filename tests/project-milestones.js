// API-Test Zwischenziele: CRUD via POST/PUT (Merge erhält Status), Status-PATCH (Rechte), Löschen kaskadiert.
// Start: node tests/project-milestones.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3124;
const DB = '/tmp/project-ms-test.db';

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
const getProj = async (t, id) => (await req('GET','/api/projects/'+id, t)).body.project;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/project-ms-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-ms-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const m1 = await mk({ username:'m1', name:'M1' });  // zugeteilt
    const m2 = await mk({ username:'m2', name:'M2' });  // nicht zugeteilt
    const tm1 = await tok('m1'), tm2 = await tok('m2');

    // POST mit 3 Zielen
    let r = await req('POST','/api/projects', admin, { name:'Bau A', assigned_user_ids:[m1.id], milestones:[
      { title:'Hauptverteiler', est_days:2 }, { title:'Trassen bauen', est_days:30 }, { title:'Kabel verlegen', est_days:14 }, { title:'  ', est_days:5 } ] });
    const pid = r.body.project.id; const ms = r.body.project.milestones;
    ok('POST: 3 Ziele (leerer Titel übersprungen), Reihenfolge, alle offen', ms.length===3 && ms[0].title==='Hauptverteiler' && ms[2].title==='Kabel verlegen' && ms.every(m=>m.status==='offen'), JSON.stringify(ms.map(m=>m.title)));
    ok('POST: est_days korrekt', ms[0].est_days===2 && ms[1].est_days===30 && ms[2].est_days===14);

    // PATCH-Rechte
    ok('Zugeteilter MA setzt Status → 200', (await req('PATCH','/api/projects/'+pid+'/milestones/'+ms[0].id+'/status', tm1, { status:'done' })).status===200);
    ok('Chef/Admin (nicht zugeteilt) setzt Status → 200', (await req('PATCH','/api/projects/'+pid+'/milestones/'+ms[1].id+'/status', admin, { status:'doing' })).status===200);
    ok('Fremder MA → 403', (await req('PATCH','/api/projects/'+pid+'/milestones/'+ms[2].id+'/status', tm2, { status:'doing' })).status===403);
    ok('Ungültiger Status → 400', (await req('PATCH','/api/projects/'+pid+'/milestones/'+ms[2].id+'/status', admin, { status:'lila' })).status===400);
    ok('Unbekanntes Ziel → 404', (await req('PATCH','/api/projects/'+pid+'/milestones/999999/status', admin, { status:'done' })).status===404);

    let proj = await getProj(admin, pid);
    ok('Status persistiert (done/doing/offen)', proj.milestones[0].status==='done' && proj.milestones[1].status==='doing' && proj.milestones[2].status==='offen');

    // PUT-Merge: Hauptverteiler behalten (Status done bleibt), Trassen umbenennen+Dauer (Status doing bleibt),
    // Kabel entfernen, neues Ziel „Doku" hinzufügen
    r = await req('PUT','/api/projects/'+pid, admin, { milestones:[
      { id:ms[0].id, title:'Hauptverteiler', est_days:2 },
      { id:ms[1].id, title:'Trassen NEU', est_days:25 },
      { title:'Doku', est_days:1 } ] });
    const m = r.body.project.milestones;
    ok('PUT-Merge: 3 Ziele (Kabel weg, Doku neu)', m.length===3 && m.map(x=>x.title).join(',')==='Hauptverteiler,Trassen NEU,Doku', m.map(x=>x.title).join(','));
    ok('PUT-Merge: Status bestehender Ziele erhalten', m[0].status==='done' && m[1].status==='doing' && m[2].status==='offen', JSON.stringify(m.map(x=>x.status)));
    ok('PUT-Merge: Dauer aktualisiert (Trassen 25)', m[1].est_days===25);

    // PUT ohne milestones-Feld → Ziele bleiben unangetastet
    await req('PUT','/api/projects/'+pid, admin, { urgency:'rot' });
    proj = await getProj(admin, pid);
    ok('PUT ohne milestones-Feld lässt Ziele unverändert', proj.milestones.length===3);

    // Löschen kaskadiert (kein Fehler; Projekt weg)
    ok('Projekt löschen → 200', (await req('DELETE','/api/projects/'+pid, admin)).status===200);
    ok('Projekt danach nicht mehr abrufbar', (await req('GET','/api/projects/'+pid, admin)).status===404);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProject-Milestones (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
