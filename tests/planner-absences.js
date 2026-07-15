// Planer-Sichtbarkeit-Test: Mitarbeiter mit „alle"-Planungsrecht (can_plan_all) sehen im Planungskontext
// (scope=planning) die Abwesenheiten ALLER — Typ ja, fremder Kommentar gestrippt. Self-Planer (nur
// can_plan) sehen NUR die eigenen. Ohne Recht/scope nur eigene; Manager voll inkl. Kommentar.
// Start: node tests/planner-absences.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3086;
const DB = '/tmp/planner-abs-test.db';
const D = '2026-07-06'; // Testtag

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
const byDate = (tok, scope) => req('GET', `/api/absences/by-date?from=${D}&to=${D}${scope?'&scope=planning':''}`, tok);
const find = (resp, uid) => (resp.body && resp.body.absences || []).find(a => a.user_id === uid);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/planner-abs-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' },
    stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/planner-abs-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    ok('Admin-Login', !!admin);

    // Nutzer anlegen
    const mk = (u, canPlan, canPlanAll) => req('POST','/api/users', admin, { username:u, password:'Test1234!', name:u.toUpperCase(), role:'mitarbeiter', can_plan:canPlan, can_plan_all:canPlanAll, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const P = (await mk('planner', 1, 1)).body.user;   // „alle"-Planer
    const S = (await mk('selfplan', 1, 0)).body.user;  // Self-Planer (nur sich)
    const N = (await mk('normalo', 0, 0)).body.user;   // normaler MA
    const X = (await mk('kollege', 0, 0)).body.user;   // Kollege mit Abwesenheit
    ok('4 Nutzer angelegt (P=alle, S=sich, N/X=0)', !!(P && S && N && X) && P.id && S.id && X.id, JSON.stringify({P:P&&P.id,S:S&&S.id,N:N&&N.id,X:X&&X.id}));

    // Abwesenheiten: X krank (Kommentar), P krank (eigener Kommentar) — beide am selben Tag
    await req('POST','/api/absences', admin, { type:'krank', date_from:D, date_to:D, comment:'GRUND-X', target_user_id:X.id });
    const pTok = (await req('POST','/api/auth/login', null, { username:'planner', password:'Test1234!' })).body.token;
    const nTok = (await req('POST','/api/auth/login', null, { username:'normalo', password:'Test1234!' })).body.token;
    await req('POST','/api/absences', pTok, { type:'krank', date_from:D, date_to:D, comment:'GRUND-P' });

    // N (kein can_plan): sieht X NICHT, selbst mit scope
    let r = await byDate(nTok, true);
    ok('N ohne Planungsrecht sieht X NICHT (trotz scope)', !find(r, X.id), JSON.stringify((r.body.absences||[]).map(a=>a.user_id)));

    // S (Self-Planer, nur „sich"): sieht X NICHT, selbst mit scope — nur eigene Abwesenheiten
    const sTok = (await req('POST','/api/auth/login', null, { username:'selfplan', password:'Test1234!' })).body.token;
    await req('POST','/api/absences', sTok, { type:'krank', date_from:D, date_to:D, comment:'GRUND-S' });
    r = await byDate(sTok, true);
    ok('S (Self-Planer) sieht X NICHT (trotz scope)', !find(r, X.id), JSON.stringify((r.body.absences||[]).map(a=>a.user_id)));
    ok('S sieht eigene Abwesenheit', !!find(r, S.id));

    // P ohne scope: nur eigene, X nicht
    r = await byDate(pTok, false);
    ok('P ohne scope: X NICHT sichtbar', !find(r, X.id));
    ok('P ohne scope: eigene Abwesenheit da', !!find(r, P.id));

    // P mit scope=planning: sieht X, Typ vorhanden, Kommentar gestrippt; eigener Kommentar bleibt
    r = await byDate(pTok, true);
    const xForP = find(r, X.id);
    ok('P mit scope sieht X', !!xForP, JSON.stringify((r.body.absences||[]).map(a=>a.user_id)));
    ok('P sieht X-Typ (krank)', xForP && xForP.type === 'krank', xForP && xForP.type);
    ok('P sieht X-Kommentar NICHT (gestrippt)', xForP && (xForP.comment === '' || xForP.comment == null), JSON.stringify(xForP && xForP.comment));
    ok('P sieht eigenen Kommentar weiterhin', (find(r, P.id)||{}).comment === 'GRUND-P', JSON.stringify((find(r,P.id)||{}).comment));

    // Manager (admin): sieht X inkl. Kommentar
    r = await byDate(admin, false);
    const xForAdmin = find(r, X.id);
    ok('Admin sieht X inkl. Kommentar', xForAdmin && xForAdmin.comment === 'GRUND-X', JSON.stringify(xForAdmin && xForAdmin.comment));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanner-Absences: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
