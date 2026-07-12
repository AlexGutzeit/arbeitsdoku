// API-Test: Mehrfaches Umtakten in EINER Herkunft. Ab dem 7./9. → 3 Taktungen; dann ab dem 5. → 2; dann ab
// dem 1. → 1 durchgehende; dann keep-single am 3. → Einzeltermin. Erinnerungen wandern mit, keine Waisen.
// Start: node tests/planning-retakt-lineage-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3175, DB = '/tmp/retakt-lineage.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) { return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
  const r = http.request({ host:'localhost', port:PORT, path:p, method:m, headers:{ 'Content-Type':'application/json', ...(t?{Authorization:'Bearer '+t}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
  r.on('error', rej); if (d) r.write(d); r.end(); }); }
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const remOn = async (t, gid) => ((await req('GET','/api/planning/reminders?group_id=' + gid, t)).body.reminders) || [];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/retakt-lineage-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/retakt-lineage-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'p', name:'Anna', role:'mitarbeiter', hours_mon:8 })).body.user;
    const annaT = await tok('anna', 'p');

    // Geordnete, eindeutige Vorkommen (nach Datum) über die ganze Herkunft (client Multi).
    const orderedOcc = async () => {
      const es = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.client === 'Multi' && e.occurrence_date);
      const m = {}; es.forEach(e => { m[e.occurrence_date] = { od:e.occurrence_date, gid:e.group_id, sid:e.series_id }; });
      return Object.values(m).sort((a,b) => a.od < b.od ? -1 : 1);
    };
    const cadences = (occ) => new Set(occ.map(o => o.sid)).size;
    const allHaveRem = async (occ) => (await Promise.all(occ.map(o => remOn(annaT, o.gid)))).every(a => a.length === 1);
    const orphans = async () => { const all = ((await req('GET','/api/planning', admin)).body.entries || []); const g=new Set(all.filter(e=>e.group_id).map(e=>e.group_id)); const i=new Set(all.map(e=>e.id)); return ((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).filter(r => (r.group_id && !g.has(r.group_id)) || (r.entry_id && !i.has(r.entry_id))); };
    const retakt = (sid, od, freq) => req('POST','/api/planning/series/'+sid+'/retakt', admin, { scope:'following', occurrence_date:od, days:[{ date:od, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq, end_type:'count', end_count:12 }, assigned_user_ids:[anna.id], client:'Multi' });

    // Serie mit Benachrichtigung
    const s = (await req('POST','/api/planning', admin, { date:'2027-06-07', time_from:'07:00', time_to:'15:30', client:'Multi', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:12 } })).body;
    let occ = await orderedOcc();
    await req('POST','/api/planning/reminders', annaT, { series_id:s.series_id, occurrence_date:occ[0].od, group_id:occ[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    ok('Start: 1 Taktung (12), Reminder auf allen', cadences(occ)===1 && occ.length===12 && await allHaveRem(occ));

    // Neue Taktung ab dem 7.
    await retakt(occ[6].sid, occ[6].od, 'monthly_date');
    occ = await orderedOcc();
    ok('nach Umtakten ab dem 7.: 2 Taktungen', cadences(occ)===2);

    // Neue Taktung ab dem 9.
    await retakt(occ[8].sid, occ[8].od, 'weekly');
    occ = await orderedOcc();
    ok('nach Umtakten ab dem 9.: 3 verschiedene Taktungen', cadences(occ)===3, 'cadences='+cadences(occ));
    ok('3 Taktungen: alle Vorkommen mit Benachrichtigung', await allHaveRem(occ));
    ok('3 Taktungen: keine verwaisten Benachrichtigungen', (await orphans()).length===0);

    // Änderung ab dem 5. → überholt die späteren (7./9.)
    await retakt(occ[4].sid, occ[4].od, 'monthly_date');
    occ = await orderedOcc();
    ok('nach Änderung ab dem 5.: nur noch 2 Taktungen', cadences(occ)===2, 'cadences='+cadences(occ));
    ok('2 Taktungen: alle mit Benachrichtigung, keine Waisen', await allHaveRem(occ) && (await orphans()).length===0);

    // Wieder den 1. nehmen, Taktung aktualisieren → durchgehend eine Taktung
    await retakt(occ[0].sid, occ[0].od, 'weekly');
    occ = await orderedOcc();
    ok('nach Änderung ab dem 1.: 1 durchgehende Taktung', cadences(occ)===1, 'cadences='+cadences(occ));
    ok('1 Taktung: alle mit Benachrichtigung, keine Waisen', await allHaveRem(occ) && (await orphans()).length===0);

    // Den 3. nehmen, keine Serie mehr (keep-single) → Einzeltermin
    const third = occ[2];
    await req('POST','/api/planning/series/'+third.sid+'/keep-single', admin, { occurrence_date: third.od });
    const es = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.client === 'Multi');
    ok('keep-single am 3.: nur 1 Einzeltermin (kein series_id), am Datum des 3.', es.length===1 && !es[0].series_id && !es[0].group_id && es[0].date===third.od);
    const r = (await req('GET','/api/planning/reminders?entry_id='+es[0].id, annaT)).body.reminders;
    ok('Einzeltermin behält genau eine Benachrichtigung, keine Waisen', r.length===1 && !r[0].series_id && (await orphans()).length===0);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Retakt-Lineage-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
