// UI-Smoke (Puppeteer) für das zweistufige Planungsrecht:
//  1) Mitarbeiter-Formular: „alle" anhaken → „sich" automatisch an + gesperrt; „sich" abwählen → „alle" aus.
//  2) Self-Planer (nur „sich"): Planungsformular zeigt KEINE Mitarbeiter-Auswahl, sondern „Geplant für … (nur du)".
// Start: node tests/self-planning-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3088;
const DB = '/tmp/self-planning-ui.db';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/self-planning-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/self-planning-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    // Self-Planer anlegen (nur „sich")
    await req('POST','/api/users', admin, { username:'self', password:'test', name:'Self Planer', role:'mitarbeiter', can_plan:1, can_plan_all:0, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    ok('Setup: Admin + Self-Planer angelegt', !!admin);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:820 });

    // --- 1) Admin: Mitarbeiter-Formular, Checkbox-Kopplung ---
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/users'; }); await sleep(900);
    await p.waitForSelector('#add-user-btn', { timeout: 8000 });
    // „Neuer Mitarbeiter" öffnen
    await p.evaluate(() => document.getElementById('add-user-btn').click()); await sleep(500);
    await p.waitForSelector('#um-can-plan-all');

    // „alle" anhaken → „sich" automatisch an + gesperrt
    await p.click('#um-can-plan-all'); await sleep(100);
    let st = await p.evaluate(() => ({ self: document.getElementById('um-can-plan').checked, selfDis: document.getElementById('um-can-plan').disabled, all: document.getElementById('um-can-plan-all').checked }));
    ok('„alle" an → „sich" automatisch angehakt', st.self === true, JSON.stringify(st));
    ok('„alle" an → „sich" gesperrt', st.selfDis === true, JSON.stringify(st));

    // „alle" wieder ab → „sich" wieder frei (bleibt angehakt)
    await p.click('#um-can-plan-all'); await sleep(100);
    st = await p.evaluate(() => ({ self: document.getElementById('um-can-plan').checked, selfDis: document.getElementById('um-can-plan').disabled }));
    ok('„alle" ab → „sich" wieder bedienbar', st.selfDis === false, JSON.stringify(st));

    // „sich" abwählen → „alle" muss aus sein (war eh aus) und bleibt aus
    if (st.self) { await p.click('#um-can-plan'); await sleep(100); }
    st = await p.evaluate(() => ({ self: document.getElementById('um-can-plan').checked, all: document.getElementById('um-can-plan-all').checked }));
    ok('„sich" ab → „alle" aus', st.all === false, JSON.stringify(st));

    // Modal schließen
    await p.evaluate(() => document.getElementById('um-cancel')?.click());

    // --- 2) Self-Planer: Planungsformular ohne Mitarbeiter-Auswahl ---
    await p.evaluate(async () => { await fetch('/api/auth/logout', { method:'POST', headers:{ Authorization:'Bearer '+localStorage.getItem('token') } }).catch(()=>{}); localStorage.clear(); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','self'); await p.type('#login-pass','test');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/planning/new'; }); await sleep(900);
    const formState = await p.evaluate(() => ({
      hasForm: !!document.getElementById('planning-form'),
      hasPicker: !!document.querySelector('.planning-user-checkboxes'),
      hasSelfTarget: !!document.querySelector('.planning-self-target'),
      selfText: (document.querySelector('.planning-self-target')||{}).textContent || ''
    }));
    ok('Self-Planer: Planungsformular da', formState.hasForm, JSON.stringify(formState));
    ok('Self-Planer: KEINE Mitarbeiter-Auswahl', formState.hasPicker === false, JSON.stringify(formState));
    ok('Self-Planer: „Geplant für … (nur du)" sichtbar', formState.hasSelfTarget && /nur du/.test(formState.selfText), JSON.stringify(formState));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nSelf-Planning-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
