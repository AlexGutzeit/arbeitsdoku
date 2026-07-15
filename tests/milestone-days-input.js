// Test: Zwischenziel-Dauer akzeptiert Komma UND Punkt (1,5 === 1.5), ungültige Werte werden abgefangen
// (Backend robust → Fallback; Formular → Fehlermeldung, kein Speichern). API + Puppeteer.
// Start: node tests/milestone-days-input.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3139;
const DB = '/tmp/ms-days-test.db';
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
const msOf = async (t, id) => ((await req('GET','/api/projects/'+id, t)).body.project.milestones) || [];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/ms-days-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/ms-days-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);

    // ===== Backend robust =====
    console.log('\n[Backend]');
    const p1 = (await req('POST','/api/projects', admin, { name:'Bau A', milestones:[
      { title:'Komma', est_days:'1,5' }, { title:'Punkt', est_days:'1.5' }, { title:'Ganz', est_days:'2' },
      { title:'Negativ', est_days:-3 }, { title:'Müll', est_days:'abc' }, { title:'Leer', est_days:'' } ] })).body.project;
    const m = p1.milestones;
    ok('„1,5" (Komma) → 1.5', m[0].est_days===1.5, JSON.stringify(m[0]));
    ok('„1.5" (Punkt) → 1.5', m[1].est_days===1.5);
    ok('„2" → 2', m[2].est_days===2);
    ok('negativ → Fallback 1', m[3].est_days===1);
    ok('„abc" → Fallback 1', m[4].est_days===1);
    ok('leer → Fallback 1', m[5].est_days===1);
    ok('alle est_days sind gültige Zahlen (>=0)', m.every(x => typeof x.est_days==='number' && isFinite(x.est_days) && x.est_days>=0));

    // ===== Formular =====
    console.log('\n[Formular]');
    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:960 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1000);

    // Neues Projekt mit Komma-Dauer über das Formular
    await p.evaluate(()=>document.getElementById('fab-new').click()); await sleep(500);
    await p.type('#pf2-name', 'Form Bau');
    await p.evaluate(()=>document.getElementById('pf2-ms-add').click()); await sleep(150);
    await p.type('.ms-edit-title', 'Ziel A');
    await p.evaluate(()=>{ const d=document.querySelector('.ms-edit-days'); d.value='1,5'; d.dispatchEvent(new Event('input',{bubbles:true})); }); // Komma im Textfeld
    await p.evaluate(()=>document.getElementById('pf2-save').click()); await sleep(900);
    const fb = (await req('GET','/api/projects', admin)).body.projects.find(x=>x.name==='Form Bau');
    ok('Formular: Komma-Eingabe „1,5" → gespeichert als 1.5', !!fb && fb.milestones[0] && fb.milestones[0].est_days===1.5, JSON.stringify(fb && fb.milestones));

    // Ungültige Dauer → Fehlermeldung, KEIN Speichern
    await p.evaluate((id)=>{ location.hash='#/projects'; }, 0); await sleep(800);
    const editP = (await req('POST','/api/projects', admin, { name:'Prüf Bau', milestones:[{title:'Gut', est_days:2}] })).body.project;
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(900);
    // Bearbeiten öffnen
    await p.evaluate(id=>{ const t=document.querySelector(`.proj-tile[data-id="${id}"]`); t.click(); }, editP.id); await sleep(200);
    await p.evaluate(id=>document.querySelector(`.proj-tile[data-id="${id}"] .proj-edit`).click(), editP.id); await sleep(700);
    // vorhandene Dauer auf Müll setzen
    await p.evaluate(()=>{ const d=document.querySelector('.ms-edit-days'); d.value='abc'; d.dispatchEvent(new Event('input',{bubbles:true})); });
    await p.evaluate(()=>document.getElementById('pf2-save').click()); await sleep(600);
    const stillForm = await p.evaluate(()=>!!document.getElementById('pf2-save')); // Formular noch offen = nicht gespeichert
    ok('Formular: ungültige Dauer „abc" → nicht gespeichert (Formular bleibt offen)', stillForm);
    const after = await msOf(admin, editP.id);
    ok('Backend-Wert unverändert gültig (2, nicht kaputt)', after[0] && after[0].est_days===2, JSON.stringify(after));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nMilestone-Days-Input: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
