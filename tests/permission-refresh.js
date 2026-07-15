// Rechte-Aktualisierung ohne Re-Login: Gibt/Entzieht ein Admin das Planungsrecht, muss sich das
// nach F5 (Reload) in der UI zeigen (FAB „+" in der Planung) — nicht erst nach Ab-/Anmelden.
// Start: node tests/permission-refresh.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3083;
const DB = '/tmp/permref-test.db';
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
const planningFab = async (p) => { await p.evaluate(() => { S.planningView='day'; location.hash='#/planning'; }); await sleep(1200); return p.evaluate(() => !!document.getElementById('fab-new')); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/permref-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/permref-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    const U = (await req('POST','/api/users', admin, { username:'reftest', password:'Test1234!', name:'Ref Test', role:'mitarbeiter', can_plan:0, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    ok('Testnutzer angelegt (can_plan=0)', !!(U && U.id));
    const setPlan = (v) => req('PUT','/api/users/'+U.id, admin, { username:'reftest', name:'Ref Test', role:'mitarbeiter', target_hours_per_week:U.target_hours_per_week, start_overtime:0, can_plan:v, can_bulletin:0, can_upload:0 });

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:760 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','reftest'); await p.type('#login-pass','Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');

    ok('vorher: kein FAB (kann nicht planen)', (await planningFab(p)) === false);

    // Admin GIBT Planungsrecht → nur F5 (Reload), KEIN erneutes Login
    await setPlan(1);
    await p.reload({ waitUntil:'networkidle2' }); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);
    ok('nach Recht-GEBEN + F5: FAB erscheint (ohne Re-Login)', (await planningFab(p)) === true);

    // Admin ENTZIEHT Planungsrecht → nur F5
    await setPlan(0);
    await p.reload({ waitUntil:'networkidle2' }); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);
    ok('nach Recht-ENTZIEHEN + F5: FAB verschwindet (ohne Re-Login)', (await planningFab(p)) === false);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPermission-Refresh: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
