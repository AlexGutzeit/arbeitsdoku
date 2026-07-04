// Zuteilbarkeit: ALLE Nutzer außer Admin (Chef, Buchhalter, Mitarbeiter) sind im Projekt-Formular auswählbar
// und erscheinen als Board-Spalten. Admin ist NICHT zuteilbar.
// Start: node tests/board-assign-all-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3122;
const DB = '/tmp/board-assign.db';
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
const inColumn = (p, colName, projName) => p.evaluate((cn, pn) => {
  const col = [...document.querySelectorAll('.board-col')].find(c => ((c.querySelector('.board-col-head')||{}).textContent || '').includes(cn));
  return !!col && [...col.querySelectorAll('.proj-name')].some(el => el.textContent.trim() === pn);
}, colName, projName);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-assign-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-assign-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'Bucha Halter', role:'buchhalter' });
    const ma   = await mk({ username:'ma',    name:'Mitarbeiter A' });
    ok('Setup: chef + buchhalter + MA', !!(chef&&bh&&ma));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1200);

    // Formular öffnen → Zuordnungstabelle prüfen
    await p.evaluate(()=>document.getElementById('fab-new').click()); await sleep(600);
    const boxes = await p.evaluate(()=> [...document.querySelectorAll('.pf2-assignee')].map(cb=>Number(cb.value)));
    ok('Chef im Formular zuteilbar', boxes.includes(chef.id), JSON.stringify(boxes));
    ok('Buchhalter im Formular zuteilbar', boxes.includes(bh.id));
    ok('Mitarbeiter im Formular zuteilbar', boxes.includes(ma.id));
    ok('Admin NICHT zuteilbar', await p.evaluate(()=> ![...document.querySelectorAll('.planning-user-checkboxes label')].some(l=>/Administrator/.test(l.textContent))));
    ok('Rollen-Kennzeichnung sichtbar (Chef/Buchhalter)', await p.evaluate(()=>{ const t=document.querySelector('.planning-user-checkboxes').textContent; return /\(Chef\)/.test(t) && /\(Buchhalter\)/.test(t); }));

    // Auftrag anlegen, zugewiesen an Chef + Buchhalter
    await p.type('#pf2-name', 'Hausarbeit');
    for (const id of [chef.id, bh.id]) await p.evaluate(i=>{ const cb=document.querySelector('.pf2-assignee[value="'+i+'"]'); if(cb && !cb.checked) cb.click(); }, id);
    await p.evaluate(()=>document.getElementById('pf2-save').click()); await sleep(1100);

    ok('Board: Spalte „Chef Zwei" zeigt den Auftrag', await inColumn(p, 'Chef Zwei', 'Hausarbeit'));
    ok('Board: Spalte „Bucha Halter" zeigt den Auftrag', await inColumn(p, 'Bucha Halter', 'Hausarbeit'));
    // Persistenz + korrekte Zuweisung
    const proj = (await req('GET','/api/projects', admin)).body.projects.find(x=>x.name==='Hausarbeit');
    const ids = (proj.assigned_users||[]).map(u=>u.user_id).sort();
    ok('Zuweisung persistiert (Chef + Buchhalter)', ids.length===2 && ids.includes(chef.id) && ids.includes(bh.id), JSON.stringify(ids));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Assign-All: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
