// UI-Test: „Auftrag erneut planen" hat heute als Standardtag und ist mit einem Klick speicherbar
// (für normale UND Serien-Planungen). Übernahme der Felder, aber neue Planung ohne Serie.
// Start: node tests/planning-replan-default-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3186, DB = '/tmp/planning-replan-default.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const tok = async (u, pw='Test1234!') => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const countPlan = async (t) => ((await req('GET','/api/planning', t)).body.entries || []).length;

async function replanAndSave(p, admin, id) {
  const before = await countPlan(admin);
  await p.evaluate(x => { location.hash = '#/planning/replan/' + x; }, id); await sleep(1300);
  const date = await p.evaluate(() => document.getElementById('pf-single-date')?.value || null);
  await p.evaluate(() => document.querySelector('form button[type="submit"]').click()); await sleep(1300);
  const hash = await p.evaluate(() => location.hash);
  const after = await countPlan(admin);
  return { date, hash, before, after };
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-replan-default-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-replan-default-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const today = new Date().toLocaleDateString('sv-SE');
    const normal = (await req('POST','/api/planning', admin, { date:today, time_from:'09:00', time_to:'12:00', client:'Schmidt KG', assigned_user_ids:[anna.id] })).body.entry;
    const series = (await req('POST','/api/planning', admin, { date:today, time_from:'07:00', time_to:'15:30', client:'Müller GmbH', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:2 } })).body;
    const seriesEntryId = ((await req('GET','/api/planning', admin)).body.entries.find(e => e.series_id).id);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:900 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });

    // Normale Planung → erneut planen
    const r1 = await replanAndSave(p, admin, normal.id);
    ok('normal: Standardtag = heute', r1.date === today, 'date=' + r1.date);
    ok('normal: mit 1 Klick gespeichert (nicht mehr im Formular)', r1.hash === '#/planning' && r1.after === r1.before + 1, JSON.stringify(r1));

    // Serientermin → erneut planen (neue Planung ohne Serie)
    const r2 = await replanAndSave(p, admin, seriesEntryId);
    ok('Serie: Standardtag = heute', r2.date === today, 'date=' + r2.date);
    ok('Serie: mit 1 Klick gespeichert', r2.hash === '#/planning' && r2.after === r2.before + 1, JSON.stringify(r2));
    // Die zuletzt angelegte Planung ist KEINE Serie
    const last = (await req('GET','/api/planning', admin)).body.entries.filter(e => e.client === 'Müller GmbH' && !e.series_id);
    ok('Serie-„erneut planen" erzeugt normale Planung (ohne series_id)', last.length >= 1);
    ok('keine Konsolen-/Seitenfehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Replan-Default-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
