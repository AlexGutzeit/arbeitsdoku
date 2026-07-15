// UI-Test: Wiederholung IM Bearbeiten-Formular — normale Planung → Serie machen; Serie umtakten
// (ab hier); Serie-Taktung auf „Keine" → ab hier beenden. Direkt-Navigation (wochenendrobust).
// Start: node tests/planning-series-recur-edit-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3199, DB = '/tmp/planning-recur-edit.db', BASE = 'http://localhost:' + PORT;
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
const plan = async (t) => (await req('GET','/api/planning', t)).body.entries || [];
const uniq = a => [...new Set(a)];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-recur-edit-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-recur-edit-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:1150 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    const selRecur = async (f) => { await p.select('#pf-recur', f); await sleep(500); };
    const setCount = async (n) => { await p.evaluate(v=>{const r=document.querySelector('input[name="pfrend"][value="count"]');r.checked=true;const c=document.getElementById('pf-recur-count');c.value=String(v);c.dispatchEvent(new Event('input',{bubbles:true}));},n); await sleep(400); };
    const submit = async () => { await p.evaluate(()=>document.querySelector('form button[type="submit"]').click()); await sleep(700); };

    // 1) Normale Planung → Serie machen
    const c1 = (await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'C1', assigned_user_ids:[anna.id] })).body.entry;
    await p.evaluate(id => { location.hash = '#/planning/edit/' + id; }, c1.id); await sleep(1300);
    ok('Bearbeiten (normal): Wiederholungs-Auswahl vorhanden', !!(await p.$('#pf-recur')));
    await selRecur('weekly'); await setCount(3); await submit(); await sleep(900);
    const c1e = (await plan(admin)).filter(e => e.client === 'C1');
    ok('normal → Serie: 3 Vorkommen, Original weg', c1e.length === 3 && c1e.every(e => e.series_id) && !c1e.some(e => e.id === c1.id));

    // 2) Serie umtakten (ab hier): wöchentlich → 4. Freitag monatlich ab 24.07.
    const s2 = (await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'C2', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    const grp24 = (await plan(admin)).find(e => e.series_id === s2.series_id && e.occurrence_date === '2026-07-24').group_id;
    await p.evaluate(g => { location.hash = '#/planning/edit-group/' + g; }, grp24); await sleep(1400);
    ok('Bearbeiten (Serie): Taktung vorbelegt = weekly', (await p.evaluate(() => document.getElementById('pf-recur').value)) === 'weekly');
    await selRecur('monthly_weekday'); await setCount(3);
    await submit();
    const scopeOpts = await p.evaluate(() => [...document.querySelectorAll('.modal [data-val]')].map(b => b.dataset.val));
    ok('Umtakten: Ab-wann-Dialog (following/series)', JSON.stringify(scopeOpts) === JSON.stringify(['following','series']), JSON.stringify(scopeOpts));
    await p.evaluate(() => document.querySelector('.modal [data-val="following"]').click()); await sleep(1600);
    const all2 = (await plan(admin)).filter(e => e.client === 'C2');
    const oldOcc = uniq(all2.filter(e => e.series_id === s2.series_id).map(e => e.occurrence_date)).sort();
    const newSid = (all2.find(e => e.series_id && e.series_id !== s2.series_id) || {}).series_id;
    const newOcc = uniq(all2.filter(e => e.series_id === newSid).map(e => e.occurrence_date)).sort();
    ok('Umtakten: alte Serie behält 10./17.07.', JSON.stringify(oldOcc) === JSON.stringify(['2026-07-10','2026-07-17']));
    ok('Umtakten: neue Serie = 4. Freitag (24.07./28.08./25.09.)', JSON.stringify(newOcc) === JSON.stringify(['2026-07-24','2026-08-28','2026-09-25']));

    // 3) Serie-Taktung auf „Keine" → ab hier beenden
    const s3 = (await req('POST','/api/planning', admin, { date:'2026-07-10', time_from:'07:00', time_to:'15:30', client:'C3', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    const grp17 = (await plan(admin)).find(e => e.series_id === s3.series_id && e.occurrence_date === '2026-07-17').group_id;
    await p.evaluate(g => { location.hash = '#/planning/edit-group/' + g; }, grp17); await sleep(1400);
    await p.select('#pf-recur', ''); await sleep(400);
    await p.evaluate(() => document.querySelector('form button[type="submit"]').click()); await sleep(500);
    ok('Keine → Auswahl (ab hier beenden / nur diesen behalten)', (await p.evaluate(() => [...document.querySelectorAll('.modal [data-val]')].map(b=>b.dataset.val))).join(',') === 'stop,keep');
    await p.evaluate(() => document.querySelector('.modal [data-val="stop"]').click()); await sleep(1400);
    const occ3 = uniq((await plan(admin)).filter(e => e.series_id === s3.series_id).map(e => e.occurrence_date)).sort();
    ok('Keine: nur 10./17.07. bleiben (ab 17. beendet)', JSON.stringify(occ3) === JSON.stringify(['2026-07-10','2026-07-17']));

    ok('keine JS-Fehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-Recur-Edit-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
