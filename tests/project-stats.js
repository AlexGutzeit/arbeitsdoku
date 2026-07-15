// API-Test Auftrags-Statistik: Netto-Stunden je Bucher (alle außer Admin), Dropdown + Freitext,
// Löschen→Neu-Anlegen (Name-Match), Netto ohne Pause, Rechte.
// Start: node tests/project-stats.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3130;
const DB = '/tmp/project-stats-test.db';

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
const stats = async (t, id) => (await req('GET','/api/projects/'+id+'/stats', t)).body;
const hoursOf = (s, name) => { const r = (s.per_user||[]).find(x=>x.name===name); return r ? r.hours : undefined; };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/project-stats-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-stats-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'Test1234!', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'Bucha Halter', role:'buchhalter' });
    const m1   = await mk({ username:'m1',    name:'M Eins', role:'mitarbeiter' });
    const m2   = await mk({ username:'m2',    name:'M Zwei', role:'mitarbeiter' });
    const tc = await tok('chef2'), tb = await tok('bh'), tm1 = await tok('m1'), tm2 = await tok('m2');
    const proj = (await req('POST','/api/projects', admin, { name:'Bau A' })).body.project;

    // Buchungen: m1 2 Einträge (7.5 + 4), chef 1 (4), bh 1 (2), m2 Freitext mit Projektname (2)
    await req('POST','/api/entries', tm1, { date:'2026-08-01', time_from:'07:00', time_to:'15:00', break_minutes:30, project_id:proj.id }); // netto 7.5
    await req('POST','/api/entries', tm1, { date:'2026-08-02', time_from:'08:00', time_to:'12:00', break_minutes:0, project_id:proj.id });  // 4
    await req('POST','/api/entries', tc,  { date:'2026-08-01', time_from:'09:00', time_to:'13:00', break_minutes:0, project_id:proj.id });  // chef 4
    await req('POST','/api/entries', tb,  { date:'2026-08-01', time_from:'10:00', time_to:'12:00', break_minutes:0, project_id:proj.id });  // bh 2
    await req('POST','/api/entries', tm2, { date:'2026-08-03', time_from:'06:00', time_to:'08:00', break_minutes:0, project_text:'Bau A' }); // Freitext 2
    // Admin bucht für sich selbst → darf NICHT auftauchen
    await req('POST','/api/entries', admin, { date:'2026-08-04', time_from:'07:00', time_to:'09:00', break_minutes:0, project_id:proj.id, user_id:1 });

    const s = await stats(admin, proj.id);
    ok('m1 = 11,5 h netto (7.5+4 via project_id), 2 Einträge', hoursOf(s,'M Eins')===11.5 && s.per_user.find(x=>x.name==='M Eins').entries===2, JSON.stringify(s.per_user));
    ok('Chef erscheint (4 h)', hoursOf(s,'Chef Zwei')===4);
    ok('Buchhalter erscheint (2 h)', hoursOf(s,'Bucha Halter')===2);
    ok('m2-Freitext (Projektname) zählt zu m2 (2 h)', hoursOf(s,'M Zwei')===2);
    ok('Admin NICHT in der Statistik', !(s.per_user||[]).some(x=>x.name==='Administrator'));
    ok('Gesamt = 19,5 h (ohne Admin)', s.total_hours===19.5, String(s.total_hours));
    ok('Gesamt-Einträge = 5 (ohne Admin)', s.total_entries===5, String(s.total_entries));
    ok('Netto ohne Pause (11.5 statt 12; 07–15/30min = 7.5)', s.per_user.find(x=>x.name==='M Eins').hours===11.5);

    // Rechte
    ok('Mitarbeiter GET stats → 403', (await req('GET','/api/projects/'+proj.id+'/stats', tm1)).status===403);
    ok('Buchhalter GET stats → 200', (await req('GET','/api/projects/'+proj.id+'/stats', tb)).status===200);
    ok('Chef GET stats → 200', (await req('GET','/api/projects/'+proj.id+'/stats', tc)).status===200);

    // Löschen (soft) → endgültig löschen (Name → Freitext) → gleichnamig neu anlegen → Alt-Stunden bleiben
    const projB = (await req('POST','/api/projects', admin, { name:'Bau B' })).body.project;
    await req('POST','/api/entries', tm1, { date:'2026-09-01', time_from:'07:00', time_to:'12:00', break_minutes:0, project_id:projB.id }); // 5
    ok('Vor Löschung: Bau B hat 5 h', (await stats(admin, projB.id)).total_hours===5);
    await req('DELETE','/api/projects/'+projB.id, admin);          // soft → Papierkorb
    await req('DELETE','/api/projects/'+projB.id+'/purge', admin); // endgültig → Name wandert in Freitext
    const projB2 = (await req('POST','/api/projects', admin, { name:'Bau B' })).body.project; // neue id
    ok('Neu angelegtes gleichnamiges Projekt hat andere id', projB2.id !== projB.id);
    const s2 = await stats(admin, projB2.id);
    ok('Statistik zählt Alt-Einträge über Freitext-Namen weiter (5 h)', s2.total_hours===5 && hoursOf(s2,'M Eins')===5, JSON.stringify(s2.per_user));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProject-Stats (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
