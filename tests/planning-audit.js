// Audit-Test: Planungsrecht wird semantisch als EINE Stufe protokolliert (keins / nur sich / alle),
// damit „alle → nur sich" (nur die alle-Stufe entzogen) eindeutig erkennbar ist.
// Start: node tests/planning-audit.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3109;
const DB = '/tmp/planning-audit-test.db';

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
const auditDetails = async (t, action) => ((await req('GET','/api/audit?action='+action, t)).body.logs || []).map(e => e.details || '');

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/planning-audit-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-audit-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:apw })).body.token;
    const A = (await req('POST','/api/users', admin, { username:'alex', password:'test', name:'Alex', role:'mitarbeiter', can_plan:0, can_plan_all:0, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    ok('Setup Alex angelegt', !!A);

    // Anlege-Audit enthält semantische Stufe
    const cr = await auditDetails(admin, 'user_create');
    ok('Anlege-Audit: „Planungsrecht: keins"', (cr[0]||'').includes('Planungsrecht: keins'), cr[0]);
    ok('Anlege-Audit: keine alten (sich)/(alle)-Booleschen Felder', !/Recht Planung \((sich|alle)\)/.test(cr[0]||''), cr[0]);

    const put = (cp, cpa) => req('PUT','/api/users/'+A.id, admin, { username:'alex', name:'Alex', role:'mitarbeiter', can_plan:cp, can_plan_all:cpa });
    const lastDetail = async () => (await auditDetails(admin, 'user_update'))[0] || '';

    await put(1,0); ok('keins → nur sich', (await lastDetail()).includes('Planungsrecht: keins → nur sich'), await lastDetail());
    await put(1,1); ok('nur sich → alle', (await lastDetail()).includes('Planungsrecht: nur sich → alle'), await lastDetail());
    await put(1,0); ok('alle → nur sich (nur alle entzogen!)', (await lastDetail()).includes('Planungsrecht: alle → nur sich'), await lastDetail());
    await put(0,0); ok('nur sich → keins', (await lastDetail()).includes('Planungsrecht: nur sich → keins'), await lastDetail());
    await put(0,1); ok('keins → alle (alle impliziert sich)', (await lastDetail()).includes('Planungsrecht: keins → alle'), await lastDetail());

    // Nicht-Planungs-Änderung erzeugt KEINE Planungsrecht-Zeile
    await req('PUT','/api/users/'+A.id, admin, { username:'alex', name:'Alex', role:'mitarbeiter', can_plan:0, can_plan_all:1, can_bulletin:1 });
    ok('Andere Änderung ohne Planungswechsel → keine Planungsrecht-Zeile', !(await lastDetail()).includes('Planungsrecht'), await lastDetail());

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Audit: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
