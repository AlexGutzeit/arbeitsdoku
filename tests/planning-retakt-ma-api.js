// API-Test: Mehrfaches Umtakten MIT wechselnder MA-Zuweisung je Serie + eine Einzel-MA-Ausnahme.
// Taktungen 1->2->3->(Einzel-MA-Ausnahme)->2->1->keep-single. Reminder wandern mit, keine Waisen,
// MA-Zuweisung stimmt je Segment. Start: node tests/planning-retakt-ma-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3171, DB = '/tmp/retakt-ma.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(m, p, t, b) { return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
  const r = http.request({ host:'localhost', port:PORT, path:p, method:m, headers:{ 'Content-Type':'application/json', ...(t?{Authorization:'Bearer '+t}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
  r.on('error', rej); if (d) r.write(d); r.end(); }); }
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/retakt-ma-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/retakt-ma-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const annaT = await tok('admin', apw); // Reminder als admin (canPlanAll)
    const ma = []; for (let i=1;i<=6;i++) ma.push((await req('POST','/api/users', admin, { username:'m'+i, password:'p', name:'M'+i, role:'mitarbeiter', hours_mon:8 })).body.user.id);

    // Geordnete, eindeutige Vorkommen (nach Datum) über die Herkunft (client MA): {od, sid, gid, ma, rem}
    const occInfo = async () => {
      const es = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.client === 'MA' && e.occurrence_date);
      const seen = {}; const out = [];
      for (const e of es.sort((a,b)=>a.occurrence_date<b.occurrence_date?-1:1)) {
        if (seen[e.occurrence_date]) continue; seen[e.occurrence_date] = 1;
        const rem = ((await req('GET','/api/planning/reminders?group_id='+e.group_id, annaT)).body.reminders || []).length;
        out.push({ od:e.occurrence_date, sid:e.series_id, gid:e.group_id, ma:(e.assigned_users||[]).length, rem });
      }
      return out;
    };
    const cadences = (occ) => new Set(occ.map(o => o.sid)).size;
    const orphans = async () => { const all=((await req('GET','/api/planning',admin)).body.entries||[]); const g=new Set(all.filter(e=>e.group_id).map(e=>e.group_id)); const i=new Set(all.map(e=>e.id)); return ((await req('GET','/api/planning/reminders/mine',annaT)).body.reminders).filter(r=>(r.group_id&&!g.has(r.group_id))||(r.entry_id&&!i.has(r.entry_id))); };
    const retakt = (sid, od, freq, maList) => req('POST','/api/planning/series/'+sid+'/retakt', admin, { scope:'following', occurrence_date:od, days:[{ date:od, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq, end_type:'count', end_count:12 }, assigned_user_ids:maList, client:'MA' });
    const okStep = async (label, expCad) => { const occ = await occInfo(); ok(label+': '+expCad+' Taktung(en), alle mit Benachrichtigung, keine Waisen', cadences(occ)===expCad && occ.every(o=>o.rem===1) && (await orphans()).length===0, 'cad='+cadences(occ)+' rem='+occ.map(o=>o.rem).join('')); return occ; };

    // Serie (weekly 12) mit 4 MA + Benachrichtigung "für alle"
    const s = (await req('POST','/api/planning', admin, { date:'2027-06-07', time_from:'07:00', time_to:'15:30', client:'MA', assigned_user_ids:ma.slice(0,4), recurrence:{ freq:'weekly', end_type:'count', end_count:12 } })).body;
    let occ = await occInfo();
    await req('POST','/api/planning/reminders', annaT, { series_id:s.series_id, occurrence_date:occ[0].od, group_id:occ[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    occ = await occInfo();
    ok('Start: 1 Taktung, 4 MA überall, alle mit Benachrichtigung', cadences(occ)===1 && occ.every(o=>o.ma===4 && o.rem===1));

    // Umtakten ab dem 7. → monatlich, 3 MA
    await retakt(occ[6].sid, occ[6].od, 'monthly_date', ma.slice(0,3));
    occ = await okStep('nach Umtakten ab dem 7. (3 MA)', 2);
    ok('7er-Segment hat 3 MA, davor weiter 4 MA', occ.slice(0,6).every(o=>o.ma===4) && occ.slice(6).every(o=>o.ma===3));

    // Umtakten ab dem 9. → wöchentlich, 2 MA
    await retakt(occ[8].sid, occ[8].od, 'weekly', ma.slice(0,2));
    occ = await okStep('nach Umtakten ab dem 9. (2 MA)', 3);
    ok('MA je Segment: 1–6=4, 7–8=3, 9+=2', occ.slice(0,6).every(o=>o.ma===4) && occ[6].ma===3 && occ[7].ma===3 && occ.slice(8).every(o=>o.ma===2));

    // Zwischenschritt: EINEN Termin (den 8.) auf 6 MA — nur dieser. Über PUT /group wie das Formular
    // („nur diesen Termin"): eintägiges Serien-Vorkommen MUSS group_id + Erinnerung behalten.
    await req('PUT','/api/planning/group/'+occ[7].gid, admin, { days:[{ date:occ[7].od, time_from:'07:00', time_to:'15:30' }], assigned_user_ids:ma.slice(0,6), client:'MA' });
    occ = await occInfo();
    ok('Einzel-MA-Ausnahme: nur der 8. hat 6 MA (7.=3, 9.=2 unverändert)', occ[7].ma===6 && occ[6].ma===3 && occ[8].ma===2);
    ok('Einzel-MA-Ausnahme: der 8. behält group_id + Erinnerung (nicht verwaist)', !!occ[7].gid && occ[7].rem===1);
    ok('Einzel-MA-Ausnahme: Taktungen/Reminder/Waisen unverändert', cadences(occ)===3 && occ.every(o=>o.rem===1) && (await orphans()).length===0);

    // Änderung ab dem 5. → monatlich, 5 MA (überholt 7./9. inkl. Ausnahme)
    await retakt(occ[4].sid, occ[4].od, 'monthly_date', ma.slice(0,5));
    occ = await okStep('nach Änderung ab dem 5. (5 MA)', 2);
    ok('MA: 1–4=4, ab 5=5 (Ausnahme des 8. ist weg)', occ.slice(0,4).every(o=>o.ma===4) && occ.slice(4).every(o=>o.ma===5));

    // Wieder ab dem 1. → wöchentlich, 1 MA → durchgehend
    await retakt(occ[0].sid, occ[0].od, 'weekly', ma.slice(0,1));
    occ = await okStep('nach Änderung ab dem 1. (1 MA)', 1);
    ok('durchgehend 1 MA', occ.every(o=>o.ma===1));

    // 3. → keine Serie (keep-single)
    const third = occ[2];
    await req('POST','/api/planning/series/'+third.sid+'/keep-single', admin, { occurrence_date: third.od });
    const es = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.client === 'MA');
    ok('keep-single am 3.: 1 Einzeltermin (1 MA), am Datum des 3., keine Serie', es.length===1 && !es[0].series_id && es[0].date===third.od && (es[0].assigned_users||[]).length===1);
    const r = (await req('GET','/api/planning/reminders?entry_id='+es[0].id, annaT)).body.reminders;
    ok('Einzeltermin: genau eine Benachrichtigung, keine Waisen', r.length===1 && (await orphans()).length===0);

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Retakt-MA-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
