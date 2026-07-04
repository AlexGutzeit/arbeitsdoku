// Umfassender Rechte-/Workflow-Test (Puppeteer + API) rund um das Auftrags-Board:
//  1) Projekt erstellen  → nur Chef/Admin (Planer/MA nicht)
//  2) Projekt bearbeiten/löschen/erledigt → nur Chef/Admin
//  3) Planung erstellen → Planungsberechtigte ja, normaler MA nein
//  4) „alle"-Planer: mehrere MA, mehrere Tage, unterschiedliche Zeiträume
//  5) Verplanen ändert den Projektstatus NICHT (erst Chef/Admin „erledigt")
//  6) „sich selbst"-Planer: nicht andere, aber sich selbst mehrfach
//  7) „Als Zeitnachweis übernehmen" (MA): alle Felder + gültiger Eintrag
//  8) „In Planung übernehmen": alle Felder vorbefüllt + erzeugt gültige Planung
//  9) Planung → Zeitnachweis (accept) für MA und Self-Planer
// 10) Buchhalter darf Zeitnachweis übernehmen, aber kein Projekt anlegen
// Start: node tests/board-permissions-workflow.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3117;
const DB = '/tmp/board-perms.db';
const BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, x => { let s=''; x.on('data',d=>s+=d); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
const tok = async (u, pw='test') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const ymd = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const plusDays = n => { const d = new Date(); d.setDate(d.getDate()+n); return ymd(d); };

const login = async (p, u, pw='test') => {
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.evaluate(() => { try { localStorage.clear(); } catch(_){} });
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
};
const goto = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await sleep(1000); };
const hasFab = p => p.evaluate(() => !!document.getElementById('fab-new'));
async function openTile(p, id) { await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), id); await sleep(200); }
const tileBtns = (p, id) => p.evaluate(id => { const t=document.querySelector(`.proj-tile[data-id="${id}"]`); const q=c=>!!(t&&t.querySelector('.'+c)); return {entry:q('proj-entry'),plan:q('proj-plan'),edit:q('proj-edit'),done:q('proj-done'),del:q('proj-del')}; }, id);
const boardHas = (p, name) => p.evaluate(n => [...document.querySelectorAll('.proj-name')].some(e => e.textContent.trim()===n), name);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-perms-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-perms-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mkUser = async (o) => (await req('POST','/api/users', admin, { password:'test', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef2 = await mkUser({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh    = await mkUser({ username:'bh',    name:'Bucha Halter', role:'buchhalter' });
    const pall  = await mkUser({ username:'pall',  name:'Planer Alle',  can_plan:1, can_plan_all:1 });
    const pself = await mkUser({ username:'pself', name:'Planer Selbst', can_plan:1, can_plan_all:0 });
    const ma    = await mkUser({ username:'ma',    name:'Mitarbeiter Null', can_plan:0 });
    const ma2   = await mkUser({ username:'ma2',   name:'Mitarbeiter Zwei' });
    const ma3   = await mkUser({ username:'ma3',   name:'Mitarbeiter Drei' });
    ok('Setup: 7 Nutzer angelegt', !!(chef2&&bh&&pall&&pself&&ma&&ma2&&ma3));

    // Projekte für die Übernehmen-Tests (mit allen Feldern)
    const projFull = (await req('POST','/api/projects', admin, { name:'Projekt Voll', client:'Kunde F', address:'Adr F 1, 10115 Berlin', note:'Notiz F Beschreibung', urgency:'rot', assigned_user_ids:[ma.id, ma2.id] })).body.project;
    const projPlan = (await req('POST','/api/projects', admin, { name:'Projekt Plan', client:'Kunde P', address:'Adr P 9, 14467 Potsdam', note:'Notiz P Text', urgency:'orange', assigned_user_ids:[ma2.id, ma3.id] })).body.project;
    ok('Setup: 2 Projekte mit Feldern angelegt', !!(projFull && projPlan));

    const tPall = await tok('pall'), tPself = await tok('pself'), tMa = await tok('ma'), tBh = await tok('bh'), tChef2 = await tok('chef2');

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1366, height:900 });

    // ===== 1) Projekt erstellen — nur Chef/Admin =====
    console.log('\n[1] Projekt erstellen — nur Chef/Admin');
    ok('Chef POST Projekt → 201', (await req('POST','/api/projects', tChef2, { name:'Von Chef' })).status===201);
    ok('alle-Planer POST Projekt → 403', (await req('POST','/api/projects', tPall, { name:'X1' })).status===403);
    ok('self-Planer POST Projekt → 403', (await req('POST','/api/projects', tPself, { name:'X2' })).status===403);
    ok('normaler MA POST Projekt → 403', (await req('POST','/api/projects', tMa, { name:'X3' })).status===403);
    ok('Buchhalter POST Projekt → 403', (await req('POST','/api/projects', tBh, { name:'X4' })).status===403);
    await login(p, 'admin', apw); await goto(p, '#/projects');
    ok('Admin: FAB (Projekt anlegen) vorhanden', await hasFab(p));
    await login(p, 'pall'); await goto(p, '#/projects');
    ok('alle-Planer: KEIN FAB', !(await hasFab(p)));
    await login(p, 'ma'); await goto(p, '#/projects');
    ok('normaler MA: KEIN FAB', !(await hasFab(p)));

    // ===== 2) Projekt bearbeiten/löschen/erledigt — nur Chef/Admin =====
    console.log('\n[2] Bearbeiten/Löschen/Erledigt — nur Chef/Admin');
    ok('alle-Planer PUT Projekt → 403', (await req('PUT','/api/projects/'+projFull.id, tPall, { name:'Hack' })).status===403);
    ok('alle-Planer DELETE Projekt → 403', (await req('DELETE','/api/projects/'+projFull.id, tPall)).status===403);
    ok('alle-Planer done → 403', (await req('POST','/api/projects/'+projFull.id+'/done', tPall)).status===403);
    ok('MA PUT Projekt → 403', (await req('PUT','/api/projects/'+projFull.id, tMa, { name:'Hack' })).status===403);
    ok('MA DELETE Projekt → 403', (await req('DELETE','/api/projects/'+projFull.id, tMa)).status===403);
    ok('Chef PUT Projekt → 200 (Kontrolle)', (await req('PUT','/api/projects/'+projFull.id, tChef2, { name:'Projekt Voll', urgency:'rot' })).status===200);
    // UI: Buttons je Rolle
    await login(p, 'pall'); await goto(p, '#/projects'); const bPall = await tileBtns(p, projFull.id);
    ok('alle-Planer Kachel: In Planung + Zeitnachweis, KEIN Edit/Erledigt/Löschen', bPall.plan && bPall.entry && !bPall.edit && !bPall.done && !bPall.del, JSON.stringify(bPall));
    await login(p, 'ma'); await goto(p, '#/projects'); const bMa = await tileBtns(p, projFull.id);
    ok('MA Kachel: nur Zeitnachweis (kein Planung/Edit/Erledigt/Löschen)', bMa.entry && !bMa.plan && !bMa.edit && !bMa.done && !bMa.del, JSON.stringify(bMa));

    // ===== 3) Planung erstellen — Planer ja, MA nein =====
    console.log('\n[3] Planung erstellen — Planer ja, MA nein');
    const d0 = plusDays(3);
    ok('alle-Planer POST Planung → 201', (await req('POST','/api/planning', tPall, { date:d0, time_from:'07:00', time_to:'16:00', break_minutes:30, assigned_user_ids:[ma2.id] })).status===201);
    ok('self-Planer POST Planung (sich) → 201', (await req('POST','/api/planning', tPself, { date:d0, time_from:'07:00', time_to:'16:00', assigned_user_ids:[pself.id] })).status===201);
    ok('normaler MA POST Planung → 403', (await req('POST','/api/planning', tMa, { date:d0, time_from:'07:00', time_to:'16:00', assigned_user_ids:[ma.id] })).status===403);
    await login(p, 'pall'); await goto(p, '#/planning'); ok('alle-Planer: Planung-FAB vorhanden', await hasFab(p));
    await login(p, 'pself'); await goto(p, '#/planning'); ok('self-Planer: Planung-FAB vorhanden', await hasFab(p));
    await login(p, 'ma'); await goto(p, '#/planning'); ok('normaler MA: KEIN Planung-FAB', !(await hasFab(p)));

    // ===== 4) alle-Planer: mehrere MA, mehrere Tage, unterschiedliche Zeiträume =====
    console.log('\n[4] alle-Planer: mehrere MA / Tage / Zeiten');
    const d1=plusDays(5), d2=plusDays(6), d3=plusDays(7);
    const r4a = await req('POST','/api/planning', tPall, { date:d1, time_from:'07:00', time_to:'16:00', break_minutes:30, assigned_user_ids:[ma2.id, ma3.id] });
    ok('mehrere MA an einem Tag → 201 mit 2 Zuweisungen', r4a.status===201 && (r4a.body.entry.assigned_users||[]).length===2, JSON.stringify(r4a.body.entry&&r4a.body.entry.assigned_users));
    const r4b = await req('POST','/api/planning', tPall, { days:[{date:d2,time_from:'07:00',time_to:'12:00',break_minutes:0},{date:d3,time_from:'08:00',time_to:'17:00',break_minutes:30}], assigned_user_ids:[ma2.id] });
    ok('ein MA an mehreren Tagen mit unterschiedlichen Zeiten → 201, 2 Einträge', r4b.status===201 && r4b.body.count===2, JSON.stringify(r4b.body));
    const allPlan = (await req('GET','/api/planning?date_from='+d1+'&date_to='+d3, admin)).body.entries;
    const ma2Days = allPlan.filter(e => (e.assigned_users||[]).some(u=>u.user_id===ma2.id)).map(e=>e.date);
    ok('ma2 an Tag d1, d2, d3 verplant', ma2Days.includes(d1)&&ma2Days.includes(d2)&&ma2Days.includes(d3), JSON.stringify(ma2Days));
    const d2Entry = allPlan.find(e => e.date===d2 && (e.assigned_users||[]).some(u=>u.user_id===ma2.id));
    ok('unterschiedliche Zeiträume gespeichert (d2 = 07:00–12:00)', d2Entry && d2Entry.time_from==='07:00' && d2Entry.time_to==='12:00', d2Entry && (d2Entry.time_from+'–'+d2Entry.time_to));
    await login(p, 'pall'); await goto(p, '#/planning/new');
    ok('alle-Planer Planungsform: Mitarbeiter-Auswahl (Mehrfach) vorhanden', await p.evaluate(()=>!!document.querySelector('.planning-user-checkboxes') && !document.querySelector('.planning-self-target')));

    // ===== 5) Verplanen ändert Projektstatus NICHT =====
    console.log('\n[5] Verplanen ändert Projektstatus nicht');
    await req('POST','/api/planning', tPall, { date:d1, time_from:'07:00', time_to:'16:00', assigned_user_ids:[ma2.id], project_id:projPlan.id, client:projPlan.client, address:projPlan.address, description:projPlan.note });
    const stillOpen = (await req('GET','/api/projects', admin)).body.projects.some(x=>x.id===projPlan.id && !x.done);
    ok('Projekt trotz Verplanung weiterhin offen (done=0)', stillOpen);

    // ===== 6) self-Planer: nicht andere, aber sich selbst mehrfach =====
    console.log('\n[6] self-Planer: nur sich, mehrfach');
    ok('self-Planer plant mehrere andere MA → 403', (await req('POST','/api/planning', tPself, { date:d1, time_from:'07:00', time_to:'16:00', assigned_user_ids:[ma2.id, ma3.id] })).status===403);
    ok('self-Planer plant EINEN anderen MA → 403', (await req('POST','/api/planning', tPself, { date:d1, time_from:'07:00', time_to:'16:00', assigned_user_ids:[ma2.id] })).status===403);
    const selfP1 = await req('POST','/api/planning', tPself, { date:plusDays(8), time_from:'07:00', time_to:'15:00', assigned_user_ids:[pself.id], project_id:projFull.id, client:projFull.client, address:projFull.address, description:projFull.note });
    const selfP2 = await req('POST','/api/planning', tPself, { date:plusDays(9), time_from:'08:00', time_to:'16:00', assigned_user_ids:[pself.id] });
    ok('self-Planer plant sich selbst mehrfach → 201/201', selfP1.status===201 && selfP2.status===201);
    await login(p, 'pself'); await goto(p, '#/planning/new');
    ok('self-Planer Planungsform: self-only (keine Mitarbeiter-Auswahl)', await p.evaluate(()=>!document.querySelector('.planning-user-checkboxes') && !!document.querySelector('.planning-self-target')));

    // ===== 7) „Als Zeitnachweis übernehmen" (MA): alle Felder + gültig =====
    console.log('\n[7] Zeitnachweis aus Projekt (MA) — Felder + gültig');
    await login(p, 'ma'); await goto(p, '#/projects');
    await openTile(p, projFull.id);
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-entry`).click(), projFull.id); await sleep(900);
    const pf7 = await p.evaluate(()=>({ c:(document.getElementById('ef-client')||{}).value, a:(document.getElementById('ef-address')||{}).value, d:(document.getElementById('ef-desc')||{}).value, pid:(document.getElementById('ef-project')||{}).value }));
    ok('Zeitnachweis-Formular: Kunde/Adresse/Notiz/Projekt vorbefüllt', pf7.c==='Kunde F' && pf7.a==='Adr F 1, 10115 Berlin' && pf7.d==='Notiz F Beschreibung' && String(pf7.pid)===String(projFull.id), JSON.stringify(pf7));
    await p.evaluate(()=>{ document.getElementById('ef-from').value='07:00'; document.getElementById('ef-to').value='15:00'; document.getElementById('ef-break').value='30'; });
    await p.evaluate(()=>document.getElementById('entry-form').requestSubmit()); await sleep(1200);
    const maEntries = (await req('GET','/api/entries', tMa)).body.entries || [];
    const e7 = maEntries.find(e => e.project_id===projFull.id);
    ok('gültiger Zeitnachweis erstellt (net_hours>0, für MA, mit Projektfeldern)', !!e7 && e7.user_id===ma.id && e7.net_hours>0 && e7.client==='Kunde F' && e7.address==='Adr F 1, 10115 Berlin' && e7.description==='Notiz F Beschreibung', JSON.stringify(e7&&{u:e7.user_id,nh:e7.net_hours,c:e7.client,a:e7.address,d:e7.description}));

    // ===== 8) „In Planung übernehmen": Prefill + gültige Planung =====
    console.log('\n[8] In Planung übernehmen — Prefill + Persistenz');
    await login(p, 'pall'); await goto(p, '#/projects');
    await openTile(p, projPlan.id);
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-plan`).click(), projPlan.id); await sleep(1000);
    await p.evaluate((a,b)=>{ window.__ma2=a; window.__ma3=b; }, ma2.id, ma3.id);
    const pf8 = await p.evaluate(()=>({
      c:(document.getElementById('pf-client')||{}).value, a:(document.getElementById('pf-address')||{}).value,
      d:(document.getElementById('pf-desc')||{}).value, pid:(document.getElementById('pf-project')||{}).value,
      ma2:!!document.querySelector('input[name="assigned"][value="'+window.__ma2+'"]:checked'),
      ma3:!!document.querySelector('input[name="assigned"][value="'+window.__ma3+'"]:checked'),
    }));
    ok('Planungsform vorbefüllt: Kunde/Adresse/Projekt/Notiz', pf8.c==='Kunde P' && pf8.a==='Adr P 9, 14467 Potsdam' && pf8.d==='Notiz P Text' && String(pf8.pid)===String(projPlan.id), JSON.stringify(pf8));
    ok('Planungsform: zugedachte MA (ma2+ma3) vorgehakt', pf8.ma2 && pf8.ma3, JSON.stringify(pf8));
    const beforeCnt = (await req('GET','/api/planning?project_id='+projPlan.id, admin)).body.entries.length;
    await p.evaluate(()=>document.getElementById('planning-form').requestSubmit()); await sleep(1200);
    const planEntries = (await req('GET','/api/planning?project_id='+projPlan.id, admin)).body.entries;
    const p8 = planEntries.find(e => e.created_by===pall.id && (e.assigned_users||[]).length===2);
    ok('gültige Planung erzeugt (neuer Eintrag)', planEntries.length>beforeCnt && !!p8, JSON.stringify({cnt:planEntries.length, before:beforeCnt}));
    ok('erzeugte Planung: alle Projektfelder + ma2/ma3 zugewiesen', !!p8 && p8.client==='Kunde P' && p8.address==='Adr P 9, 14467 Potsdam' && p8.description==='Notiz P Text' && p8.project_id===projPlan.id && p8.assigned_users.every(u=>[ma2.id,ma3.id].includes(u.user_id)), JSON.stringify(p8&&{c:p8.client,a:p8.address,d:p8.description,au:p8.assigned_users}));

    // ===== 9) Planung → Zeitnachweis (accept) für MA =====
    console.log('\n[9] Planung → Zeitnachweis (accept)');
    const planForMa = (await req('POST','/api/planning', tPall, { date:plusDays(4), time_from:'07:00', time_to:'16:00', break_minutes:30, assigned_user_ids:[ma.id], project_id:projFull.id, client:projFull.client, address:projFull.address, description:projFull.note })).body.entry;
    await login(p, 'ma'); await goto(p, '#/planning/accept/'+planForMa.id);
    const pf9 = await p.evaluate(()=>({ c:(document.getElementById('ef-client')||{}).value, a:(document.getElementById('ef-address')||{}).value, pid:(document.getElementById('ef-project')||{}).value }));
    ok('accept: Zeitnachweis-Formular aus Planung vorbefüllt', pf9.c==='Kunde F' && pf9.a==='Adr F 1, 10115 Berlin' && String(pf9.pid)===String(projFull.id), JSON.stringify(pf9));
    await p.evaluate(()=>{ document.getElementById('ef-from').value='07:00'; document.getElementById('ef-to').value='16:00'; document.getElementById('ef-break').value='30'; });
    await p.evaluate(()=>document.getElementById('entry-form').requestSubmit()); await sleep(1200);
    const maEntries2 = (await req('GET','/api/entries', tMa)).body.entries || [];
    // accept-Eintrag bekommt heutiges Datum (nicht das Planungsdatum) → über time_to=16:00 von [7] (15:00) unterscheiden
    const e9 = maEntries2.filter(e => e.project_id===projFull.id && e.time_to==='16:00');
    ok('gültiger Zeitnachweis aus Planung erstellt (net_hours>0, Projektfelder)', e9.length===1 && e9[0].net_hours>0 && e9[0].user_id===ma.id && e9[0].client==='Kunde F', JSON.stringify(e9[0]&&{nh:e9[0].net_hours,u:e9[0].user_id,c:e9[0].client}));

    // ===== 10) Self-Planer: eigene Planung → Zeitnachweis; Buchhalter Übernehmen/kein Projekt =====
    console.log('\n[10] Self-Planer accept + Buchhalter');
    await login(p, 'pself'); await goto(p, '#/planning/accept/'+selfP1.body.entry.id);
    await p.evaluate(()=>{ document.getElementById('ef-from').value='07:00'; document.getElementById('ef-to').value='15:00'; document.getElementById('ef-break').value='30'; });
    await p.evaluate(()=>document.getElementById('entry-form').requestSubmit()); await sleep(1200);
    const pselfEntries = (await req('GET','/api/entries', tPself)).body.entries || [];
    ok('Self-Planer: gültiger Zeitnachweis aus eigener Planung', pselfEntries.some(e => e.user_id===pself.id && e.net_hours>0), JSON.stringify(pselfEntries.map(e=>e.net_hours)));
    await login(p, 'bh'); await goto(p, '#/projects');
    ok('Buchhalter: KEIN FAB (kein Projekt anlegen)', !(await hasFab(p)));
    await openTile(p, projFull.id); const bBh = await tileBtns(p, projFull.id);
    ok('Buchhalter Kachel: „Als Zeitnachweis übernehmen" vorhanden, kein Planung/Edit', bBh.entry && !bBh.plan && !bBh.edit && !bBh.done && !bBh.del, JSON.stringify(bBh));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Permissions-Workflow: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
