// UI-Test „Fällig bis" + Frist-Marker: Countdown-Badge (farbcodiert), Goal-Marker im Balken (Position),
// behind/Puffer/knapp, sowie Kachel-Reihenfolge UNVERÄNDERT (nicht nach Datum umsortiert).
// Start: node tests/project-due-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3143;
const DB = '/tmp/project-due-ui.db';
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
const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const RED='#dc2626', ORANGE='#ea580c', GREEN='#16a34a';
const dueStyle = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .proj-due`); return e ? e.getAttribute('style') : null; }, id);
const goalLeft = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim .ms-goal`); return e ? parseFloat(e.style.left) : null; }, id);
const bufferW = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim .ms-buffer`); return e ? parseFloat(e.style.width) : null; }, id);
const detailText = (p, id) => p.evaluate(id => { const d = document.querySelector(`.proj-tile[data-id="${id}"] .proj-detail`); return d ? d.textContent : ''; }, id);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/project-due-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-due-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'test', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const P = (o) => req('POST','/api/projects', admin, { assigned_user_ids:[anna.id], ...o }).then(r => r.body.project);
    // behind: Frist in 15 T, Restaufwand 30 T (alle offen) → rot, goalPct=(0+15)/30*100=50, „15 T über"
    const behind = await P({ name:'Behind', due_date:iso(15), milestones:[{title:'A',est_days:15},{title:'B',est_days:15}] });
    // Puffer: Frist in 30 T, Rest 20 T → grün, goalPct=100, „10 T Luft"
    const puffer = await P({ name:'Puffer', due_date:iso(30), milestones:[{title:'A',est_days:10},{title:'B',est_days:10}] });
    // knapp: Frist in 20 T, Rest 18 T (ratio 0.9) → orange
    const knapp  = await P({ name:'Knapp', due_date:iso(20), milestones:[{title:'A',est_days:18}] });
    // überfällig ohne Ziele → rotes Badge, KEIN Balken/Marker
    const odNoMs = await P({ name:'Overdue', due_date:iso(-4) });
    ok('Setup', !!(behind && puffer && knapp && odNoMs));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1200);

    // Badges + Farben
    ok('behind: rotes Badge', (await dueStyle(p, behind.id) || '').includes(RED), await dueStyle(p, behind.id));
    ok('puffer: grünes Badge', (await dueStyle(p, puffer.id) || '').includes(GREEN), await dueStyle(p, puffer.id));
    ok('knapp: orangenes Badge', (await dueStyle(p, knapp.id) || '').includes(ORANGE), await dueStyle(p, knapp.id));
    ok('überfällig ohne Ziele: rotes Badge', (await dueStyle(p, odNoMs.id) || '').includes(RED), await dueStyle(p, odNoMs.id));

    // Frist-Marker-Position im Balken
    const gb = await goalLeft(p, behind.id), gp = await goalLeft(p, puffer.id);
    ok('behind: Frist-Marker IM Balken (~50%)', gb !== null && gb > 40 && gb < 60, 'left=' + gb);
    ok('puffer: Frist-Marker am rechten Rand (100%)', gp === 100, 'left=' + gp);
    ok('überfällig ohne Ziele: KEIN Frist-Marker', (await goalLeft(p, odNoMs.id)) === null);

    // Luft (hellblaues Segment) nur bei Puffer
    const bufP = await bufferW(p, puffer.id), bufB = await bufferW(p, behind.id);
    ok('puffer: hellblaues Luft-Segment vorhanden (>0)', bufP !== null && bufP > 0, 'buffer=' + bufP);
    ok('behind: KEIN Luft-Segment', bufB === null, 'buffer=' + bufB);

    // Detail-Text
    ok('behind: „über Frist" im Detail', /über Frist/.test(await detailText(p, behind.id)));
    ok('puffer: „Luft" im Detail', /Luft/.test(await detailText(p, puffer.id)));

    // Reihenfolge UNVERÄNDERT: zwei gelbe Projekte, das später angelegte (mit überfälligem Datum) bleibt UNTEN
    const first = await req('POST','/api/projects', admin, { name:'ZZZ Zuerst', urgency:'gelb' }).then(r=>r.body.project);
    await sleep(20);
    const later = await req('POST','/api/projects', admin, { name:'ZZZ Später', urgency:'gelb', due_date:iso(-10) }).then(r=>r.body.project);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(300);
    await p.evaluate(()=>renderProjects()); await sleep(900);
    const order = await p.evaluate(() => {
      const col = [...document.querySelectorAll('.board-col')].find(c => c.querySelector('.board-col-head').textContent.includes('Nicht zugewiesen'));
      return [...col.querySelectorAll('.proj-name')].map(e => e.textContent.trim());
    });
    ok('Reihenfolge unverändert: überfälliges (später angelegt) NICHT hochsortiert', order.indexOf('ZZZ Zuerst') < order.indexOf('ZZZ Später'), JSON.stringify(order.filter(n=>/^ZZZ/.test(n))));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProject-Due-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
