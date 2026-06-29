// Self-Planung-Test: Planungsrecht-Stufen „sich" (can_plan) vs. „alle" (can_plan_all).
// - Self-Planer darf nur sich selbst verplanen (POST), nur eigene (ihm zugewiesene) Einträge bearbeiten/löschen.
// - Geteilte Einträge: Löschen klinkt nur ihn aus, Zeiten ändern teilt auf (aus 1 mach 2).
// - „alle"-Planer darf beliebige Mitarbeiter verplanen. PUT /api/users normalisiert „alle ⇒ sich".
// Start: node tests/self-planning.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3087;
const DB = '/tmp/self-planning-test.db';

function req(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{
      'Content-Type':'application/json',
      ...(token ? { Authorization:'Bearer '+token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ '+n)) : (fail++, console.log('  ✗ '+n+(e?'  → '+e:'')));
const aids = e => ((e && e.assigned_users) || []).map(a => a.user_id).sort((x,y)=>x-y);
const getEntry = (id, tok) => req('GET', '/api/planning/'+id, tok);
const listDay = (d, tok) => req('GET', `/api/planning?date_from=${d}&date_to=${d}`, tok);
const plan = (tok, d, ids, from='07:00', to='16:00') => req('POST','/api/planning', tok,
  { date:d, time_from:from, time_to:to, break_minutes:30, address:'Teststr 1', client:'KdA', assigned_user_ids:ids });

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/self-planning-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' },
    stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/self-planning-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    ok('Admin-Login', !!admin);

    const mk = (u, canPlan, canPlanAll) => req('POST','/api/users', admin, { username:u, password:'test', name:u.toUpperCase(), role:'mitarbeiter', can_plan:canPlan, can_plan_all:canPlanAll, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const A = (await mk('aplan', 1, 1)).body.user;   // „alle"-Planer
    const S = (await mk('splan', 1, 0)).body.user;   // Self-Planer
    const N = (await mk('nplan', 0, 0)).body.user;   // normaler MA
    ok('Nutzer angelegt (A=alle, S=sich, N=0)', !!(A && S && N) && A.id && S.id && N.id);
    ok('„alle"-Recht impliziert „sich" (A.can_plan=1)', A.can_plan === 1, JSON.stringify(A.can_plan));

    const aTok = (await req('POST','/api/auth/login', null, { username:'aplan', password:'test' })).body.token;
    const sTok = (await req('POST','/api/auth/login', null, { username:'splan', password:'test' })).body.token;

    // --- POST-Durchsetzung Self-Planer ---
    let r = await plan(sTok, '2026-08-10', [S.id]);
    ok('S plant sich selbst → 201', r.status === 201, r.status+' '+JSON.stringify(r.body));
    const ownId = r.body.entry && r.body.entry.id;

    r = await plan(sTok, '2026-08-10', [N.id]);
    ok('S plant N (fremd) → 403', r.status === 403, r.status+'');
    r = await plan(sTok, '2026-08-10', [S.id, N.id]);
    ok('S plant sich+N → 403', r.status === 403, r.status+'');

    // --- Self-Planer: eigenen Allein-Eintrag in place ändern + löschen ---
    r = await req('PUT','/api/planning/'+ownId, sTok, { date:'2026-08-10', time_from:'09:00', time_to:'12:00', break_minutes:0, assigned_user_ids:[S.id] });
    ok('S ändert eigenen Eintrag in place → 200', r.status === 200 && !(r.body && r.body.split), r.status+' '+JSON.stringify(r.body));
    r = await getEntry(ownId, sTok);
    ok('  …gleiche Eintrags-ID, neue Zeit 09:00', r.body.entry && r.body.entry.time_from === '09:00' && JSON.stringify(aids(r.body.entry))===JSON.stringify([S.id]));
    r = await req('DELETE','/api/planning/'+ownId, sTok);
    ok('S löscht eigenen Eintrag → 200', r.status === 200);
    r = await getEntry(ownId, sTok);
    ok('  …Eintrag ist weg (404)', r.status === 404);

    // --- Geteilter Eintrag: A plant S+N; S löscht → nur S ausgeklinkt ---
    r = await plan(aTok, '2026-08-11', [S.id, N.id]);
    const sharedDel = r.body.entry && r.body.entry.id;
    ok('A plant S+N → 201', r.status === 201 && JSON.stringify(aids(r.body.entry))===JSON.stringify([S.id,N.id].sort((x,y)=>x-y)));
    r = await req('DELETE','/api/planning/'+sharedDel, sTok);
    ok('S löscht geteilten Eintrag → unclinch', r.status === 200 && r.body && r.body.unclinch === true, JSON.stringify(r.body));
    r = await getEntry(sharedDel, sTok);
    ok('  …Eintrag bleibt, nur noch N zugewiesen', r.status === 200 && JSON.stringify(aids(r.body.entry))===JSON.stringify([N.id]), JSON.stringify(r.body.entry && aids(r.body.entry)));

    // --- Geteilter Eintrag: A plant S+N; S ändert Zeiten → Aufteilen (aus 1 mach 2) ---
    r = await plan(aTok, '2026-08-12', [S.id, N.id], '07:00', '16:00');
    const sharedEdit = r.body.entry && r.body.entry.id;
    ok('A plant S+N (07-16) → 201', r.status === 201);
    r = await req('PUT','/api/planning/'+sharedEdit, sTok, { date:'2026-08-12', time_from:'08:00', time_to:'14:00', break_minutes:0, assigned_user_ids:[S.id] });
    ok('S ändert Zeiten am geteilten Eintrag → split', r.status === 200 && r.body && r.body.split === true, JSON.stringify(r.body));
    r = await getEntry(sharedEdit, sTok);
    ok('  …Original unverändert (07:00, nur N)', r.status===200 && r.body.entry.time_from === '07:00' && JSON.stringify(aids(r.body.entry))===JSON.stringify([N.id]), JSON.stringify(r.body.entry && {t:r.body.entry.time_from, a:aids(r.body.entry)}));
    r = await listDay('2026-08-12', aTok);
    const day = (r.body.entries || []);
    const mine = day.find(e => e.time_from === '08:00' && JSON.stringify(aids(e))===JSON.stringify([S.id]));
    ok('  …neuer eigener Eintrag (08:00, nur S) existiert', !!mine, JSON.stringify(day.map(e=>({id:e.id,t:e.time_from,a:aids(e)}))));
    ok('  …genau 2 Einträge am Tag (Original + neuer)', day.length === 2, ''+day.length);

    // --- Fremd-Eintrag (S nicht zugewiesen): kein Zugriff ---
    r = await plan(aTok, '2026-08-13', [N.id]);
    const foreign = r.body.entry && r.body.entry.id;
    ok('A plant nur N → 201', r.status === 201);
    r = await req('PUT','/api/planning/'+foreign, sTok, { date:'2026-08-13', time_from:'08:00', time_to:'14:00', assigned_user_ids:[S.id] });
    ok('S bearbeitet fremden Eintrag → 403', r.status === 403, r.status+'');
    r = await req('DELETE','/api/planning/'+foreign, sTok);
    ok('S löscht fremden Eintrag → 403', r.status === 403, r.status+'');

    // --- „alle"-Planer darf beliebig zuweisen ---
    r = await plan(aTok, '2026-08-14', [S.id, N.id]);
    ok('A plant S+N → 201', r.status === 201);

    // --- PUT /api/users normalisiert „alle ⇒ sich" ---
    r = await req('PUT','/api/users/'+N.id, admin, { username:'nplan', name:'NPLAN', role:'mitarbeiter', can_plan:0, can_plan_all:1 });
    ok('PUT users: can_plan_all=1 setzt can_plan automatisch', r.body.user && r.body.user.can_plan === 1 && r.body.user.can_plan_all === 1, JSON.stringify(r.body.user && {p:r.body.user.can_plan, a:r.body.user.can_plan_all}));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nSelf-Planning: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
