// UI-Test Zwischenziele + Fortschrittsbalken: Editor im Formular, gewichteter Balken, Status-Picker-Rechte
// (Zugeteilte/Chef/Admin vs. read-only), ohne Ziele kein Balken, Multi-Client-Live-Update.
// Start: node tests/project-milestones-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3125;
const DB = '/tmp/project-ms-ui.db';
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
const login = async (p, u, pw='test') => {
  await p.goto(BASE, { waitUntil:'networkidle2' }); await p.evaluate(()=>{try{localStorage.clear()}catch(_){}});
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
};
const goBoard = async (p) => { await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1100); };
const expand = async (p, pid) => { await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), pid); await sleep(250); };
const detailText = (p, pid) => p.evaluate(id => { const d = document.querySelector(`.proj-tile[data-id="${id}"] .proj-detail`); return d ? d.textContent : ''; }, pid);
const setStatus = async (p, pid, mid, status) => { await p.evaluate((id,m,s) => document.querySelector(`.proj-tile[data-id="${id}"] .ms-opt[data-mid="${m}"][data-status="${s}"]`).click(), pid, mid, status); await sleep(700); };
async function waitFor(page, fn, arg, timeout=6000) { const s=Date.now(); while(Date.now()-s<timeout){ if(await page.evaluate(fn, arg)) return true; await sleep(250);} return false; }

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/project-ms-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-ms-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const m1 = await mk({ username:'m1', name:'Mitarbeiter A' }); // zugeteilt
    const m2 = await mk({ username:'m2', name:'Mitarbeiter B' }); // nicht zugeteilt
    ok('Setup: 2 MA', !!(m1 && m2));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });

    // ===== Editor im Formular =====
    console.log('\n[Editor]');
    await login(p, 'admin', apw); await goBoard(p);
    await p.evaluate(()=>document.getElementById('fab-new').click()); await sleep(500);
    await p.type('#pf2-name', 'Bau A');
    await p.evaluate(id=>{ const cb=document.querySelector('.pf2-assignee[value="'+id+'"]'); if(cb) cb.click(); }, m1.id);
    for (let i=0;i<3;i++){ await p.evaluate(()=>document.getElementById('pf2-ms-add').click()); await sleep(150); }
    await p.evaluate((data)=>{
      const T=[...document.querySelectorAll('.ms-edit-title')], D=[...document.querySelectorAll('.ms-edit-days')];
      data.forEach((d,i)=>{ T[i].value=d.t; T[i].dispatchEvent(new Event('input',{bubbles:true})); D[i].value=String(d.d); D[i].dispatchEvent(new Event('input',{bubbles:true})); });
    }, [{t:'Hauptverteiler',d:2},{t:'Trassen bauen',d:30},{t:'Kabel verlegen',d:14}]);
    await p.evaluate(()=>document.getElementById('pf2-save').click()); await sleep(1100);

    const proj = (await req('GET','/api/projects', admin)).body.projects.find(x=>x.name==='Bau A');
    const pid = proj.id; const id = t => proj.milestones.find(m=>m.title===t).id;
    ok('3 Zwischenziele gespeichert (Reihenfolge)', proj.milestones.map(m=>m.title).join(',')==='Hauptverteiler,Trassen bauen,Kabel verlegen', JSON.stringify(proj.milestones.map(m=>m.title)));
    ok('Kachel zeigt schlanken Fortschrittsbalken', await p.evaluate(id=>!!document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim`), pid));

    // ===== Fortschritt (dauergewichtet) =====
    console.log('\n[Fortschritt]');
    await expand(p, pid);
    ok('aufgeklappt: 3 Ziele + Balken, Start 100% offen', (await detailText(p, pid)).includes('100% offen'), (await detailText(p, pid)).match(/\d+% fertig[^]*offen/));
    await setStatus(p, pid, id('Hauptverteiler'), 'done');
    await setStatus(p, pid, id('Trassen bauen'), 'doing');
    const txt = await detailText(p, pid);
    ok('gewichtet: 4% fertig · 65% in Arbeit · 30% offen', txt.includes('4% fertig') && txt.includes('65% in Arbeit') && txt.includes('30% offen'), txt.replace(/\s+/g,' ').match(/\d+% fertig[^A]*Arbeit[^o]*offen/));

    // ===== Rechte: zugeteilter MA vs. fremder MA =====
    console.log('\n[Rechte]');
    await login(p, 'm1'); await goBoard(p); await expand(p, pid);
    ok('zugeteilter MA: Status-Picker vorhanden', await p.evaluate(id=>!!document.querySelector(`.proj-tile[data-id="${id}"] .ms-opt`), pid));
    await login(p, 'm2'); await goBoard(p); await expand(p, pid);
    ok('fremder MA: KEIN Picker, aber Farbpunkt (read-only)', await p.evaluate(id=>{ const t=document.querySelector(`.proj-tile[data-id="${id}"]`); return !t.querySelector('.ms-opt') && !!t.querySelector('.ms-dot'); }, pid));
    ok('fremder MA sieht den Balken + Prozente', (await detailText(p, pid)).includes('% fertig'));

    // ===== Ohne Ziele kein Balken =====
    console.log('\n[Ohne Ziele]');
    await req('POST','/api/projects', admin, { name:'Leer', assigned_user_ids:[m1.id] });
    await login(p, 'admin', apw); await goBoard(p);
    const leer = (await req('GET','/api/projects', admin)).body.projects.find(x=>x.name==='Leer').id;
    ok('Auftrag ohne Ziele: KEIN Fortschrittsbalken', await p.evaluate(id=>!document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar`), leer));
    await expand(p, leer);
    ok('ohne Ziele: Hinweis „Noch keine Zwischenziele"', (await detailText(p, leer)).includes('Noch keine Zwischenziele'));

    // ===== Multi-Client-Live =====
    console.log('\n[Multi-Client-Live]');
    const mkCtx = async (u) => { const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext()); const pg = await ctx.newPage(); await pg.setViewport({ width:1100, height:900 }); await login(pg, u); await goBoard(pg); await expand(pg, pid); return pg; };
    const pA = await mkCtx('m1');   // zugeteilt, darf ändern
    const pB = await mkCtx('m2');   // nur Beobachter
    // pA setzt Kabel verlegen → erledigt: done=2+14=16/46≈35%, in Arbeit 30/46≈65%, offen 0%
    await setStatus(pA, pid, id('Kabel verlegen'), 'done');
    const live = await waitFor(pB, (id)=>{ const d=document.querySelector(`.proj-tile[data-id="${id}"] .proj-detail`); return d && d.textContent.includes('35% fertig') && d.textContent.includes('0% offen'); }, pid);
    ok('Beobachter sieht Fortschritts-Update LIVE (35% fertig, 0% offen)', live);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProject-Milestones-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
