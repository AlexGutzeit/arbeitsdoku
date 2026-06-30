// Komplexer Szenario-Test gegen den PROD-KLON (data/local.db, anonymisiert → Passwort 'test').
// Akteure: Daniel (chef, „alle"), Alex/„alex" (Self-Planer, can_plan), Jakob (kein Planungsrecht).
//
// Teil A — Zustandsmaschine (über die echten HTTP-Endpunkte, die auch die UI ruft), Assertion nach
//   jedem Schritt:
//     1) Daniel erstellt V1 mit Alex+Jakob                → 1 Eintrag [Alex,Jakob]
//     2) Alex ändert seine Zeiten                          → split: V1 [Jakob] + V2 [Alex]
//     3) Daniel hakt Alex bei V1 wieder an                 → V1 [Alex,Jakob] + V2 [Alex] (Alex 2, Jakob 1)
//     4) Daniel löscht V1, hakt Jakob bei V2 mit an        → nur V2 [Alex,Jakob]
//     5) Alex löscht sich aus V2                           → V2 [Jakob]
//     6) Daniel hakt Alex wieder in V2                     → V2 [Alex,Jakob]
//     7) Daniel löscht V2                                  → keine Planung
//
// Teil B — Puppeteer (als Alex): Screenshots Tag/Woche/Monat, ⋮-Menü NUR in Alex' Spalte, Planungs-
//   formular ohne Mitarbeiter-Auswahl; Alex' Split UND Ausklinken werden ECHT durch die UI ausgelöst.
//
// Start: node tests/scenario-shared-planning.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3092;
const SRC_DB = path.join(__dirname, '..', 'data', 'local.db');
const DB = '/tmp/scenario-shared.db';
const BASE = 'http://localhost:' + PORT;
const SHOTS = '/tmp/planning-shots';
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

// Scenario-Tag: 2 Wochen voraus auf Montag (sicher in der Zukunft, leer)
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const _b = new Date(); _b.setDate(_b.getDate()+14); _b.setDate(_b.getDate()-((_b.getDay()+6)%7));
const SC = ymd(_b);

let AX, JK; // user-ids

(async () => {
  fs.copyFileSync(SRC_DB, DB);
  fs.mkdirSync(SHOTS, { recursive: true });
  const lg = fs.openSync('/tmp/scenario-shared-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:'test' })).body.token;
    ok('Admin-Login (Klon, pw=test)', !!admin);
    const users = (await req('GET','/api/users', admin)).body.users;
    const find = n => users.find(u => u.username === n || u.name === n);
    const daniel = find('Daniel'), alex = find('alex'), jakob = find('Jakob');
    ok('Akteure im Klon gefunden (Daniel/alex/Jakob)', !!(daniel && alex && jakob), JSON.stringify({d:daniel&&daniel.id,a:alex&&alex.id,j:jakob&&jakob.id}));
    AX = alex.id; JK = jakob.id;
    ok('Daniel ist chef', daniel.role === 'chef', daniel.role);

    // Rechte setzen: Alex = Self-Planer (sich), Jakob = kein Planungsrecht
    await req('PUT','/api/users/'+alex.id, admin, { username:alex.username, name:alex.name, role:'mitarbeiter', can_plan:1, can_plan_all:0 });
    await req('PUT','/api/users/'+jakob.id, admin, { username:jakob.username, name:jakob.name, role:'mitarbeiter', can_plan:0, can_plan_all:0 });
    const alexAfter = (await req('GET','/api/users/'+alex.id, admin)).body.user;
    ok('Alex: Self-Planer (can_plan=1, can_plan_all=0)', alexAfter.can_plan===1 && alexAfter.can_plan_all===0, JSON.stringify(alexAfter));

    const dTok = (await req('POST','/api/auth/login', null, { username:'Daniel', password:'test' })).body.token;
    const aTok = (await req('POST','/api/auth/login', null, { username:'alex', password:'test' })).body.token;
    ok('Daniel- & Alex-Login', !!dTok && !!aTok);

    // Scenario-Tag säubern (evtl. Altbestand entfernen)
    for (const e of ((await req('GET',`/api/planning?date_from=${SC}&date_to=${SC}`, admin)).body.entries||[])) {
      await req('DELETE','/api/planning/'+e.id, admin);
    }

    // Zustand am Scenario-Tag als [{from, ids[]}] sortiert
    const state = async () => ((await req('GET',`/api/planning?date_from=${SC}&date_to=${SC}`, admin)).body.entries||[])
      .map(e => ({ id:e.id, from:e.time_from, ids:e.assigned_users.map(a=>a.user_id).sort((x,y)=>x-y) }))
      .sort((a,b)=> a.from<b.from?-1:(a.from>b.from?1:0));
    const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);
    const idsOf = s => s.map(e=>e.ids);

    console.log('\n--- Teil A: Zustandsmaschine (API, Scenario-Tag '+SC+') ---');

    // 1) Daniel erstellt V1 mit Alex+Jakob
    let r = await req('POST','/api/planning', dTok, { date:SC, time_from:'07:00', time_to:'16:00', break_minutes:30, address:'Baustelle V1', client:'Kunde', assigned_user_ids:[AX,JK] });
    ok('1) Daniel erstellt V1 [Alex,Jakob] → 201', r.status===201);
    let s = await state();
    ok('   → 1 Eintrag mit Alex+Jakob', s.length===1 && eq(s[0].ids,[AX,JK].sort((x,y)=>x-y)), JSON.stringify(idsOf(s)));
    const v1 = s[0].id;

    // 2) Alex ändert seine Zeiten → split
    r = await req('PUT','/api/planning/'+v1, aTok, { date:SC, time_from:'08:00', time_to:'14:00', break_minutes:0, assigned_user_ids:[AX] });
    ok('2) Alex ändert Zeiten → split', r.status===200 && r.body && r.body.split===true, JSON.stringify(r.body));
    s = await state();
    ok('   → 2 Einträge: Jakob 07:00 + Alex 08:00', s.length===2 && eq(s[0].ids,[JK]) && s[0].from==='07:00' && eq(s[1].ids,[AX]) && s[1].from==='08:00', JSON.stringify(s.map(e=>({f:e.from,i:e.ids}))));
    const v1jakob = s.find(e=>eq(e.ids,[JK])).id;
    let v2alex = s.find(e=>eq(e.ids,[AX])).id;

    // 3) Daniel hakt Alex bei V1 wieder an
    r = await req('PUT','/api/planning/'+v1jakob, dTok, { date:SC, time_from:'07:00', time_to:'16:00', break_minutes:30, assigned_user_ids:[AX,JK] });
    ok('3) Daniel hakt Alex bei V1 wieder an → 200', r.status===200);
    s = await state();
    const alexCount = s.filter(e=>e.ids.includes(AX)).length, jakobCount = s.filter(e=>e.ids.includes(JK)).length;
    ok('   → Alex in 2 Planungen, Jakob in 1', alexCount===2 && jakobCount===1, JSON.stringify(s.map(e=>({f:e.from,i:e.ids}))));

    // 4) Daniel löscht V1, hakt Jakob bei V2 mit an
    r = await req('DELETE','/api/planning/'+v1jakob, dTok);
    ok('4a) Daniel löscht V1 → 200', r.status===200);
    r = await req('PUT','/api/planning/'+v2alex, dTok, { date:SC, time_from:'08:00', time_to:'14:00', break_minutes:0, assigned_user_ids:[AX,JK] });
    ok('4b) Daniel hakt Jakob bei V2 mit an → 200', r.status===200);
    s = await state();
    ok('   → nur noch V2 mit Alex+Jakob', s.length===1 && eq(s[0].ids,[AX,JK].sort((x,y)=>x-y)), JSON.stringify(s.map(e=>({f:e.from,i:e.ids}))));
    v2alex = s[0].id;

    // 5) Alex löscht sich aus V2 → unclinch
    r = await req('DELETE','/api/planning/'+v2alex, aTok);
    ok('5) Alex löscht sich aus V2 → unclinch', r.status===200 && r.body && r.body.unclinch===true, JSON.stringify(r.body));
    s = await state();
    ok('   → nur noch Jakob in V2', s.length===1 && eq(s[0].ids,[JK]), JSON.stringify(s.map(e=>({f:e.from,i:e.ids}))));

    // 6) Daniel hakt Alex wieder in V2
    r = await req('PUT','/api/planning/'+v2alex, dTok, { date:SC, time_from:'08:00', time_to:'14:00', break_minutes:0, assigned_user_ids:[AX,JK] });
    ok('6) Daniel hakt Alex wieder in V2 → 200', r.status===200);
    s = await state();
    ok('   → V2 wieder Alex+Jakob', s.length===1 && eq(s[0].ids,[AX,JK].sort((x,y)=>x-y)), JSON.stringify(s.map(e=>({f:e.from,i:e.ids}))));

    // 7) Daniel löscht V2
    r = await req('DELETE','/api/planning/'+v2alex, dTok);
    ok('7) Daniel löscht V2 → 200', r.status===200);
    s = await state();
    ok('   → keine Planung mehr vorhanden', s.length===0, JSON.stringify(s));

    // ===================== Teil B: Puppeteer (als Alex) =====================
    console.log('\n--- Teil B: Puppeteer (Alex) — UI, Screenshots, ⋮ nur in Alex-Spalte ---');

    // Ausgangslage für die Bilder: Daniel erstellt erneut V1 [Alex,Jakob]
    r = await req('POST','/api/planning', dTok, { date:SC, time_from:'07:00', time_to:'16:00', break_minutes:30, address:'Baustelle V1', client:'Kunde', assigned_user_ids:[AX,JK] });
    const uiV1 = r.body.entry.id;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:900 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','alex'); await p.type('#login-pass','test');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');

    const showDay = async () => { await p.evaluate((d) => { S.planningView='day'; S.planningDate=new Date(d+'T12:00:00'); location.hash='#/planning'; if (typeof renderPlanningContent==='function') renderPlanningContent(); }, SC); await sleep(1200); };
    const setView = async (v) => { await p.evaluate((view,d) => { S.planningView=view; S.planningDate=new Date(d+'T12:00:00'); if (typeof renderPlanningContent==='function') renderPlanningContent(); }, v, SC); await sleep(1200); };

    // Geteilter Zustand: Screenshot Tag + ⋮ nur in Alex-Spalte
    await showDay();
    // ⋮-Verteilung über die Spalten erfassen
    const menus = await p.evaluate(() => [...document.querySelectorAll('.timeline-column')].map(col => ({
      name: (col.querySelector('.tl-col-header-name')||{}).textContent || '',
      menus: col.querySelectorAll('.plan-menu-btn').length,
      entries: col.querySelectorAll('.tl-plan-entry').length,
    })).filter(c => c.entries > 0));
    const alexCol = menus.find(c => /Alex/i.test(c.name));
    const otherWithMenu = menus.filter(c => !/Alex/i.test(c.name) && c.menus > 0);
    ok('B: geteilter Eintrag steht in Alex- UND Jakob-Spalte', menus.filter(c=>/Alex|Jakob/i.test(c.name)).length===2, JSON.stringify(menus));
    ok('B: ⋮-Menü erscheint in Alex-Spalte', !!alexCol && alexCol.menus===1, JSON.stringify(menus));
    ok('B: ⋮-Menü erscheint NICHT bei den anderen', otherWithMenu.length===0, JSON.stringify(menus));
    await p.screenshot({ path: SHOTS+'/01-tag-geteilt-haburger-nur-alex.png' });

    // Alex löst den Split DURCH DIE UI aus: ⋮ in Alex-Spalte → Bearbeiten → Zeiten ändern → Speichern
    await p.evaluate(() => {
      const col = [...document.querySelectorAll('.timeline-column')].find(c => /Alex/i.test((c.querySelector('.tl-col-header-name')||{}).textContent||''));
      col.querySelector('.plan-menu-btn').click();
    });
    await sleep(300);
    await p.evaluate(() => document.querySelector('.plan-action-menu .plan-menu-edit').click());
    await p.waitForSelector('#planning-form'); await sleep(400);
    // Self-Planer-Formular: keine Mitarbeiter-Auswahl
    const formNoPicker = await p.evaluate(() => ({ picker: !!document.querySelector('.planning-user-checkboxes'), self: (document.querySelector('.planning-self-target')||{}).textContent||'' }));
    ok('B: Edit-Formular ohne Mitarbeiter-Auswahl', formNoPicker.picker===false && /nur du/.test(formNoPicker.self), JSON.stringify(formNoPicker));
    // Zeiten ändern + speichern
    await p.evaluate(() => {
      const f=document.getElementById('pf-single-from'), t=document.getElementById('pf-single-to');
      f.value='08:00'; f.dispatchEvent(new Event('change',{bubbles:true}));
      t.value='14:00'; t.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await p.click('#planning-form button[type="submit"]'); await sleep(1200);
    let st2 = await state();
    ok('B: Split über die UI ausgelöst → V1 [Jakob] + V2 [Alex]', st2.length===2 && st2.some(e=>JSON.stringify(e.ids)===JSON.stringify([JK])) && st2.some(e=>JSON.stringify(e.ids)===JSON.stringify([AX])), JSON.stringify(st2.map(e=>({f:e.from,i:e.ids}))));

    // Screenshots Tag / Woche / Monat (post-split)
    await showDay();
    await p.screenshot({ path: SHOTS+'/02-tag-nach-split.png' });
    await setView('week');
    await p.screenshot({ path: SHOTS+'/03-woche.png' });
    await setView('month');
    await p.screenshot({ path: SHOTS+'/04-monat.png' });

    // Planungsformular (neu) — ohne Mitarbeiter-Auswahl
    await p.evaluate(() => { location.hash='#/planning/new'; }); await sleep(1000);
    await p.waitForSelector('#planning-form');
    const newForm = await p.evaluate(() => ({ picker: !!document.querySelector('.planning-user-checkboxes'), self: (document.querySelector('.planning-self-target')||{}).textContent||'' }));
    ok('B: Neues Planungsformular ohne Mitarbeiter-Auswahl', newForm.picker===false && /nur du/.test(newForm.self), JSON.stringify(newForm));
    await p.screenshot({ path: SHOTS+'/05-formular-ohne-userauswahl.png' });

    // Ausklinken DURCH DIE UI demonstrieren: Daniel macht V2 wieder geteilt, Alex löscht sich raus
    const aliceV2 = st2.find(e=>JSON.stringify(e.ids)===JSON.stringify([AX])).id;
    await req('PUT','/api/planning/'+aliceV2, dTok, { date:SC, time_from:'08:00', time_to:'14:00', break_minutes:0, assigned_user_ids:[AX,JK] });
    await showDay();
    await p.evaluate(() => {
      const col = [...document.querySelectorAll('.timeline-column')].find(c => /Alex/i.test((c.querySelector('.tl-col-header-name')||{}).textContent||''));
      // genau den geteilten 08:00-Eintrag treffen
      col.querySelector('.plan-menu-btn').click();
    });
    await sleep(300);
    await p.evaluate(() => document.querySelector('.plan-action-menu .plan-menu-del').click());
    await sleep(300);
    await p.evaluate(() => { const b=document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); });
    await sleep(1000);
    const st3 = await state();
    const v2now = st3.find(e=>e.id===aliceV2);
    ok('B: Alex klinkt sich über die UI aus dem geteilten V2 aus → nur Jakob', !!v2now && JSON.stringify(v2now.ids)===JSON.stringify([JK]), JSON.stringify(st3.map(e=>({f:e.from,i:e.ids}))));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nScenario-Shared-Planning: ${pass} ok, ${fail} fehlgeschlagen`);
  console.log('Screenshots in ' + SHOTS);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
