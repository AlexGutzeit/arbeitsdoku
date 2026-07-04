// Mobile-Ansicht des Boards (390×844): Spalten horizontal wischbar, vertikal scrollbar, Kachel/Detail,
// FAB + Formular nutzbar, Ampel. Erzeugt zusätzlich einen Screenshot.
// Start: node tests/board-mobile-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3120;
const DB = '/tmp/board-mobile.db';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-mobile-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-mobile-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (n) => (await req('POST','/api/users', admin, { username:n.toLowerCase(), password:'test', name:n, role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const a = await mk('Anna'), b = await mk('Bernd'), c = await mk('Carla');
    const U = ['rot','orange','gelb','gruen'];
    for (let i=1;i<=12;i++) await req('POST','/api/projects', admin, { name:'Auftrag '+i, client:'Kunde '+i, address:(i%2?'Weg '+i+', 10115 Berlin':''), note:'Notiz '+i, urgency:U[i%4], assigned_user_ids:[a.id] });
    for (const u of [b,c]) for (let i=1;i<=2;i++) await req('POST','/api/projects', admin, { name:'A-'+u.name+i, urgency:U[i%4], assigned_user_ids:[u.id] });
    ok('Setup: 3 MA + 16 Aufträge', true);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:390, height:844, isMobile:true, hasTouch:true, deviceScaleFactor:2 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1200);

    ok('Board rendert auf Mobil', await p.evaluate(()=>!!document.querySelector('.board-scroll') && document.querySelectorAll('.board-col').length>1));
    const m = await p.evaluate(()=>{ const sc=document.querySelector('.board-scroll'); return { hw:sc.scrollWidth, cw:sc.clientWidth, vh:sc.scrollHeight, ch:sc.clientHeight, tiles:document.querySelectorAll('.proj-tile').length }; });
    ok('horizontal wischbar (scrollWidth > clientWidth)', m.hw > m.cw, JSON.stringify(m));
    ok('vertikal scrollbar (hohe Spalte)', m.vh > m.ch, JSON.stringify(m));
    // horizontal scrollen bis ganz rechts erreichbar
    const moved = await p.evaluate(()=>{ const sc=document.querySelector('.board-scroll'); sc.scrollLeft=sc.scrollWidth; return sc.scrollLeft; });
    ok('horizontales Scrollen bewegt das Board', moved > 0, 'scrollLeft='+moved);
    await p.evaluate(()=>{ document.querySelector('.board-scroll').scrollLeft=0; }); await sleep(200);

    // Kachel öffnen
    await p.evaluate(()=>{ const t=[...document.querySelectorAll('.proj-tile')].find(x=>x.querySelector('.proj-name').textContent.includes('Auftrag 1')); t.click(); }); await sleep(300);
    ok('Kachel-Detail öffnet sich (Aktionen sichtbar)', await p.evaluate(()=>{ const d=[...document.querySelectorAll('.proj-detail')].find(x=>x.style.display!=='none'); return !!(d && d.querySelector('.proj-actions')); }));

    // Ampel auf Mobil
    const someId = (await req('GET','/api/projects', admin)).body.projects[0].id;
    await p.evaluate(id=>{ const t=document.querySelector(`.proj-tile[data-id="${id}"] .proj-flag-btn`); if(t) t.click(); }, someId); await sleep(250);
    ok('Ampel-Farbauswahl öffnet auf Mobil', await p.evaluate(id=>{ const pk=document.querySelector(`.proj-tile[data-id="${id}"] .urg-picker`); return pk && pk.style.display!=='none'; }, someId));

    // FAB + Formular
    ok('FAB auf Mobil vorhanden', await p.evaluate(()=>!!document.getElementById('fab-new')));
    await p.evaluate(()=>document.getElementById('fab-new').click()); await sleep(500);
    ok('Projekt-Formular öffnet + Eingabe möglich', await p.evaluate(()=>!!document.getElementById('pf2-name')));
    await p.type('#pf2-name', 'Mobil Test');
    ok('Name im Formular eingebbar', (await p.evaluate(()=>document.getElementById('pf2-name').value))==='Mobil Test');

    await p.evaluate(()=>{ history.back(); }); await sleep(400);
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1000);
    await p.screenshot({ path:'/tmp/board-mobile.png' });

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Mobile: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
