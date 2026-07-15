// Multi-Client-Live-Test (mehrere Puppeteer-Clients gleichzeitig): Chef legt/erledigt/öffnet einen Auftrag,
// die Boards der anderen (2 Mitarbeiter) aktualisieren sich per SSE OHNE Neuladen.
// Start: node tests/board-live-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3118;
const DB = '/tmp/board-live.db';
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
const HAS = (n) => [...document.querySelectorAll('.proj-name')].some(e => e.textContent.trim() === n);
const NOTHAS = (n) => ![...document.querySelectorAll('.proj-name')].some(e => e.textContent.trim() === n);
async function waitFor(page, fn, arg, timeout=6000) { const s=Date.now(); while(Date.now()-s<timeout){ if(await page.evaluate(fn, arg)) return true; await sleep(250);} return false; }
// Jeder Client bekommt einen ISOLIERTEN Browser-Kontext (eigener localStorage/SSE), sonst teilen
// sich die Seiten das Login.
async function loginPage(browser, u, pw='Test1234!') {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage(); await p.setViewport({ width:1200, height:800 });
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', u); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
  await p.evaluate(() => { location.hash = '#/projects'; }); await sleep(1200); // Board + SSE
  return p;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-live-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-live-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'Test1234!', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const ma  = await mk({ username:'ma',  name:'Mitarbeiter A' });
    const ma2 = await mk({ username:'ma2', name:'Mitarbeiter B' });
    ok('Setup: chef + 2 MA', !!(chef&&ma&&ma2));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    // 3 gleichzeitige Clients, jeder mit eigener SSE-Verbindung
    const pChef = await loginPage(browser, 'chef2');
    const pMa   = await loginPage(browser, 'ma');
    const pMa2  = await loginPage(browser, 'ma2');
    ok('3 Clients gleichzeitig auf dem Board', true);

    // Chef legt per UI (FAB) einen Auftrag an, zugewiesen an beide MA
    await pChef.evaluate(() => document.getElementById('fab-new').click()); await sleep(500);
    await pChef.type('#pf2-name', 'Live Auftrag');
    for (const id of [ma.id, ma2.id]) await pChef.evaluate(i => { const cb=document.querySelector('.pf2-assignee[value="'+i+'"]'); if (cb && !cb.checked) cb.click(); }, id);
    await pChef.evaluate(() => document.getElementById('pf2-save').click()); await sleep(1000);

    const liveMa  = await waitFor(pMa,  HAS, 'Live Auftrag');
    const liveMa2 = await waitFor(pMa2, HAS, 'Live Auftrag');
    ok('MA-A sieht neuen Auftrag LIVE (ohne Reload)', liveMa);
    ok('MA-B sieht neuen Auftrag LIVE (ohne Reload)', liveMa2);

    // Chef erledigt den Auftrag → verschwindet live bei beiden
    const projId = (await req('GET','/api/projects', admin)).body.projects.find(x => x.name==='Live Auftrag').id;
    await pChef.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), projId); await sleep(200);
    await pChef.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-done`).click(), projId); await sleep(300);
    await pChef.evaluate(() => { const b=document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); }); await sleep(600);
    const goneMa  = await waitFor(pMa,  NOTHAS, 'Live Auftrag');
    const goneMa2 = await waitFor(pMa2, NOTHAS, 'Live Auftrag');
    ok('MA-A: erledigter Auftrag verschwindet LIVE', goneMa);
    ok('MA-B: erledigter Auftrag verschwindet LIVE', goneMa2);

    // Chef öffnet ihn wieder (Archiv → reopen) → erscheint live wieder
    await pChef.evaluate(() => document.getElementById('board-archive-toggle').click()); await sleep(800);
    await pChef.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-reopen`).click(), projId); await sleep(700);
    const backMa  = await waitFor(pMa,  HAS, 'Live Auftrag');
    ok('MA-A: wieder geöffneter Auftrag erscheint LIVE erneut', backMa);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Live (Multi-Client): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
