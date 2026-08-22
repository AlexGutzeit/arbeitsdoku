// API-Test: Serientermine anlegen (Materialisierung, Vorkommen, Overlap-Flag, never-Horizont, Rechte).
// Start: node tests/planning-series.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3172;
const DB = '/tmp/planning-series-test.db';

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
const entriesOf = async (t, seriesId) => ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === seriesId);
const uniq = arr => [...new Set(arr)];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/planning-series-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mkUser = (o) => req('POST','/api/users', admin, { password:'Test1234!', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o }).then(r=>r.body.user);
    const anna = await mkUser({ username:'anna', name:'Anna' });

    // 1) wöchentlich, count=4, Einzeltag (08.07.2026 = Mi)
    let r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', break_minutes:30, assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } });
    ok('weekly count=4 → 201/series', r.status === 201 && r.body.series === true && r.body.count === 4, JSON.stringify(r.body));
    const s1 = r.body.series_id;
    let ents = await entriesOf(admin, s1);
    ok('4 Einträge mit gleicher series_id', ents.length === 4);
    ok('occurrence_date = die 4 Mittwoche', JSON.stringify(uniq(ents.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-08','2026-07-15','2026-07-22','2026-07-29']));
    ok('je Vorkommen eigene group_id (4 verschiedene)', uniq(ents.map(e=>e.group_id)).length === 4);
    ok('Anna überall zugewiesen', ents.every(e => (e.assigned_users||[]).some(a=>a.user_id===anna.id)));

    // 2) monatlich am Datum, count=3
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'08:00', time_to:'16:00', assigned_user_ids:[anna.id], recurrence:{ freq:'monthly_date', end_type:'count', end_count:3 } });
    ok('monthly_date count=3 → count 3', r.body.count === 3);
    ok('monthly_date occurrence_dates', JSON.stringify((await entriesOf(admin, r.body.series_id)).map(e=>e.occurrence_date).sort()) === JSON.stringify(['2026-07-08','2026-08-08','2026-09-08']));

    // 3) mehrtägig (2 Tage) × wöchentlich count=2 → 2 Vorkommen à 2 Tage = 4 Zeilen, 1 series, 2 groups
    r = await req('POST','/api/planning', admin, { days:[{date:'2026-07-08',time_from:'07:00',time_to:'15:30',break_minutes:30},{date:'2026-07-09',time_from:'07:00',time_to:'15:30',break_minutes:30}], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('mehrtägig×weekly: count=2, days_per_occurrence=2', r.body.count === 2 && r.body.days_per_occurrence === 2);
    ents = await entriesOf(admin, r.body.series_id);
    ok('mehrtägig: 4 Zeilen, 2 group_ids', ents.length === 4 && uniq(ents.map(e=>e.group_id)).length === 2);
    ok('mehrtägig: Tage 08./09. + 15./16.', JSON.stringify(uniq(ents.map(e=>e.date)).sort()) === JSON.stringify(['2026-07-08','2026-07-09','2026-07-15','2026-07-16']));

    // 4) Overlap-Flag: Spanne 8 Tage (Offsets 0 und 8), wöchentlich (Abstand 7) → overlap true
    r = await req('POST','/api/planning', admin, { days:[{date:'2026-07-08',time_from:'07:00',time_to:'15:30'},{date:'2026-07-16',time_from:'07:00',time_to:'15:30'}], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('overlap=true bei Spanne ≥ Intervall', r.body.overlap === true, 'overlap=' + r.body.overlap);
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('overlap=false bei Einzeltag', r.body.overlap === false);

    // 5) never → viele Vorkommen (~24 Monate) + planning_series-Regel
    const todayISO = new Date().toLocaleDateString('sv-SE');
    r = await req('POST','/api/planning', admin, { date:todayISO, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'never' } });
    ok('never: > 90 Vorkommen materialisiert (24 Monate)', r.body.count > 90, 'count=' + r.body.count);

    // 6) ungültige Wiederholung → 400
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'nope', end_type:'count', end_count:3 } });
    ok('ungültige freq → 400', r.status === 400);

    // 7) Self-Planer darf nur sich selbst als Serie planen
    const self = await mkUser({ username:'selfp', name:'Self', can_plan:1, can_plan_all:0 });
    const selfTok = await tok('selfp');
    r = await req('POST','/api/planning', selfTok, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('Self-Planer: Serie für andere → 403', r.status === 403, 'status ' + r.status);
    r = await req('POST','/api/planning', selfTok, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[self.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    ok('Self-Planer: Serie für sich selbst → 201', r.status === 201, 'status ' + r.status);

    // 8) Löschen mit Umfang (occurrence / following / series)
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } });
    const sd = r.body.series_id;
    const occs = async () => uniq((await entriesOf(admin, sd)).map(e => e.occurrence_date)).sort();
    ok('Serie mit 5 Vorkommen angelegt', (await occs()).length === 5);
    await req('DELETE','/api/planning/series/' + sd, admin, { scope:'occurrence', occurrence_date:'2026-07-15' });
    ok('scope=occurrence: nur 15.07. entfernt', JSON.stringify(await occs()) === JSON.stringify(['2026-07-08','2026-07-22','2026-07-29','2026-08-05']));
    await req('DELETE','/api/planning/series/' + sd, admin, { scope:'following', occurrence_date:'2026-07-29' });
    ok('scope=following: ab 29.07. entfernt', JSON.stringify(await occs()) === JSON.stringify(['2026-07-08','2026-07-22']));
    await req('DELETE','/api/planning/series/' + sd, admin, { scope:'series' });
    ok('scope=series: alles entfernt', (await occs()).length === 0);

    // 9) „Serie beenden": Anker in der Vergangenheit → Vergangenes bleibt, Zukunft weg
    const past14 = new Date(Date.now() - 14 * 86400000).toLocaleDateString('sv-SE');
    const today2 = new Date().toLocaleDateString('sv-SE');
    r = await req('POST','/api/planning', admin, { date:past14, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'never' } });
    const sd2 = r.body.series_id;
    const before = (await entriesOf(admin, sd2)).length;
    await req('POST','/api/planning/series/' + sd2 + '/stop', admin, {});
    const remaining = await entriesOf(admin, sd2);
    ok('stop: Vergangenes bleibt, Zukunft entfernt', remaining.length > 0 && remaining.length < before && remaining.every(e => e.occurrence_date < today2), `before=${before}, remaining=${remaining.length}`);

    // 10) Rechte: Self-Planer kann fremde Serie nicht löschen
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } });
    const del = await req('DELETE','/api/planning/series/' + r.body.series_id, selfTok, { scope:'series' });
    ok('Self-Planer: fremde Serie löschen → 403', del.status === 403, 'status ' + del.status);

    // 11) Bearbeiten mit Umfang (occurrence / following / series)
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } });
    const es = r.body.series_id; // Vorkommen: 08,15,22,29
    const entriesBy = async () => (await entriesOf(admin, es)).sort((a,b) => a.occurrence_date < b.occurrence_date ? -1 : 1);
    // series: Farbe + Kunde auf alle
    await req('PUT','/api/planning/series/' + es, admin, { scope:'series', color:'#ff0000', client:'Neu GmbH' });
    ok('scope=series: alle 4 bekommen Farbe+Kunde', (await entriesBy()).every(e => e.color === '#ff0000' && e.client === 'Neu GmbH'));
    // following ab 22.07.: Beschreibung nur ab dort
    await req('PUT','/api/planning/series/' + es, admin, { scope:'following', occurrence_date:'2026-07-22', description:'ab hier' });
    let eb = await entriesBy();
    ok('scope=following: nur ab 22.07. Beschreibung', eb.filter(e=>e.description==='ab hier').map(e=>e.occurrence_date).join(',') === '2026-07-22,2026-07-29');
    // occurrence 08.07.: Adresse nur dort
    await req('PUT','/api/planning/series/' + es, admin, { scope:'occurrence', occurrence_date:'2026-07-08', address:'Nur hier 1' });
    eb = await entriesBy();
    ok('scope=occurrence: Adresse nur am 08.07.', eb.filter(e=>e.address==='Nur hier 1').map(e=>e.occurrence_date).join(',') === '2026-07-08');
    // series: Zuweisung wechseln auf self
    await req('PUT','/api/planning/series/' + es, admin, { scope:'series', assigned_user_ids:[self.id] });
    ok('scope=series: Zuweisung auf allen gewechselt', (await entriesBy()).every(e => (e.assigned_users||[]).length===1 && e.assigned_users[0].user_id===self.id));
    // Rechte: Self-Planer kann fremde Serie nicht bearbeiten
    const putForbidden = await req('PUT','/api/planning/series/' + es, selfTok, { scope:'series', color:'#000000' });
    ok('Self-Planer: fremde Serie bearbeiten → 403', putForbidden.status === 403, 'status ' + putForbidden.status);

    // 12) Nutzer-Zuordnung NUR für zukünftige Termine ändern — Vergangenes behält alte Zuordnung
    //     (Szenario: erste 3 Termine Alex+Jan+Jakob; ab dem 4. nur noch Alex+Jakob; Jan bleibt in der Vergangenheit)
    const alex = await mkUser({ username:'alex', name:'Alex' });
    const jan = await mkUser({ username:'jan', name:'Jan' });
    const jakob = await mkUser({ username:'jakob', name:'Jakob' });
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[alex.id, jan.id, jakob.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } });
    const sa = r.body.series_id; // 08,15,22,29,Aug05
    await req('PUT','/api/planning/series/' + sa, admin, { scope:'following', occurrence_date:'2026-07-29', assigned_user_ids:[alex.id, jakob.id] });
    const bySa = await entriesOf(admin, sa);
    const asgn = (d) => (bySa.find(e => e.occurrence_date === d).assigned_users || []).map(a => a.user_id).sort((x,y)=>x-y);
    const three = [alex.id, jan.id, jakob.id].sort((x,y)=>x-y);
    const two = [alex.id, jakob.id].sort((x,y)=>x-y);
    ok('erste 3 Termine behalten Alex+Jan+Jakob', JSON.stringify(asgn('2026-07-08'))===JSON.stringify(three) && JSON.stringify(asgn('2026-07-15'))===JSON.stringify(three) && JSON.stringify(asgn('2026-07-22'))===JSON.stringify(three));
    ok('ab 4. Termin (29.07.) nur noch Alex+Jakob (Jan raus)', JSON.stringify(asgn('2026-07-29'))===JSON.stringify(two) && JSON.stringify(asgn('2026-08-05'))===JSON.stringify(two));
    // Gleiches Prinzip für Beschreibung
    await req('PUT','/api/planning/series/' + sa, admin, { scope:'following', occurrence_date:'2026-07-29', description:'neuer Text' });
    const bySa2 = await entriesOf(admin, sa);
    const desc = (d) => bySa2.find(e => e.occurrence_date === d).description;
    ok('Beschreibung nur zukünftig geändert (Vergangenes leer)', desc('2026-07-08')==='' && desc('2026-07-22')==='' && desc('2026-07-29')==='neuer Text' && desc('2026-08-05')==='neuer Text');

    // 13) „Ab hier keine Wiederholung mehr" (stop after): diese Occurrence + Vergangenes bleiben, spätere weg
    r = await req('POST','/api/planning', admin, { date:'2026-07-08', time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } });
    const sh = r.body.series_id; // 08,15,22,29,Aug05
    await req('POST','/api/planning/series/' + sh + '/stop', admin, { after:'2026-07-22' });
    const occH = uniq((await entriesOf(admin, sh)).map(e => e.occurrence_date)).sort();
    ok('stop after 22.07.: 08/15/22 bleiben, spätere weg', JSON.stringify(occH) === JSON.stringify(['2026-07-08','2026-07-15','2026-07-22']));

    // 14) Tages-STRUKTUR ändern (einen Tag löschen) für „diesen + folgende" → future re-materialisiert
    //     Serie: 4 Vorkommen à 4 Tage (Fr/Mo/Di/Mi, Offsets 0/3/4/5). In Occurrence 2 den „Dienstag" (+4) löschen.
    r = await req('POST','/api/planning', admin, { days:[
      { date:'2026-07-10', time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:'2026-07-13', time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:'2026-07-14', time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:'2026-07-15', time_from:'07:00', time_to:'15:30', break_minutes:30 },
    ], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } });
    const st = r.body.series_id;
    const perOcc = async () => { const es = await entriesOf(admin, st); const m = {}; es.forEach(e => m[e.occurrence_date] = (m[e.occurrence_date] || 0) + 1); return m; };
    let m0 = await perOcc();
    ok('vor: 4 Vorkommen à 4 Tage', Object.keys(m0).length === 4 && Object.values(m0).every(n => n === 4));
    // In Occurrence 2 (17.07.) den Dienstag (21.07.) löschen → days ohne 21.07., scope=following
    await req('PUT','/api/planning/series/' + st, admin, { scope:'following', occurrence_date:'2026-07-17', assigned_user_ids:[anna.id], days:[
      { date:'2026-07-17', time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:'2026-07-20', time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:'2026-07-22', time_from:'07:00', time_to:'15:30', break_minutes:30 },
    ] });
    let m1 = await perOcc();
    ok('nach: erste Occurrence (10.07.) behält 4 Tage', m1['2026-07-10'] === 4);
    ok('nach: ab 17.07. nur noch 3 Tage (Dienstag raus)', m1['2026-07-17'] === 3 && m1['2026-07-24'] === 3 && m1['2026-07-31'] === 3);
    const esSt = await entriesOf(admin, st);
    ok('Dienstag 21./28.07. + 04.08. entfernt', !esSt.some(e => ['2026-07-21','2026-07-28','2026-08-04'].includes(e.date)));
    ok('Dienstag 14.07. (erste Occurrence) bleibt', esSt.some(e => e.date === '2026-07-14'));
    ok('Serie erhalten (alle Zeilen series_id)', esSt.every(e => e.series_id === st) && esSt.every(e => (e.assigned_users||[]).some(a=>a.user_id===anna.id)));

    // 15) Normale Planung → Serie machen (to-series)
    const conv = (await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'Conv', assigned_user_ids:[anna.id] })).body.entry;
    r = await req('POST','/api/planning/to-series', admin, { entry_id: conv.id, days:[{ date:'2026-07-10', time_from:'07:00', time_to:'15:30', break_minutes:30 }], client:'Conv', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } });
    ok('to-series: 4 Vorkommen, Serie', r.body.series === true && r.body.count === 4);
    ok('to-series: Original-Einzeleintrag weg', !((await req('GET','/api/planning', admin)).body.entries || []).some(e => e.id === conv.id));
    const convE = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.client === 'Conv' && e.series_id);
    ok('to-series: 4 Vorkommen als Serie (10/17/24/31.07.)', JSON.stringify(uniq(convE.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-10','2026-07-17','2026-07-24','2026-07-31']));

    // 16) Serie UMTAKTEN „diesen + folgende" (Split): wöchentl. → 4. Freitag monatlich ab 24.07.
    r = await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'Retakt', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } });
    const oldSid = r.body.series_id; // 10/17/24/31.07., 07.08.
    r = await req('POST','/api/planning/series/' + oldSid + '/retakt', admin, { scope:'following', occurrence_date:'2026-07-24', days:[{ date:'2026-07-24', time_from:'07:00', time_to:'15:30', break_minutes:30 }], client:'Retakt', assigned_user_ids:[anna.id], recurrence:{ freq:'monthly_weekday', end_type:'count', end_count:3 } });
    const newSid = r.body.series_id;
    ok('retakt following: neue Serie 3 Vorkommen', r.body.count === 3 && newSid && newSid !== oldSid);
    const oldE = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.series_id === oldSid);
    ok('retakt: alte Serie behält nur Vergangenes (10./17.07.)', JSON.stringify(uniq(oldE.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-10','2026-07-17']));
    const newE = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.series_id === newSid);
    ok('retakt: neue Serie = 4. Freitag monatlich (24.07./28.08./25.09.)', JSON.stringify(uniq(newE.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-24','2026-08-28','2026-09-25']));

    // 17) Serie UMTAKTEN ohne recurrence → nur beenden ab occurrence_date (Vergangenes bleibt)
    r = await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'Retakt2', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } });
    const sid2 = r.body.series_id;
    await req('POST','/api/planning/series/' + sid2 + '/retakt', admin, { scope:'following', occurrence_date:'2026-07-24' });
    const e2 = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.series_id === sid2);
    ok('retakt ohne recurrence: nur Vergangenes (10./17.07.)', JSON.stringify(uniq(e2.map(e=>e.occurrence_date)).sort()) === JSON.stringify(['2026-07-10','2026-07-17']));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series (API): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
