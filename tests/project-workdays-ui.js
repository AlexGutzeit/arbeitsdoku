// UI-Test: Fälligkeit rechnet in ARBEITSTAGEN — Sa/So UND globale Feiertage zählen nicht.
// Legt einen globalen Feiertag auf einen Wochentag im Fenster und prüft, dass die Badge-Zahl
// = (Wochentage im Zeitraum − 1 Feiertag) ist (heuteabhängig, daher im Test nachgerechnet).
// Start: node tests/project-workdays-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3167;
const DB = '/tmp/project-workdays-ui.db';
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
// Wochentage (Mo–Fr) NACH heute bis einschließlich due — dieselbe Semantik wie workdaysUntil (ohne Feiertage).
function weekdaysExcl(toISO) {
  const a = new Date(); a.setHours(0,0,0,0);
  const b = new Date(toISO + 'T00:00:00');
  let c = 0; const cur = new Date(a); cur.setDate(cur.getDate() + 1);
  while (cur <= b) { const wd = cur.getDay(); if (wd !== 0 && wd !== 6) c++; cur.setDate(cur.getDate() + 1); }
  return c;
}
// Ein Wochentag ~offset Tage voraus (Wochenende überspringen)
function nextWeekday(offset) { const d = new Date(); d.setDate(d.getDate() + offset); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
const badgeText = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .proj-due`); return e ? e.textContent : null; }, id);
const badgeNum = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .proj-due`); if (!e) return null; const m = e.textContent.match(/(\d+)/); return m ? parseInt(m[1], 10) : null; }, id);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/project-workdays-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/project-workdays-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);

    // Globaler Feiertag auf einen Wochentag ~7 Tage voraus (liegt im Fenster bis due=iso(18))
    const holiday = nextWeekday(7);
    const fr = await req('POST','/api/absences', admin, { type:'feiertag', date_from:holiday, date_to:holiday, reason:'Testfeiertag' });
    ok('Feiertag angelegt (' + holiday + ')', fr.status === 201 || fr.status === 200, 'status ' + fr.status);

    const dueISO = iso(18);
    const expWithout = weekdaysExcl(dueISO);      // nur Wochenenden raus
    const expWith = expWithout - 1;               // Feiertag ist ein Wochentag im Fenster → −1

    const pr = (await req('POST','/api/projects', admin, { name:'Arbeitstage-Test', due_date:dueISO })).body.project;
    // Kontrollprojekt mit Frist VOR dem Feiertag → Feiertag NICHT im Fenster, nur Wochenenden zählen nicht
    const beforeISO = nextWeekday(3);
    const ctrlExp = weekdaysExcl(beforeISO);
    const ctrl = (await req('POST','/api/projects', admin, { name:'Kontrolle-vor-Feiertag', due_date:beforeISO })).body.project;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:900 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    await p.evaluate(()=>{ location.hash='#/projects'; }); await sleep(1500);

    const txt = await badgeText(p, pr.id);
    ok('Badge sagt „Arbeitstage" (nicht „Tage")', /Arbeitstage/.test(txt) && !/\bTage\b/.test(txt.replace(/Arbeitstage/g,'')), txt);
    ok('Badge-Zahl < Kalendertage (Wochenenden zählen nicht)', (await badgeNum(p, pr.id)) < 18, 'badge=' + (await badgeNum(p, pr.id)) + ', kal=18');
    ok('Badge-Zahl = Wochentage − 1 Feiertag', (await badgeNum(p, pr.id)) === expWith, `badge=${await badgeNum(p, pr.id)}, erwartet=${expWith} (ohne Feiertag ${expWithout})`);
    ok('Kontrolle (Feiertag außerhalb Fenster): Badge = Wochentage, kein Abzug', (await badgeNum(p, ctrl.id)) === ctrlExp, `badge=${await badgeNum(p, ctrl.id)}, erwartet=${ctrlExp}`);

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nProject-Workdays-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
