// Archiv/Reopen + Dringlichkeitsampel (Chef/Admin). MA hat weder Ampel noch Archiv-Zugriff.
// Start: node tests/board-archive-ampel-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3119;
const DB = '/tmp/board-arch.db';
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
const boardHas = (p, n) => p.evaluate(n => [...document.querySelectorAll('.proj-name')].some(e => e.textContent.trim()===n), n);
const urgencyOf = async (admin, id, done) => ((await req('GET','/api/projects'+(done?'?done=1':''), admin)).body.projects.find(x=>x.id===id)||{}).urgency;
const login = async (p, u, pw='test') => {
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.evaluate(()=>{ try{localStorage.clear()}catch(_){}});
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
};
const goBoard = async (p) => { await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1000); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-arch-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-arch-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const ma = (await req('POST','/api/users', admin, { username:'ma', password:'test', name:'Mitarbeiter A', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const projA = (await req('POST','/api/projects', admin, { name:'Ampel Auftrag', client:'Kunde A', urgency:'gelb', assigned_user_ids:[ma.id] })).body.project;
    ok('Setup: MA + Auftrag (gelb)', !!(ma && projA && projA.urgency==='gelb'));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:900 });

    // ===== Dringlichkeitsampel (Admin) =====
    console.log('\n[Ampel]');
    await login(p, 'admin', apw); await goBoard(p);
    ok('Admin: Ampel-Button (klickbare Flagge) vorhanden', await p.evaluate(id => !!document.querySelector(`.proj-tile[data-id="${id}"] .proj-flag-btn`), projA.id));
    // Flagge öffnet Farbauswahl
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-flag-btn`).click(), projA.id); await sleep(250);
    ok('Klick auf Flagge öffnet Farbauswahl', await p.evaluate(id => { const pk=document.querySelector(`.proj-tile[data-id="${id}"] .urg-picker`); return pk && pk.style.display!=='none'; }, projA.id));
    // auf „rot" klicken
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .urg-opt[data-urg="rot"]`).click(), projA.id); await sleep(900);
    ok('Dringlichkeit per Ampel auf rot geändert (persistiert)', (await urgencyOf(admin, projA.id))==='rot');
    // zurück auf grün
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-flag-btn`).click(), projA.id); await sleep(250);
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .urg-opt[data-urg="gruen"]`).click(), projA.id); await sleep(900);
    ok('Ampel auf grün geändert (persistiert)', (await urgencyOf(admin, projA.id))==='gruen');

    // ===== Archiv / Reopen (Admin) =====
    console.log('\n[Archiv/Reopen]');
    await req('POST','/api/projects/'+projA.id+'/done', admin); // erledigt
    await goBoard(p);
    ok('Erledigter Auftrag NICHT im offenen Board', !(await boardHas(p, 'Ampel Auftrag')));
    ok('Admin: „Erledigte anzeigen"-Toggle vorhanden', await p.evaluate(()=>!!document.getElementById('board-archive-toggle')));
    await p.evaluate(()=>document.getElementById('board-archive-toggle').click()); await sleep(900);
    ok('Archiv zeigt erledigten Auftrag', await boardHas(p, 'Ampel Auftrag'));
    ok('Archiv-Kachel hat „Wieder öffnen"', await p.evaluate(id => !!document.querySelector(`.proj-tile[data-id="${id}"] .proj-reopen`), projA.id));
    ok('Archiv-Kachel hat KEIN „Erledigt"', await p.evaluate(id => !document.querySelector(`.proj-tile[data-id="${id}"] .proj-done`), projA.id));
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-reopen`).click(), projA.id); await sleep(900);
    ok('nach Reopen: Auftrag wieder offen (done=0)', (await req('GET','/api/projects', admin)).body.projects.some(x=>x.id===projA.id && !x.done));
    // zurück auf offene Ansicht
    await p.evaluate(()=>{ const t=document.getElementById('board-archive-toggle'); if(t) t.click(); }); await sleep(900);
    ok('offenes Board zeigt den Auftrag wieder', await boardHas(p, 'Ampel Auftrag'));

    // ===== MA: keine Ampel, kein Archiv =====
    console.log('\n[MA-Gating]');
    await login(p, 'ma', 'test'); await goBoard(p);
    ok('MA: KEINE klickbare Ampel-Flagge', await p.evaluate(()=>!document.querySelector('.proj-flag-btn')));
    ok('MA: KEIN Archiv-Toggle', await p.evaluate(()=>!document.getElementById('board-archive-toggle')));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Archiv/Ampel: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
