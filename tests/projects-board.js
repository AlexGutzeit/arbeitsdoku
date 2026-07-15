// API-Test Auftrags-Board: projects mit Kunde/Notiz/Dringlichkeit/Zuweisung/Erledigt; Rollen-Gating;
// Löschen erhält Projektnamen im Freitext. Start: node tests/projects-board.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3111;
const DB = '/tmp/projects-board-test.db';

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
const tok = async (u, pw='Test1234!') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const board = async (t, done) => ((await req('GET','/api/projects'+(done?'?done=1':''), t)).body.projects || []);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/projects-board-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/projects-board-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const A = (await req('POST','/api/users', admin, { username:'m1', password:'Test1234!', name:'M1', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const B = (await req('POST','/api/users', admin, { username:'m2', password:'Test1234!', name:'M2', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const t1 = await tok('m1');
    ok('Setup (admin + 2 MA)', !!(A && B && t1));

    // Anlegen mit allen Feldern + 2 Zuweisungen
    let r = await req('POST','/api/projects', admin, { name:'Auftrag Müller', client:'Müller GmbH', address:'Hauptstr 1', note:'PV-Anlage 10kWp', urgency:'rot', assigned_user_ids:[A.id, B.id] });
    ok('POST Auftrag → 201 mit Feldern', r.status===201 && r.body.project.client==='Müller GmbH' && r.body.project.urgency==='rot' && r.body.project.address==='Hauptstr 1', JSON.stringify(r.body.project));
    ok('  → 2 zugewiesene Mitarbeiter', (r.body.project.assigned_users||[]).length===2, JSON.stringify(r.body.project.assigned_users));
    const pid = r.body.project.id;

    // Ungültige Dringlichkeit → Fallback gelb
    r = await req('POST','/api/projects', admin, { name:'Auftrag X', urgency:'lila' });
    ok('Ungültige Dringlichkeit → Fallback gelb', r.status===201 && r.body.project.urgency==='gelb', r.body.project && r.body.project.urgency);

    // Board für MA sichtbar (mit assigned_users)
    const bl = await board(t1);
    ok('MA sieht Board inkl. Zuweisungen', bl.some(p => p.id===pid && (p.assigned_users||[]).length===2));

    // Rollen-Gating
    ok('MA POST → 403', (await req('POST','/api/projects', t1, { name:'y' })).status===403);
    ok('MA PUT → 403', (await req('PUT','/api/projects/'+pid, t1, { name:'z' })).status===403);
    ok('MA done → 403', (await req('POST','/api/projects/'+pid+'/done', t1)).status===403);

    // Bearbeiten (Chef): Felder + Neuzuweisung (nur B)
    r = await req('PUT','/api/projects/'+pid, admin, { name:'Auftrag Müller', client:'Müller & Co', urgency:'orange', assigned_user_ids:[B.id] });
    ok('PUT bearbeiten → Kunde/Dringlichkeit/Zuweisung aktualisiert', r.status===200 && r.body.project.client==='Müller & Co' && r.body.project.urgency==='orange' && (r.body.project.assigned_users||[]).length===1 && r.body.project.assigned_users[0].user_id===B.id, JSON.stringify(r.body.project));

    // GET /:id (Übernehmen-Vorbefüllung)
    r = await req('GET','/api/projects/'+pid, t1);
    ok('GET /:id liefert Projekt inkl. assigned_users', r.status===200 && r.body.project.id===pid && Array.isArray(r.body.project.assigned_users));

    // Erledigt → weg vom Board, im Archiv sichtbar; reopen → zurück
    ok('done → 200', (await req('POST','/api/projects/'+pid+'/done', admin)).status===200);
    ok('  → nicht mehr im offenen Board', !(await board(admin)).some(p => p.id===pid));
    ok('  → im Archiv (?done=1)', (await board(admin, true)).some(p => p.id===pid));
    ok('reopen → wieder im Board', (await req('POST','/api/projects/'+pid+'/reopen', admin)).status===200 && (await board(admin)).some(p => p.id===pid));

    // Löschen erhält Projektnamen im Zeiteintrag-Freitext
    const entry = (await req('POST','/api/entries', t1, { date:'2026-08-01', time_from:'07:00', time_to:'15:00', break_minutes:30, project_id:pid })).body.entry;
    ok('Zeiteintrag mit project_id angelegt', !!(entry && entry.id));
    await req('DELETE','/api/projects/'+pid, admin);
    const e2 = (await req('GET','/api/entries/'+entry.id, t1)).body.entry;
    ok('nach Projekt-Löschung: Projektname im Freitext erhalten', e2 && e2.project_text==='Auftrag Müller', JSON.stringify(e2 && {pid:e2.project_id, pt:e2.project_text}));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProjects-Board (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
