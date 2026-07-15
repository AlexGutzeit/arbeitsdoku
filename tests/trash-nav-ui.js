// UI-Smoke (Puppeteer): Papierkorb-Navigation je Rolle.
//  - Mitarbeiter: Papierkorb-Gruppe sichtbar mit „Einträge" + „Abwesenheiten", aber OHNE „Mitarbeiter".
//  - Chef: zusätzlich „Mitarbeiter" (ausgestellte).
// Start: node tests/trash-nav-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3095;
const DB = '/tmp/trash-nav-ui.db';
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
const navState = (p) => p.evaluate(() => ({
  group: !!document.getElementById('nav-papierkorb'),
  entries: !!document.querySelector('a[href="#/deleted-entries"]'),
  absences: !!document.querySelector('a[href="#/deleted-absences"]'),
  users: !!document.querySelector('a[href="#/deleted-users"]'),
}));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/trash-nav-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/trash-nav-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    await req('POST','/api/users', admin, { username:'wkr', password:'Test1234!', name:'Worker', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    await req('POST','/api/users', admin, { username:'boss', password:'Test1234!', name:'Boss', role:'chef', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    ok('Setup: Worker + Chef angelegt', !!admin);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:820 });

    // Mitarbeiter
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','wkr'); await p.type('#login-pass','Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);
    let s = await navState(p);
    ok('MA: Papierkorb-Gruppe sichtbar', s.group, JSON.stringify(s));
    ok('MA: „Einträge" + „Abwesenheiten" vorhanden', s.entries && s.absences, JSON.stringify(s));
    ok('MA: KEIN „Mitarbeiter"-Tab', s.users === false, JSON.stringify(s));

    // Chef
    await p.evaluate(() => { localStorage.clear(); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','boss'); await p.type('#login-pass','Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(400);
    s = await navState(p);
    ok('Chef: Papierkorb-Gruppe + alle drei Tabs', s.group && s.entries && s.absences && s.users, JSON.stringify(s));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nTrash-Nav-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
