// API-Test „Freigabe verlassen": Empfänger entfernt sich selbst aus einer geteilten Notiz; beim
// Eigentümer verschwindet der Haken, erneutes Anhaken fügt wieder hinzu. Start: node tests/note-leave.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3105;
const DB = '/tmp/note-leave-test.db';

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
const notesOf = async (t) => ((await req('GET','/api/notes', t)).body.notes || []);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/note-leave-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/note-leave-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const O = (await req('POST','/api/users', admin, { username:'owner', password:'Test1234!', name:'OWNER', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const B = (await req('POST','/api/users', admin, { username:'empf', password:'Test1234!', name:'EMPF', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const tO = await tok('owner'), tB = await tok('empf');
    ok('Setup (owner + empfänger)', !!(O && B && tO && tB));

    // O legt Notiz an + teilt mit B (read)
    const note = (await req('POST','/api/notes', tO, { title:'Geteilte Notiz', body:'Inhalt' })).body.note;
    await req('PUT','/api/notes/'+note.id+'/shares', tO, { shares:[{ user_id:B.id, permission:'read' }] });
    ok('B sieht die geteilte Notiz', (await notesOf(tB)).some(n => n.id === note.id));

    // Owner darf sich nicht „verlassen"
    ok('Owner /share/self → 400', (await req('DELETE','/api/notes/'+note.id+'/share/self', tO)).status === 400);

    // B verlässt die Freigabe
    ok('B verlässt Freigabe → 200', (await req('DELETE','/api/notes/'+note.id+'/share/self', tB)).status === 200);
    ok('  → Notiz weg aus B-Liste', !(await notesOf(tB)).some(n => n.id === note.id));
    ok('  → Notiz existiert weiter beim Owner', (await notesOf(tO)).some(n => n.id === note.id));
    const shares = (await req('GET','/api/notes/'+note.id+'/shares', tO)).body.shares || [];
    ok('  → Owner-Freigabeliste enthält B NICHT mehr (Haken leer)', !shares.some(s => s.user_id === B.id), JSON.stringify(shares.map(s=>s.user_id)));

    // Erneutes Verlassen → 404
    ok('B verlässt erneut → 404', (await req('DELETE','/api/notes/'+note.id+'/share/self', tB)).status === 404);

    // Owner hakt B wieder an → B sieht die Notiz wieder
    await req('PUT','/api/notes/'+note.id+'/shares', tO, { shares:[{ user_id:B.id, permission:'read' }] });
    ok('Owner hakt B wieder an → B sieht Notiz wieder', (await notesOf(tB)).some(n => n.id === note.id));

    // Fremder ohne Freigabe kann nicht „verlassen"
    const C = (await req('POST','/api/users', admin, { username:'dritt', password:'Test1234!', name:'DRITT', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const tC = await tok('dritt');
    ok('Nicht-Freigegebener /share/self → 404', (await req('DELETE','/api/notes/'+note.id+'/share/self', tC)).status === 404);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nNote-Leave (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
