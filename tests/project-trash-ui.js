// UI-Test Projekt-Papierkorb: Chef löscht vom Board → Papierkorb→Projekte → Wiederherstellen bzw.
// Endgültig löschen (mit Bestätigung). MA/Buchhalter haben KEINEN Papierkorb→Projekte-Zugang.
// Start: node tests/project-trash-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3135;
const DB = '/tmp/project-trash-ui.db';
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
const go = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await sleep(1000); };
const boardHas = (p, n) => p.evaluate(n => [...document.querySelectorAll('.proj-name')].some(e => e.textContent.trim()===n), n);
const trashHas = (p, id) => p.evaluate(id => !!document.querySelector(`.restore-project[data-id="${id}"]`), id);
const clickOk = async (p) => { await p.evaluate(() => { const b = document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); }); await sleep(700); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/project-trash-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-trash-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const mk = async (o) => (await req('POST','/api/users', admin, { password:'test', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8, ...o })).body.user;
    const chef = await mk({ username:'chef2', name:'Chef Zwei', role:'chef' });
    const bh   = await mk({ username:'bh',    name:'BH', role:'buchhalter' });
    const m1   = await mk({ username:'m1',    name:'M1', role:'mitarbeiter' });
    const proj = (await req('POST','/api/projects', admin, { name:'Bau A', client:'Kunde A' })).body.project;
    const pid = proj.id;
    ok('Setup', !!pid);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });

    // Chef löscht vom Board (soft → Papierkorb)
    await login(p, 'chef2'); await go(p, '#/projects');
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), pid); await sleep(250);
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-del`).click(), pid); await sleep(300);
    await clickOk(p);
    ok('nach Löschen: nicht mehr auf dem Board', !(await boardHas(p, 'Bau A')));
    ok('Papierkorb-Nav „Projekte" für Chef vorhanden', await p.evaluate(() => !!document.querySelector('a[href="#/deleted-projects"]')));

    // Papierkorb → Projekte: Eintrag da → Wiederherstellen
    await go(p, '#/deleted-projects');
    ok('gelöschtes Projekt im Papierkorb', await trashHas(p, pid));
    await p.evaluate(id => document.querySelector(`.restore-project[data-id="${id}"]`).click(), pid); await sleep(300);
    await clickOk(p);
    await go(p, '#/projects');
    ok('nach Wiederherstellen wieder auf dem Board', await boardHas(p, 'Bau A'));

    // Erneut löschen → Endgültig löschen (Purge) mit Bestätigung
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), pid); await sleep(250);
    await p.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"] .proj-del`).click(), pid); await sleep(300);
    await clickOk(p);
    await go(p, '#/deleted-projects');
    ok('wieder im Papierkorb', await trashHas(p, pid));
    await p.evaluate(id => document.querySelector(`.purge-project[data-id="${id}"]`).click(), pid); await sleep(300);
    await clickOk(p);
    ok('nach „Endgültig löschen" weg aus dem Papierkorb', !(await trashHas(p, pid)));

    // Gating: MA + Buchhalter haben keinen Papierkorb→Projekte-Zugang
    await login(p, 'm1'); await sleep(200);
    ok('Mitarbeiter: kein Papierkorb→Projekte-Link', await p.evaluate(() => !document.querySelector('a[href="#/deleted-projects"]')));
    await login(p, 'bh'); await sleep(200);
    ok('Buchhalter: kein Papierkorb→Projekte-Link', await p.evaluate(() => !document.querySelector('a[href="#/deleted-projects"]')));
    await go(p, '#/deleted-projects'); // direkter Aufruf → Redirect (kein Zugriff)
    ok('Buchhalter: direkter Aufruf /deleted-projects → kein Zugriff (redirect)', await p.evaluate(() => !document.querySelector('.purge-project') && !document.querySelector('.restore-project')));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProject-Trash-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
