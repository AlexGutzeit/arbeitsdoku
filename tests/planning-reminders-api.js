// API-Test: Planungs-Erinnerungen (pro-Vorkommen-Modell). CRUD, Rechte, Serien-Scope (nur dieser/
// dieser+folgende/alle) beim Anlegen/Ändern/Löschen inkl. „nur dieser"=Loch, remind_time, to-series.
// Start: node tests/planning-reminders-api.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 3198, DB = '/tmp/planning-reminders-api.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const nextMon = () => { const d = new Date(); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
const addCal = (isoStr, n) => { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// Vorkommen einer Serie als [{od, gid}] sortiert.
async function seriesOccs(t, sid) {
  const es = ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === sid);
  const m = {}; es.forEach(e => { m[e.occurrence_date] = e.group_id; });
  return Object.keys(m).sort().map(od => ({ od, gid: m[od] }));
}
const remOn = async (t, gid) => ((await req('GET','/api/planning/reminders?group_id=' + gid, t)).body.reminders) || [];
const leadOf = async (t, gid) => { const rs = await remOn(t, gid); return rs[0] ? rs[0].lead_num + rs[0].lead_unit : null; };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-reminders-api-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-reminders-api-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Annapw12!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const bob  = (await req('POST','/api/users', admin, { username:'bob',  password:'Bobpw123!',  name:'Bob',  role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const annaT = await tok('anna','Annapw12!');
    const MON = nextMon();

    // ===== A) Einzelplanung: anlegen / mehrere / ändern / löschen =====
    const eA = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'KundeA', assigned_user_ids:[anna.id] })).body.entry;
    ok('Einzelplanung ohne group_id', !eA.group_id);
    const a1 = await req('POST','/api/planning/reminders', annaT, { entry_id:eA.id, lead_num:1, lead_unit:'week' });
    ok('Einzel-Erinnerung angelegt (created 1)', a1.status === 201 && a1.body.created === 1);
    await req('POST','/api/planning/reminders', annaT, { entry_id:eA.id, lead_num:1, lead_unit:'day', remind_time:'18:00' });
    let la = (await req('GET','/api/planning/reminders?entry_id='+eA.id, annaT)).body.reminders;
    ok('zwei Erinnerungen gelistet', la.length === 2);
    ok('remind_time: eine 18:00, eine default null', la.filter(r=>r.remind_time==='18:00').length===1 && la.filter(r=>r.remind_time===null).length===1);
    // ändern (PUT) der Woche-Erinnerung → 2 Tage
    const weekRem = la.find(r => r.lead_unit === 'week');
    await req('PUT','/api/planning/reminders/'+weekRem.id, annaT, { lead_num:2, lead_unit:'day', scope:'occurrence' });
    la = (await req('GET','/api/planning/reminders?entry_id='+eA.id, annaT)).body.reminders;
    ok('Einzel-Erinnerung geändert (kein week mehr)', !la.some(r=>r.lead_unit==='week') && la.some(r=>r.lead_num===2&&r.lead_unit==='day'));
    // löschen einer
    await req('DELETE','/api/planning/reminders/'+la[0].id, annaT);
    ok('eine gelöscht → 1 übrig', ((await req('GET','/api/planning/reminders?entry_id='+eA.id, annaT)).body.reminders).length === 1);

    // ===== B) Rechte =====
    const eB = (await req('POST','/api/planning', admin, { date:MON, time_from:'09:00', time_to:'12:00', client:'KundeB', assigned_user_ids:[bob.id] })).body.entry;
    ok('Anna auf Bobs Termin → 403', (await req('POST','/api/planning/reminders', annaT, { entry_id:eB.id, lead_num:1, lead_unit:'day' })).status === 403);
    ok('Admin auf Bobs Termin → 201', (await req('POST','/api/planning/reminders', admin, { entry_id:eB.id, lead_num:1, lead_unit:'day' })).status === 201);

    // ===== C) Serien-Szenario (7 Vorkommen) =====
    const s = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'Serie', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:7 } })).body;
    const occ = await seriesOccs(admin, s.series_id);
    ok('7er-Serie angelegt', occ.length === 7);
    // Occ3 (Index 2): „dieser + folgende"
    const set3 = await req('POST','/api/planning/reminders', annaT, { series_id:s.series_id, occurrence_date:occ[2].od, group_id:occ[2].gid, scope:'following', lead_num:1, lead_unit:'week' });
    ok('Occ3 following: 5 Vorkommen materialisiert (occ3–7)', set3.body.created === 5);
    let mine = (await req('GET','/api/planning/reminders/mine', annaT)).body.reminders;
    let withGid = new Set(mine.map(r=>r.group_id));
    ok('Occ1+Occ2 haben KEINE Erinnerung', !withGid.has(occ[0].gid) && !withGid.has(occ[1].gid));
    ok('Occ3–Occ7 haben Erinnerung', occ.slice(2).every(o=>withGid.has(o.gid)));
    // Occ5 (Index 4): ändern „dieser + folgende" → 2 Tage
    const r5 = (await remOn(annaT, occ[4].gid))[0];
    await req('PUT','/api/planning/reminders/'+r5.id, annaT, { lead_num:2, lead_unit:'day', scope:'following' });
    ok('Occ3+Occ4 unverändert (1 week)', (await leadOf(annaT,occ[2].gid))==='1week' && (await leadOf(annaT,occ[3].gid))==='1week');
    ok('Occ5–Occ7 geändert (2 day)', (await leadOf(annaT,occ[4].gid))==='2day' && (await leadOf(annaT,occ[5].gid))==='2day' && (await leadOf(annaT,occ[6].gid))==='2day');
    // „nur dieser" = Loch: Occ4 löschen (occurrence)
    const r4 = (await remOn(annaT, occ[3].gid))[0];
    await req('DELETE','/api/planning/reminders/'+r4.id+'?scope=occurrence', annaT);
    ok('Occ4 gelöscht (Loch), Occ3 + Occ5 bleiben', (await remOn(annaT,occ[3].gid)).length===0 && (await remOn(annaT,occ[2].gid)).length===1 && (await remOn(annaT,occ[4].gid)).length===1);
    // Occ7 löschen „alle" → gesamte reminder_group weg (occ3,5,6,7)
    const r7 = (await remOn(annaT, occ[6].gid))[0];
    await req('DELETE','/api/planning/reminders/'+r7.id+'?scope=all', annaT);
    mine = (await req('GET','/api/planning/reminders/mine', annaT)).body.reminders;
    ok('Löschen „alle" auf Occ7: KEINE Serien-Erinnerung mehr (auch Occ3 weg)', !mine.some(r=>r.series_id===s.series_id));

    // ===== D) Serien-Scope „nur dieser" beim Anlegen =====
    const only = await req('POST','/api/planning/reminders', annaT, { series_id:s.series_id, occurrence_date:occ[1].od, group_id:occ[1].gid, scope:'occurrence', lead_num:3, lead_unit:'day' });
    ok('„nur dieser" legt genau 1 Zeile an', only.body.created === 1);
    ok('nur Occ2 hat sie', (await remOn(annaT,occ[1].gid)).length===1 && (await remOn(annaT,occ[0].gid)).length===0 && (await remOn(annaT,occ[2].gid)).length===0);

    // ===== E) Validierung =====
    ok('lead_num 0 → 400', (await req('POST','/api/planning/reminders', annaT, { entry_id:eA.id, lead_num:0, lead_unit:'day' })).status === 400);
    ok('lead_unit "hour" (entfernt) → 400', (await req('POST','/api/planning/reminders', annaT, { entry_id:eA.id, lead_num:1, lead_unit:'hour' })).status === 400);
    ok('ungültige Uhrzeit → 400', (await req('POST','/api/planning/reminders', annaT, { entry_id:eA.id, lead_num:1, lead_unit:'day', remind_time:'25:00' })).status === 400);
    ok('ohne Ziel → 400', (await req('POST','/api/planning/reminders', annaT, { lead_num:1, lead_unit:'day' })).status === 400);

    // ===== F) Einzel→Serie: Erinnerung wandert mit (reminder_scope=all) =====
    const single = (await req('POST','/api/planning', admin, { date:MON, time_from:'12:00', time_to:'13:00', client:'Conv', assigned_user_ids:[anna.id] })).body.entry;
    await req('POST','/api/planning/reminders', annaT, { entry_id:single.id, lead_num:1, lead_unit:'week', remind_time:'08:00' });
    const conv = await req('POST','/api/planning/to-series', admin, { date:MON, time_from:'12:00', time_to:'13:00', assigned_user_ids:[anna.id], entry_id:single.id, recurrence:{ freq:'weekly', end_type:'count', end_count:3 }, reminder_scope:'all' });
    ok('to-series erstellt Serie', conv.status === 201 && !!conv.body.series_id);
    const convOcc = await seriesOccs(admin, conv.body.series_id);
    const mineC = (await req('GET','/api/planning/reminders/mine', annaT)).body.reminders;
    ok('Erinnerung auf ALLE 3 Vorkommen übertragen (remind_time erhalten)', convOcc.every(o => mineC.some(r=>r.group_id===o.gid && r.remind_time==='08:00' && r.series_id===conv.body.series_id)));
    ok('alte Einzel-Erinnerung entfernt', !mineC.some(r=>r.entry_id===single.id));

    // ===== G) „für alle" vereinheitlicht (überschreibt vorherige „ab hier"-Abweichung) =====
    const sg = (await req('POST','/api/planning', admin, { date:MON, time_from:'06:00', time_to:'07:00', client:'Uni', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    const og = await seriesOccs(admin, sg.series_id);
    // 1) „für alle" 1 Woche
    await req('POST','/api/planning/reminders', annaT, { series_id:sg.series_id, occurrence_date:og[0].od, group_id:og[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    // 2) auf dem 4. „dieser + folgende" → 2 Tage
    const r4g = (await remOn(annaT, og[3].gid))[0];
    await req('PUT','/api/planning/reminders/'+r4g.id, annaT, { lead_num:2, lead_unit:'day', scope:'following' });
    ok('jetzt uneinheitlich (1./4. verschieden)', (await leadOf(annaT,og[0].gid))==='1week' && (await leadOf(annaT,og[3].gid))==='2day');
    // 3) auf dem 2. etwas ändern, Scope „alle"
    const r2g = (await remOn(annaT, og[1].gid))[0];
    await req('PUT','/api/planning/reminders/'+r2g.id, annaT, { lead_num:3, lead_unit:'day', scope:'all' });
    const leadsG = await Promise.all(og.map(o=>leadOf(annaT,o.gid)));
    ok('„für alle": ALLE 5 Vorkommen wieder gleich (3 Tage)', leadsG.length===5 && leadsG.every(v=>v==='3day'), JSON.stringify(leadsG));

    // ===== H) Verschieben: Erinnerung bleibt, remind_time unverändert (Feuertag folgt dem Termin) =====
    const eMv = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'Move2', assigned_user_ids:[anna.id] })).body.entry;
    await req('POST','/api/planning/reminders', annaT, { entry_id:eMv.id, lead_num:1, lead_unit:'week', remind_time:'07:00' });
    await req('PUT','/api/planning/'+eMv.id, admin, { days:[{ date:addCal(MON,14), time_from:'09:00', time_to:'15:30' }], assigned_user_ids:[anna.id], client:'Move2' });
    const afterMv = (await req('GET','/api/planning/reminders?entry_id='+eMv.id, annaT)).body.reminders;
    const entMv = ((await req('GET','/api/planning', admin)).body.entries || []).find(x=>x.id===eMv.id);
    ok('Verschieben: Erinnerung bleibt, remind_time 07:00, Termin auf +14 Tage/09:00', afterMv.length===1 && afterMv[0].remind_time==='07:00' && entMv && entMv.date===addCal(MON,14) && entMv.time_from==='09:00');

    // ===== I) Umtakten monatlich→wöchentlich überträgt dauerhafte Benachrichtigung =====
    const sm = (await req('POST','/api/planning', admin, { date:'2027-03-10', time_from:'07:00', time_to:'15:30', client:'Retakt', assigned_user_ids:[anna.id], recurrence:{ freq:'monthly_date', end_type:'count', end_count:4 } })).body;
    const mo = await seriesOccs(admin, sm.series_id);
    await req('POST','/api/planning/reminders', annaT, { series_id:sm.series_id, occurrence_date:mo[0].od, group_id:mo[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    const rk = await req('POST','/api/planning/series/'+sm.series_id+'/retakt', admin, { scope:'following', occurrence_date:mo[1].od, days:[{ date:mo[1].od, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq:'weekly', end_type:'count', end_count:6 }, assigned_user_ids:[anna.id], client:'Retakt' });
    ok('Umtakten erzeugt neue wöchentliche Serie (6)', rk.status===200 && rk.body.series_id && rk.body.count===6);
    const wk = await seriesOccs(admin, rk.body.series_id);
    const wkR = await Promise.all(wk.map(o=>remOn(annaT, o.gid)));
    ok('Umtakten: ALLE 6 neuen wöchentlichen Vorkommen haben die Erinnerung', wk.length===6 && wkR.every(a=>a.length===1), JSON.stringify(wkR.map(a=>a.length)));
    ok('Umtakten: altes 1. (monatliches) Vorkommen behält seine Erinnerung', (await remOn(annaT, mo[0].gid)).length===1);

    // ===== J) Planung löschen räumt die Erinnerung mit auf (kein Orphan) =====
    const eDel = (await req('POST','/api/planning', admin, { date:MON, time_from:'06:00', time_to:'07:00', client:'Del', assigned_user_ids:[anna.id] })).body.entry;
    await req('POST','/api/planning/reminders', annaT, { entry_id:eDel.id, lead_num:1, lead_unit:'day' });
    ok('vor Löschen: Erinnerung da', ((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.entry_id===eDel.id));
    await req('DELETE','/api/planning/'+eDel.id, admin);
    ok('Einzelplanung gelöscht → Erinnerung weg (kein Orphan)', !((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.entry_id===eDel.id));
    // Serie löschen (ganze) räumt alle Serien-Erinnerungen auf
    const sDel = (await req('POST','/api/planning', admin, { date:MON, time_from:'06:00', time_to:'07:00', client:'SDel', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:3 } })).body;
    const sdo = await seriesOccs(admin, sDel.series_id);
    await req('POST','/api/planning/reminders', annaT, { series_id:sDel.series_id, occurrence_date:sdo[0].od, group_id:sdo[0].gid, scope:'all', lead_num:1, lead_unit:'day' });
    await req('DELETE','/api/planning/series/'+sDel.series_id, admin, { scope:'series' });
    ok('ganze Serie gelöscht → alle Erinnerungen weg', !((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.series_id===sDel.series_id));

    // ===== K) Serie ab hier beenden: Vergangenes (inkl. Erinnerung) bleibt, Zukunft (inkl. Erinnerung) weg =====
    const sStop = (await req('POST','/api/planning', admin, { date:'2027-05-03', time_from:'07:00', time_to:'15:30', client:'Stop', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    const so = await seriesOccs(admin, sStop.series_id);
    await req('POST','/api/planning/reminders', annaT, { series_id:sStop.series_id, occurrence_date:so[0].od, group_id:so[0].gid, scope:'all', lead_num:1, lead_unit:'day' });
    await req('POST','/api/planning/series/'+sStop.series_id+'/stop', admin, { after: so[2].od }); // ab dem 3. beenden → 1..3 bleiben
    const soAfter = await seriesOccs(admin, sStop.series_id);
    ok('Stop ab dem 3.: Vorkommen 1–3 bleiben (Vergangenes/erste bleibt)', soAfter.length===3);
    const stopR = await Promise.all(soAfter.map(o=>remOn(annaT, o.gid)));
    ok('Stop: die bleibenden 1–3 behalten ihre Erinnerung', stopR.every(a=>a.length===1));
    ok('Stop: Erinnerungen der entfernten 4–5 sind weg (kein Orphan)', !((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.group_id===so[3].gid || r.group_id===so[4].gid));

    // ===== L) Serie auf 1 Vorkommen beenden → echte Einzelplanung (series_id gelöst, Erinnerung auf entry_id) =====
    const sSg = (await req('POST','/api/planning', admin, { date:'2027-06-07', time_from:'07:00', time_to:'15:30', client:'StopSingle', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    const sgo = await seriesOccs(admin, sSg.series_id);
    const eSg = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='StopSingle');
    const occ1Id = eSg.find(e=>e.occurrence_date===sgo[0].od).id;
    await req('POST','/api/planning/reminders', annaT, { series_id:sSg.series_id, occurrence_date:sgo[0].od, group_id:sgo[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    await req('POST','/api/planning/series/'+sSg.series_id+'/stop', admin, { after: sgo[0].od });
    const remSg = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='StopSingle');
    ok('Stop auf 1: nur 1 Termin, series_id + group_id gelöst (echte Einzelplanung)', remSg.length===1 && !remSg[0].series_id && !remSg[0].group_id && remSg[0].id===occ1Id);
    ok('Stop auf 1: Erinnerung auf entry_id umgehängt (nicht mehr Serie)', ((await req('GET','/api/planning/reminders?entry_id='+occ1Id, annaT)).body.reminders).length===1 && !((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.series_id===sSg.series_id));

    // ===== M) #11: „nur diesen behalten" (keep-single) — Rest davor UND danach weg =====
    const sKp = (await req('POST','/api/planning', admin, { date:'2027-07-05', time_from:'07:00', time_to:'15:30', client:'KeepOne', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    const kpo = await seriesOccs(admin, sKp.series_id);
    const eKp = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='KeepOne');
    const occ3Id = eKp.find(e=>e.occurrence_date===kpo[2].od).id;
    await req('POST','/api/planning/reminders', annaT, { series_id:sKp.series_id, occurrence_date:kpo[0].od, group_id:kpo[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    await req('POST','/api/planning/series/'+sKp.series_id+'/keep-single', admin, { occurrence_date: kpo[2].od });
    const remKp = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='KeepOne');
    ok('keep-single: nur der gewählte (3.) Termin bleibt, als Einzelplanung', remKp.length===1 && remKp[0].id===occ3Id && !remKp[0].series_id && !remKp[0].group_id);
    ok('keep-single: dessen Erinnerung bleibt (auf entry_id)', ((await req('GET','/api/planning/reminders?entry_id='+occ3Id, annaT)).body.reminders).length===1);
    ok('keep-single: Erinnerungen der anderen Vorkommen weg', !((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).some(r=>r.series_id===sKp.series_id || r.group_id===kpo[0].gid || r.group_id===kpo[1].gid));

    // ===== N) keep-single kaskadiert über umgetaktete Folge-Serien (Herkunft/lineage) =====
    const sLn = (await req('POST','/api/planning', admin, { date:'2027-08-02', time_from:'07:00', time_to:'15:30', client:'Lineage', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:8 } })).body;
    const wSid = sLn.series_id;
    let wkL = await seriesOccs(admin, wSid);
    await req('POST','/api/planning/reminders', annaT, { series_id:wSid, occurrence_date:wkL[0].od, group_id:wkL[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    // 5. Vorkommen → monatlich (ab hier) → separate Folge-Serie, gleiche Herkunft
    await req('POST','/api/planning/series/'+wSid+'/retakt', admin, { scope:'following', occurrence_date:wkL[4].od, days:[{ date:wkL[4].od, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq:'monthly_date', end_type:'count', end_count:8 }, assigned_user_ids:[anna.id], client:'Lineage' });
    let esL = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='Lineage');
    wkL = await seriesOccs(admin, wSid);
    const mSidL = (esL.find(e=>e.series_id && e.series_id!==wSid)||{}).series_id;
    const moL = await seriesOccs(admin, mSidL);
    ok('Kaskade-Setup: Woche 1–4 + separate Monatsserie', wkL.length===4 && moL.length>=2);
    const keep2Id = esL.find(e=>e.series_id===wSid && e.occurrence_date===wkL[1].od).id;
    // keep-single auf dem 2. (wöchentlich) → soll AUCH die monatlichen mitnehmen
    await req('POST','/api/planning/series/'+wSid+'/keep-single', admin, { occurrence_date: wkL[1].od });
    esL = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='Lineage');
    ok('Kaskade: nur der 2. bleibt (Einzelplanung), Woche 1/3/4 UND alle monatlichen weg', esL.length===1 && esL[0].id===keep2Id && !esL[0].series_id && !esL[0].group_id);
    const mineL = ((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).filter(r => r.entry_id===keep2Id || r.series_id===wSid || r.series_id===mSidL);
    ok('Kaskade: nur die Erinnerung des behaltenen Termins bleibt (auf entry_id), keine Serien-Reste', mineL.length===1 && mineL[0].entry_id===keep2Id && !mineL[0].series_id);

    // ===== O) Doppeltes Umtakten: neuer Leger ab dem 5. überholt die Fortsetzung ab dem 7. =====
    const sDb = (await req('POST','/api/planning', admin, { date:'2027-09-06', time_from:'07:00', time_to:'15:30', client:'Double', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:10 } })).body;
    const wOrig = await seriesOccs(admin, sDb.series_id); const w5 = wOrig[4].od, w7 = wOrig[6].od;
    await req('POST','/api/planning/reminders', annaT, { series_id:sDb.series_id, occurrence_date:wOrig[0].od, group_id:wOrig[0].gid, scope:'all', lead_num:1, lead_unit:'week' });
    // 1. Umtakten: ab dem 7. monatlich (M1)
    await req('POST','/api/planning/series/'+sDb.series_id+'/retakt', admin, { scope:'following', occurrence_date:w7, days:[{ date:w7, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq:'monthly_date', end_type:'count', end_count:6 }, assigned_user_ids:[anna.id], client:'Double' });
    let esD = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='Double');
    const m1 = (esD.find(e=>e.series_id && e.series_id!==sDb.series_id)||{}).series_id;
    ok('1. Umtakten: weekly 1–6 + M1 ab dem 7.', (await seriesOccs(admin, sDb.series_id)).length===6 && (await seriesOccs(admin, m1))[0].od===w7);
    // 2. Umtakten: ab dem 5. monatlich (M2) — überholt M1
    await req('POST','/api/planning/series/'+sDb.series_id+'/retakt', admin, { scope:'following', occurrence_date:w5, days:[{ date:w5, time_from:'07:00', time_to:'15:30' }], recurrence:{ freq:'monthly_date', end_type:'count', end_count:6 }, assigned_user_ids:[anna.id], client:'Double' });
    esD = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e=>e.client==='Double');
    const m2 = (esD.find(e=>e.series_id && e.series_id!==sDb.series_id)||{}).series_id;
    ok('2. Umtakten: weekly 1–4, überholte M1 (ab dem 7.) ist WEG', (await seriesOccs(admin, sDb.series_id)).length===4 && (await seriesOccs(admin, m1)).length===0);
    ok('neuer Monats-Leger = 5. Termin', (await seriesOccs(admin, m2))[0].od===w5);
    const allEntsD = ((await req('GET','/api/planning', admin)).body.entries || []);
    const allGidsD = new Set(allEntsD.filter(e=>e.group_id).map(e=>e.group_id));
    const allIdsD = new Set(allEntsD.map(e=>e.id));
    const orphanD = ((await req('GET','/api/planning/reminders/mine', annaT)).body.reminders).filter(r => (r.group_id && !allGidsD.has(r.group_id)) || (r.entry_id && !allIdsD.has(r.entry_id)));
    const m2occ = await seriesOccs(admin, m2);
    const m2R = await Promise.all(m2occ.map(o=>remOn(annaT, o.gid)));
    ok('doppeltes Umtakten: keine Waisen + M2 hat auf allen Vorkommen Erinnerung', orphanD.length===0 && m2occ.length>=2 && m2R.every(a=>a.length===1), 'orphans='+orphanD.length+' m2R='+JSON.stringify(m2R.map(a=>a.length)));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Reminders-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
