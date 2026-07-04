// API-Test Projekt-Papierkorb: Soft-Delete, /deleted (Chef/Admin), Restore (Ziele/Zuweisungen bleiben),
// Purge (Name → Freitext, Statistik zählt weiter), Rechte, gleichnamig-neu-Sperre.
// Start: node tests/project-trash.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3134;
const DB = '/tmp/project-trash-test.db';

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
const board = async (t) => ((await req('GET','/api/projects', t)).body.projects || []).map(p => p.name);
const trash = async (t) => (await req('GET','/api/projects/deleted', t)).body.projects || [];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/project-trash-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-trash-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'BH', role:'buchhalter' });
    const m1   = await mk({ username:'m1',    name:'M1', role:'mitarbeiter' });
    const tc = await tok('chef2'), tb = await tok('bh'), tm = await tok('m1');

    const proj = (await req('POST','/api/projects', admin, { name:'Bau A', client:'Kunde A', assigned_user_ids:[m1.id], milestones:[{title:'Ziel1', est_days:3}] })).body.project;
    // m1 bucht 4h aufs Projekt (für den Statistik-/Freitext-Check nach Purge)
    await req('POST','/api/entries', tm, { date:'2026-08-01', time_from:'08:00', time_to:'12:00', break_minutes:0, project_id:proj.id });
    const entry = (await req('GET','/api/entries', tm)).body.entries.find(e => e.project_id === proj.id);
    ok('Setup: Projekt + Ziel + Zuweisung + Buchung', !!(proj && entry));

    // Soft-Delete (Chef)
    ok('Chef DELETE → 200 (soft)', (await req('DELETE','/api/projects/'+proj.id, tc)).status===200);
    ok('vom Board verschwunden', !(await board(admin)).includes('Bau A'));
    ok('im Papierkorb, mit Ziel + Zuweisung erhalten', (await trash(admin)).some(p => p.id===proj.id && (p.milestones||[]).length===1 && (p.assigned_users||[]).length===1));
    ok('übernehmen (GET /:id) eines gelöschten Projekts → 404', (await req('GET','/api/projects/'+proj.id, admin)).status===404);

    // Rechte
    ok('Mitarbeiter DELETE → 403', (await req('DELETE','/api/projects/'+proj.id, tm)).status===403);
    ok('Buchhalter GET /deleted → 403', (await req('GET','/api/projects/deleted', tb)).status===403);
    ok('Buchhalter restore → 403', (await req('POST','/api/projects/'+proj.id+'/restore', tb)).status===403);
    ok('Buchhalter purge → 403', (await req('DELETE','/api/projects/'+proj.id+'/purge', tb)).status===403);
    ok('PUT auf gelöschtes Projekt → 404', (await req('PUT','/api/projects/'+proj.id, admin, { urgency:'rot' })).status===404);
    ok('gleichnamig neu anlegen (im Papierkorb) → 409', (await req('POST','/api/projects', admin, { name:'Bau A' })).status===409);

    // Restore (Admin) → Ziele/Zuweisungen intakt
    ok('Restore → 200', (await req('POST','/api/projects/'+proj.id+'/restore', admin)).status===200);
    const back = (await req('GET','/api/projects', admin)).body.projects.find(p => p.id===proj.id);
    ok('nach Restore auf Board, Ziel + Zuweisung erhalten', !!back && (back.milestones||[]).length===1 && (back.assigned_users||[]).length===1);

    // Erneut löschen → Purge (Chef) → Name landet im Freitext
    await req('DELETE','/api/projects/'+proj.id, tc);
    ok('Chef purge → 200', (await req('DELETE','/api/projects/'+proj.id+'/purge', tc)).status===200);
    ok('nach Purge nicht mehr im Papierkorb', !(await trash(admin)).some(p => p.id===proj.id));
    const e2 = (await req('GET','/api/entries/'+entry.id, tm)).body.entry;
    ok('nach Purge: Projektname im Zeiteintrag-Freitext', e2 && e2.project_text==='Bau A', JSON.stringify(e2 && { pid:e2.project_id, pt:e2.project_text }));
    // gleichnamig neu → jetzt erlaubt, Statistik zählt Alt-Stunden über den Namen weiter
    const proj2 = (await req('POST','/api/projects', admin, { name:'Bau A' })).body.project;
    ok('gleichnamig neu anlegen nach Purge → 201', !!(proj2 && proj2.id));
    const st = (await req('GET','/api/projects/'+proj2.id+'/stats', admin)).body;
    ok('Statistik des neuen Projekts enthält Alt-Stunden (4 h via Freitext)', st.total_hours===4, JSON.stringify(st.per_user));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProject-Trash (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
