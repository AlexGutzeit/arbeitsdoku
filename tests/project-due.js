// API-Test „Fällig bis": gültiges/ungültiges/leeres Datum, GET liefert es, PUT ohne Feld unverändert.
// Start: node tests/project-due.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3142;
const DB = '/tmp/project-due-test.db';

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
const dueOf = async (t, id) => (await req('GET','/api/projects/'+id, t)).body.project.due_date;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/project-due-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-due-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);

    let r = await req('POST','/api/projects', admin, { name:'Bau A', due_date:'2026-08-15' });
    const id = r.body.project.id;
    ok('gültiges Datum gespeichert', r.body.project.due_date==='2026-08-15');
    ok('POST ungültig (Text) → NULL', (await req('POST','/api/projects', admin, { name:'Bau B', due_date:'morgen' })).body.project.due_date===null);
    ok('POST ungültig (2026-13-40) → NULL', (await req('POST','/api/projects', admin, { name:'Bau C', due_date:'2026-13-40' })).body.project.due_date===null);
    ok('POST ohne Datum → NULL', (await req('POST','/api/projects', admin, { name:'Bau D' })).body.project.due_date===null);
    ok('GET liefert due_date', (await dueOf(admin, id))==='2026-08-15');
    await req('PUT','/api/projects/'+id, admin, { urgency:'rot' });
    ok('PUT ohne due_date → unverändert', (await dueOf(admin, id))==='2026-08-15');
    await req('PUT','/api/projects/'+id, admin, { due_date:'2026-09-01' });
    ok('PUT setzt neues Datum', (await dueOf(admin, id))==='2026-09-01');
    await req('PUT','/api/projects/'+id, admin, { due_date:'' });
    ok('PUT leer → NULL (Datum entfernt)', (await dueOf(admin, id))===null);
    ok('due_date im Board-GET enthalten', 'due_date' in ((await req('GET','/api/projects', admin)).body.projects[0]));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProject-Due (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
