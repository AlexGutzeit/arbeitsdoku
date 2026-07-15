// UI-Test Statistik-Reiter: Manager (Admin/Chef/Buchhalter) sehen „📊 Statistik" auf der Kachel und
// bekommen Netto-Stunden je Nutzer + Gesamt; normaler Mitarbeiter sieht den Reiter NICHT.
// Start: node tests/project-stats-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3131;
const DB = '/tmp/project-stats-ui.db';
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
const login = async (p, u, pw='Test1234!') => {
  await p.goto(BASE, { waitUntil:'networkidle2' }); await p.evaluate(()=>{try{localStorage.clear()}catch(_){}});
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
};
const goBoard = async (p) => { await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1100); };
const expand = async (p, pid) => { await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), pid); await sleep(250); };
const hasStatsBtn = (p, pid) => p.evaluate(id => !!document.querySelector(`.proj-tile[data-id="${id}"] .proj-stats-btn`), pid);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/project-stats-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-stats-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'Test1234!', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'Bucha Halter', role:'buchhalter' });
    const m1   = await mk({ username:'m1',    name:'M Eins', role:'mitarbeiter' });
    const proj = (await req('POST','/api/projects', admin, { name:'Bau A', assigned_user_ids:[m1.id] })).body.project;
    const pid = proj.id;
    // Buchungen: m1 (7.5h) + chef (4h)
    await req('POST','/api/entries', await tok('m1'),  { date:'2026-08-01', time_from:'07:00', time_to:'15:00', break_minutes:30, project_id:pid });
    await req('POST','/api/entries', await tok('chef2'), { date:'2026-08-01', time_from:'09:00', time_to:'13:00', break_minutes:0, project_id:pid });
    ok('Setup: Projekt + Buchungen', !!pid);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });

    // ADMIN: Reiter + Tabelle
    await login(p, 'admin', apw); await goBoard(p); await expand(p, pid);
    ok('Admin: „📊 Statistik"-Reiter vorhanden', await hasStatsBtn(p, pid));
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-stats-btn`).click(), pid); await sleep(700);
    const tbl = await p.evaluate(id => { const t = document.querySelector(`.proj-tile[data-id="${id}"] .proj-stats-table`); return t ? t.textContent : ''; }, pid);
    ok('Statistik-Tabelle zeigt Bucher + Gesamt', /M Eins/.test(tbl) && /Chef Zwei/.test(tbl) && /Gesamt/.test(tbl), tbl.replace(/\s+/g,' ').trim());
    ok('Netto-Stunden angezeigt (7:30 für m1)', /7:30/.test(tbl), tbl.replace(/\s+/g,' ').trim());
    ok('CSV-Export-Button in der Statistik vorhanden', await p.evaluate(id => !!document.querySelector(`.proj-tile[data-id="${id}"] .proj-csv-btn`), pid));

    // BUCHHALTER: sieht den Reiter
    await login(p, 'bh'); await goBoard(p); await expand(p, pid);
    ok('Buchhalter: Statistik-Reiter vorhanden', await hasStatsBtn(p, pid));

    // CHEF: sieht den Reiter
    await login(p, 'chef2'); await goBoard(p); await expand(p, pid);
    ok('Chef: Statistik-Reiter vorhanden', await hasStatsBtn(p, pid));

    // NORMALER MITARBEITER: KEIN Reiter
    await login(p, 'm1'); await goBoard(p); await expand(p, pid);
    ok('normaler Mitarbeiter: KEIN Statistik-Reiter', !(await hasStatsBtn(p, pid)));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProject-Stats-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
