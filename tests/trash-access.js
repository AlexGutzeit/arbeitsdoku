// Papierkorb-Zugriff: „Chef voll, Mitarbeiter Eigenes".
// - Mitarbeiter sehen/restaurieren im Papierkorb NUR ihre eigenen Löschungen (entries + absences),
//   fremde nicht (Liste) bzw. 403 (restore). Kein Zugriff auf die Ausgestellten-Liste.
// - Chef sieht ALLE Löschungen, restauriert beliebige, sieht /inactive + reactivate.
// - Admin unverändert (sieht alles).
// Start: node tests/trash-access.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3094;
const DB = '/tmp/trash-access-test.db';

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
const has = (resp, id) => ((resp.body && (resp.body.entries || resp.body.absences)) || []).some(x => x.id === id);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/trash-access-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/trash-access-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    ok('Admin-Login', !!admin);

    const mk = (u, role) => req('POST','/api/users', admin, { username:u, password:'test', name:u.toUpperCase(), role, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const chef = (await mk('cheffe','chef')).body.user;
    const m1 = (await mk('worker1','mitarbeiter')).body.user;
    const m2 = (await mk('worker2','mitarbeiter')).body.user;
    const tmp = (await mk('templing','mitarbeiter')).body.user;
    ok('Nutzer angelegt (chef, m1, m2, tmp)', !!(chef&&m1&&m2&&tmp));

    const cTok = (await req('POST','/api/auth/login', null, { username:'cheffe', password:'test' })).body.token;
    const t1 = (await req('POST','/api/auth/login', null, { username:'worker1', password:'test' })).body.token;
    const t2 = (await req('POST','/api/auth/login', null, { username:'worker2', password:'test' })).body.token;

    // m1 legt Eintrag + Abwesenheit an und löscht beide; m2 legt Eintrag an und löscht ihn
    const e1 = (await req('POST','/api/entries', t1, { date:'2026-08-20', time_from:'07:00', time_to:'15:00', break_minutes:30 })).body.entry;
    const a1 = (await req('POST','/api/absences', t1, { type:'krank', date_from:'2026-08-21', date_to:'2026-08-21' })).body.absence;
    const e2 = (await req('POST','/api/entries', t2, { date:'2026-08-20', time_from:'08:00', time_to:'16:00', break_minutes:30 })).body.entry;
    ok('Anlegen e1/a1/e2', !!(e1&&a1&&e2) && e1.id && a1.id && e2.id, JSON.stringify({e1:e1&&e1.id,a1:a1&&a1.id,e2:e2&&e2.id}));
    await req('DELETE','/api/entries/'+e1.id, t1);
    await req('DELETE','/api/absences/'+a1.id, t1);
    await req('DELETE','/api/entries/'+e2.id, t2);

    // --- Mitarbeiter: nur Eigenes (Liste) ---
    let r = await req('GET','/api/entries/deleted', t1);
    ok('m1 sieht eigenen gelöschten Eintrag e1', has(r, e1.id), JSON.stringify((r.body.entries||[]).map(x=>x.id)));
    ok('m1 sieht NICHT m2s Eintrag e2', !has(r, e2.id));
    r = await req('GET','/api/absences/deleted/list', t1);
    ok('m1 sieht eigene gelöschte Abwesenheit a1', has(r, a1.id));

    // --- Restore-Regeln ---
    r = await req('POST','/api/entries/'+e2.id+'/restore', t1, {});
    ok('m1 restauriert fremden Eintrag e2 → 403', r.status === 403, r.status+'');
    r = await req('POST','/api/absences/'+a1.id+'/restore', t1, {});
    ok('Abwesenheit NICHT wiederherstellbar (m1) → 403', r.status === 403, r.status+'');
    r = await req('POST','/api/absences/'+a1.id+'/restore', admin, {});
    ok('Abwesenheit NICHT wiederherstellbar (auch Admin) → 403', r.status === 403, r.status+'');

    // „Neu beantragen" = frischer Antrag mit den alten Daten (läuft durch die Genehmigung)
    r = await req('POST','/api/absences', t1, { type:a1.type, date_from:a1.date_from, date_to:a1.date_to });
    ok('m1 kann Abwesenheit NEU beantragen → neuer Antrag', !!(r.body && r.body.absence) && r.status < 300, r.status+' '+JSON.stringify(r.body&&r.body.absence&&r.body.absence.id));

    // m1 hat keinen Zugriff auf Ausgestellte-Liste
    r = await req('GET','/api/users/inactive', t1);
    ok('m1 → /inactive verboten (403)', r.status === 403, r.status+'');

    // --- Chef: alles ---
    r = await req('GET','/api/entries/deleted', cTok);
    ok('Chef sieht e1 UND e2 (alle Löschungen)', has(r, e1.id) && has(r, e2.id), JSON.stringify((r.body.entries||[]).map(x=>x.id)));
    r = await req('POST','/api/entries/'+e2.id+'/restore', cTok, {});
    ok('Chef restauriert fremden Eintrag e2 → 200', r.status === 200, r.status+'');
    r = await req('POST','/api/entries/'+e1.id+'/restore', t1, {});
    ok('m1 restauriert eigenen Eintrag e1 → 200', r.status === 200, r.status+'');

    // Chef: Ausstellen → /inactive sichtbar → reactivate
    r = await req('POST','/api/users/'+tmp.id+'/deactivate', cTok, {});
    ok('Chef stellt tmp aus → 200', r.status === 200, r.status+'');
    r = await req('GET','/api/users/inactive', cTok);
    ok('Chef sieht Ausgestellten-Liste (inkl. tmp)', r.status===200 && (r.body.users||[]).some(u=>u.id===tmp.id), JSON.stringify(r.status));
    r = await req('POST','/api/users/'+tmp.id+'/reactivate', cTok, { start_date:'2026-08-25' });
    ok('Chef stellt tmp wieder ein → 200', r.status === 200, r.status+'');

    // --- Admin unverändert ---
    r = await req('GET','/api/entries/deleted', admin);
    ok('Admin sieht Papierkorb (200)', r.status === 200);
    r = await req('GET','/api/users/inactive', admin);
    ok('Admin sieht /inactive (200)', r.status === 200);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nTrash-Access: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
