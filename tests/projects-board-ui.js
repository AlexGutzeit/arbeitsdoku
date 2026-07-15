// UI-Test (Puppeteer) Auftrags-Board: FAB-Formular, Spalten je MA + „Nicht zugewiesen", Dringlichkeits-
// Sortierung, Kachel-Details + Buttons je Rolle, „In Planung übernehmen"/„Als Zeitnachweis übernehmen"
// (Vorbefüllung), Bearbeiten/Erledigt/Löschen, sowie Projekt-Dropdown-Autofill im Zeitnachweis.
// Start: node tests/projects-board-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3112;
const DB = '/tmp/projects-board-ui.db';
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
const tok = async (u, pw='Test1234!') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const inColumn = (p, colName, projName) => p.evaluate((cn, pn) => {
  const col = [...document.querySelectorAll('.board-col')].find(c => ((c.querySelector('.board-col-head')||{}).textContent || '').includes(cn));
  if (!col) return false;
  return [...col.querySelectorAll('.proj-name')].some(el => el.textContent.trim() === pn);
}, colName, projName);
const login = async (p, u, pw) => {
  await p.evaluate(() => { try { localStorage.clear(); } catch(_){} });
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
};
const goBoard = async (p) => { await p.evaluate(() => { location.hash = '#/projects'; }); await sleep(1000); };
async function tileAction(p, id, btnClass) {
  await p.evaluate((id) => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), id); await sleep(250);
  await p.evaluate((id, bc) => document.querySelector(`.proj-tile[data-id="${id}"] .${bc}`).click(), id, btnClass); await sleep(900);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/projects-board-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/projects-board-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const A = (await req('POST','/api/users', admin, { username:'m1', password:'Test1234!', name:'M1', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const B = (await req('POST','/api/users', admin, { username:'m2', password:'Test1234!', name:'M2', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    // Seed-Projekte (leere DB hat Alpha/Beta) — via API deterministisch
    const pAlpha = (await req('POST','/api/projects', admin, { name:'Auftrag Alpha', client:'Kunde A', address:'Weg 1', note:'Notiz A', urgency:'rot', assigned_user_ids:[A.id, B.id] })).body.project;
    const pGruen = (await req('POST','/api/projects', admin, { name:'Grün Job', urgency:'gruen', assigned_user_ids:[A.id] })).body.project;
    const pFrei = (await req('POST','/api/projects', admin, { name:'Freier Auftrag', urgency:'gelb' })).body.project;
    ok('Setup: 2 MA + 3 Aufträge', !!(A && B && pAlpha && pGruen && pFrei));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1400, height:900 });

    // ===== ADMIN =====
    await login(p, 'admin', apw); await goBoard(p);
    const legend = await p.evaluate(() => { const l = document.querySelector('.board-legend'); return l ? l.textContent : ''; });
    ok('Farb-Legende: Dringlichkeit (Dringend…Niedrig) + Fortschritt (erledigt/in Arbeit/offen)',
      /Dringlichkeit/.test(legend) && /Dringend/.test(legend) && /Niedrig/.test(legend) && /Fortschritt/.test(legend) && /erledigt/.test(legend) && /in Arbeit/.test(legend) && /offen/.test(legend), legend.replace(/\s+/g,' ').trim());
    ok('Auftrag Alpha unter M1', await inColumn(p, 'M1', 'Auftrag Alpha'));
    ok('Auftrag Alpha auch unter M2 (Mehrfachzuweisung)', await inColumn(p, 'M2', 'Auftrag Alpha'));
    ok('Freier Auftrag unter „Nicht zugewiesen"', await inColumn(p, 'Nicht zugewiesen', 'Freier Auftrag'));
    ok('Alpha NICHT unter „Nicht zugewiesen"', !(await inColumn(p, 'Nicht zugewiesen', 'Auftrag Alpha')));
    // Sortierung in M1-Spalte: rot (Alpha) vor grün (Grün Job)
    const order = await p.evaluate(() => {
      const col = [...document.querySelectorAll('.board-col')].find(c => (c.querySelector('.board-col-head')||{}).textContent.includes('M1'));
      return [...col.querySelectorAll('.proj-name')].map(e => e.textContent.trim());
    });
    ok('Sortierung: rot vor grün', order.indexOf('Auftrag Alpha') < order.indexOf('Grün Job'), JSON.stringify(order));
    ok('Admin: FAB vorhanden', await p.evaluate(() => !!document.getElementById('fab-new')));

    // FAB → Formular → Auftrag anlegen (unzugewiesen)
    await p.evaluate(() => document.getElementById('fab-new').click()); await sleep(500);
    ok('FAB öffnet Projekt-Formular', await p.evaluate(() => !!document.getElementById('pf2-name')));
    await p.type('#pf2-name', 'FAB Auftrag'); await p.type('#pf2-client', 'Kunde FAB');
    await p.select('#pf2-urgency', 'orange');
    await p.evaluate(() => document.getElementById('pf2-save').click()); await sleep(1000);
    ok('FAB-Auftrag erscheint unter „Nicht zugewiesen"', await inColumn(p, 'Nicht zugewiesen', 'FAB Auftrag'));

    // In Planung übernehmen (Vorbefüllung)
    await tileAction(p, pAlpha.id, 'proj-plan');
    await p.evaluate((a,b)=>{ window.__A=a; window.__B=b; }, A.id, B.id);
    const plan = await p.evaluate(() => ({
      client:(document.getElementById('pf-client')||{}).value, address:(document.getElementById('pf-address')||{}).value,
      m1: !!document.querySelector('input[name="assigned"][value="'+window.__A+'"]:checked'),
      m2: !!document.querySelector('input[name="assigned"][value="'+window.__B+'"]:checked'),
    }));
    ok('In Planung übernehmen: Kunde+Adresse vorbefüllt', plan.client==='Kunde A' && plan.address==='Weg 1', JSON.stringify(plan));
    ok('In Planung übernehmen: zugedachte MA vorgehakt', plan.m1 && plan.m2, JSON.stringify(plan));

    // Als Zeitnachweis übernehmen (Vorbefüllung)
    await goBoard(p);
    await tileAction(p, pAlpha.id, 'proj-entry');
    const ent = await p.evaluate(() => ({
      client:(document.getElementById('ef-client')||{}).value, address:(document.getElementById('ef-address')||{}).value,
      desc:(document.getElementById('ef-desc')||{}).value,
    }));
    ok('Zeitnachweis übernehmen: Kunde/Adresse/Notiz vorbefüllt', ent.client==='Kunde A' && ent.address==='Weg 1' && ent.desc==='Notiz A', JSON.stringify(ent));

    // Bearbeiten → Dringlichkeit ändern; Erledigt; Löschen
    await goBoard(p);
    await tileAction(p, pGruen.id, 'proj-edit');
    await p.select('#pf2-urgency', 'rot');
    await p.evaluate(() => document.getElementById('pf2-save').click()); await sleep(900);
    ok('Bearbeiten: „Grün Job" noch da (jetzt rot)', await inColumn(p, 'M1', 'Grün Job'));
    await tileAction(p, pAlpha.id, 'proj-done');
    await p.evaluate(() => { const b=document.querySelector('.dialog-modal [data-act="ok"]'); if(b) b.click(); }); await sleep(900);
    ok('Erledigt: Alpha verschwindet vom Board', !(await inColumn(p, 'M1', 'Auftrag Alpha')));
    await tileAction(p, pFrei.id, 'proj-del');
    await p.evaluate(() => { const b=document.querySelector('.dialog-modal [data-act="ok"]'); if(b) b.click(); }); await sleep(900);
    ok('Löschen: Freier Auftrag weg', !(await inColumn(p, 'Nicht zugewiesen', 'Freier Auftrag')));

    // ===== MITARBEITER (M1) =====
    await login(p, 'm1', 'Test1234!'); await goBoard(p);
    ok('MA: kein FAB', await p.evaluate(() => !document.getElementById('fab-new')));
    const maBtns = await p.evaluate((id) => {
      const t = document.querySelector(`.proj-tile[data-id="${id}"]`); if (t) t.click();
      const q = (c) => !!(t && t.querySelector('.'+c));
      return { entry:q('proj-entry'), plan:q('proj-plan'), edit:q('proj-edit'), done:q('proj-done'), del:q('proj-del') };
    }, pGruen.id); await sleep(200);
    ok('MA: „Als Zeitnachweis übernehmen" da, aber kein Edit/Erledigt/Löschen', maBtns.entry && !maBtns.edit && !maBtns.done && !maBtns.del, JSON.stringify(maBtns));
    ok('MA (ohne Planungsrecht): kein „In Planung übernehmen"', maBtns.plan === false, JSON.stringify(maBtns));

    // Projekt-Dropdown-Autofill im Zeitnachweis-Formular (Datenprojekt VOR dem Laden anlegen)
    const withData = (await req('POST','/api/projects', admin, { name:'Daten Job', client:'Kunde D', address:'Adr 9', note:'Notiz D', urgency:'gelb', assigned_user_ids:[A.id] })).body.project;
    await goBoard(p); // weg-navigieren, damit #/entry/new frisch rendert
    await p.evaluate(() => { location.hash = '#/entry/new'; }); await sleep(1000);
    await p.evaluate((id) => { const s=document.getElementById('ef-project'); s.value=String(id); s.dispatchEvent(new Event('change',{bubbles:true})); }, withData.id);
    await sleep(300);
    const af = await p.evaluate(() => ({ a:(document.getElementById('ef-address')||{}).value, c:(document.getElementById('ef-client')||{}).value, d:(document.getElementById('ef-desc')||{}).value }));
    ok('Zeitnachweis: Projekt-Dropdown füllt Adresse/Kunde/Notiz', af.a==='Adr 9' && af.c==='Kunde D' && af.d==='Notiz D', JSON.stringify(af));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProjects-Board-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
