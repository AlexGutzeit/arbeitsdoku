// API-Test CSV-Export der Projekt-Einträge: nach Datum sortiert, Netto (ohne Pause), Summe, Admin
// ausgeschlossen, Freitext-Name inklusive, Rechte (Manager), Header/Content-Disposition.
// Start: node tests/project-csv.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3138;
const DB = '/tmp/project-csv-test.db';

function req(method, p, token, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{
      'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}),
    }}, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ resolve({ status:res.statusCode, headers:res.headers, body: raw ? s : (()=>{ try{return JSON.parse(s)}catch(_){return s} })() }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ '+n)) : (fail++, console.log('  ✗ '+n+(e?'  → '+e:'')));
const tok = async (u, pw='test') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/project-csv-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-csv-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'BH', role:'buchhalter' });
    const m1   = await mk({ username:'m1',    name:'M Eins', role:'mitarbeiter' });
    const tc = await tok('chef2'), tb = await tok('bh'), tm = await tok('m1');
    const proj = (await req('POST','/api/projects', admin, { name:'Bau A' })).body.project;

    // Einträge unsortiert eingeben (CSV soll nach Datum sortieren)
    await req('POST','/api/entries', tc, { date:'2026-08-05', time_from:'09:00', time_to:'13:00', break_minutes:0, project_id:proj.id }); // chef 4h
    await req('POST','/api/entries', tm, { date:'2026-08-01', time_from:'07:00', time_to:'15:00', break_minutes:30, project_id:proj.id }); // 7.5
    await req('POST','/api/entries', tm, { date:'2026-08-03', time_from:'06:00', time_to:'08:00', break_minutes:0, project_text:'Bau A' }); // Freitext 2
    await req('POST','/api/entries', admin, { date:'2026-08-02', time_from:'07:00', time_to:'09:00', break_minutes:0, project_id:proj.id, user_id:1 }); // Admin → NICHT

    const r = await req('GET','/api/projects/'+proj.id+'/entries.csv', admin, null, true);
    ok('Content-Type text/csv', /text\/csv/.test(r.headers['content-type']||''), r.headers['content-type']);
    ok('Content-Disposition attachment mit Dateiname', /attachment; filename="Projekt_Bau_A_.*\.csv"/.test(r.headers['content-disposition']||''), r.headers['content-disposition']);
    const body = r.body.replace(/^﻿/, '');
    const lines = body.split('\r\n');
    ok('Titelzeile „Projekt";"Bau A"', lines[0] === '"Projekt";"Bau A"', lines[0]);
    ok('Kopfzeile Benutzer/Datum/Uhrzeit/Pause/Netto', lines[2] === '"Benutzer";"Datum";"Uhrzeit (von-bis)";"Pause (min)";"Netto (h)"', lines[2]);
    const dataLines = lines.slice(3, -1);
    ok('3 Datenzeilen (Admin ausgeschlossen)', dataLines.length === 3, JSON.stringify(dataLines));
    // Sortierung nach Datum: 01.08, 03.08, 05.08
    const dates = dataLines.map(l => l.split(';')[1].replace(/"/g,''));
    ok('nach Datum sortiert (01.08 → 03.08 → 05.08)', dates.join(',')==='01.08.2026,03.08.2026,05.08.2026', dates.join(','));
    ok('Netto ohne Pause (07:00-15:00/30min → 7,5)', /"M Eins";"01\.08\.2026";"07:00-15:00";"30";"7,5"/.test(dataLines[0]), dataLines[0]);
    ok('Freitext-Eintrag enthalten (03.08, 2h)', /"M Eins";"03\.08\.2026";"06:00-08:00";"0";"2"/.test(dataLines[1]), dataLines[1]);
    ok('Chef-Eintrag enthalten (05.08, 4h)', /"Chef Zwei";"05\.08\.2026";"09:00-13:00";"0";"4"/.test(dataLines[2]), dataLines[2]);
    ok('kein Admin-Eintrag im CSV', !/Administrator/.test(body));
    ok('Summenzeile „Gesamt" = 13,5', lines[lines.length-1] === '"Gesamt";"";"";"";"13,5"', lines[lines.length-1]);

    // Rechte
    ok('Mitarbeiter → 403', (await req('GET','/api/projects/'+proj.id+'/entries.csv', tm, null, true)).status===403);
    ok('Buchhalter → 200', (await req('GET','/api/projects/'+proj.id+'/entries.csv', tb, null, true)).status===200);
    ok('Chef → 200', (await req('GET','/api/projects/'+proj.id+'/entries.csv', tc, null, true)).status===200);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nProject-CSV (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
