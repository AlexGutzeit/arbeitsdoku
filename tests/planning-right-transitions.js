// Planungsrecht-Übergänge (dynamisch, ohne Re-Login) für einen Mitarbeiter „Alex":
//   nein → selbst → alle → nein   (jeweils nach F5)
// Unterscheidbarkeit selbst vs. alle:
//   selbst = FAB da, Formular OHNE Mitarbeiter-Auswahl (nur „du"), KEINE fremden Abwesenheiten
//   alle   = FAB da, Formular MIT Mitarbeiter-Auswahl, fremde Abwesenheiten sichtbar
// Start: node tests/planning-right-transitions.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3107;
const DB = '/tmp/planning-right-transitions.db';
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

// Zukunftstag (Alex ab heute angestellt → Zukunft, damit planbar/sichtbar)
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const D = (()=>{ const d=new Date(); d.setDate(d.getDate()+10); return ymd(d); })();

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-right-transitions-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-right-transitions-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const A = (await req('POST','/api/users', admin, { username:'alex', password:'test', name:'Alex', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const X = (await req('POST','/api/users', admin, { username:'kollege', password:'test', name:'Kollege', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    // Kollege hat eine Abwesenheit (für die „fremde Abwesenheit sichtbar?"-Unterscheidung)
    await req('POST','/api/absences', admin, { type:'krank', date_from:D, date_to:D, target_user_id:X.id });
    ok('Setup: Alex + Kollege (mit Abwesenheit)', !!(A && X));

    const setRight = (canPlan, canPlanAll) => req('PUT','/api/users/'+A.id, admin, { username:'alex', name:'Alex', role:'mitarbeiter', can_plan:canPlan, can_plan_all:canPlanAll });
    const aTok = async () => await tok('alex');
    const seesForeignAbsence = async () => {
      const r = await req('GET', `/api/absences/by-date?from=${D}&to=${D}&scope=planning`, await aTok());
      return (r.body.absences || []).some(a => a.user_id === X.id);
    };

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:820 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','alex'); await p.type('#login-pass','test');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');

    const reloadPlanningFAB = async () => {
      await p.reload({ waitUntil:'networkidle2' }); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);
      await p.evaluate(() => { S.planningView='day'; location.hash='#/planning'; if (typeof renderPlanningContent==='function') renderPlanningContent(); }); await sleep(900);
      return p.evaluate(() => !!document.getElementById('fab-new'));
    };
    const openNewForm = async () => {
      await p.evaluate(() => { location.hash='#/planning/new'; }); await sleep(900);
      return p.evaluate(() => ({ form: !!document.getElementById('planning-form'), picker: !!document.querySelector('.planning-user-checkboxes'), self: !!document.querySelector('.planning-self-target') }));
    };

    // --- Zustand 1: Planung NEIN ---
    console.log('\n[nein]');
    ok('nein: kein FAB (kann nicht planen)', (await reloadPlanningFAB()) === false);

    // --- nein → selbst ---
    console.log('\n[nein → selbst]');
    await setRight(1, 0);
    ok('selbst: FAB erscheint nach F5 (ohne Re-Login)', (await reloadPlanningFAB()) === true);
    let f = await openNewForm();
    ok('selbst: Formular OHNE Mitarbeiter-Auswahl, „nur du"', f.form && !f.picker && f.self, JSON.stringify(f));
    ok('selbst: sieht KEINE fremde Abwesenheit', (await seesForeignAbsence()) === false);

    // --- selbst → alle ---
    console.log('\n[selbst → alle]');
    await setRight(1, 1);
    ok('alle: FAB weiterhin da nach F5', (await reloadPlanningFAB()) === true);
    f = await openNewForm();
    ok('alle: Formular MIT Mitarbeiter-Auswahl (kein self-only)', f.form && f.picker && !f.self, JSON.stringify(f));
    ok('alle: sieht fremde Abwesenheit (Planungskontext)', (await seesForeignAbsence()) === true);

    // --- alle → nein ---
    console.log('\n[alle → nein]');
    await setRight(0, 0);
    ok('nein: FAB verschwindet nach F5', (await reloadPlanningFAB()) === false);

    // --- Bonus: nein → alle direkt (alle impliziert selbst) ---
    console.log('\n[nein → alle direkt]');
    await setRight(0, 1); // can_plan_all=1 → Backend erzwingt can_plan=1
    ok('alle direkt: FAB da', (await reloadPlanningFAB()) === true);
    f = await openNewForm();
    ok('alle direkt: Mitarbeiter-Auswahl vorhanden', f.picker && !f.self, JSON.stringify(f));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Right-Transitions: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
