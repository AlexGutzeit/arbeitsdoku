// UI-Test: Serien-Marker (🔁) + Scope-Dialog beim Löschen (nur dieser / folgende / Serie / beenden).
// Start: node tests/planning-series-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3173;
const DB = '/tmp/planning-series-ui.db';
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
const seriesCount = async (t, sid) => ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === sid).length;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-series-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const today = new Date().toISOString().slice(0, 10);
    // Wöchentliche Serie, Anker heute → erstes Vorkommen ist heute (Tagesansicht zeigt heute).
    const s = (await req('POST','/api/planning', admin, { date:today, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    ok('Serie (4 Vorkommen) angelegt', s.count === 4);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1300, height:1000 });
    const errors = [];
    p.on('pageerror', e => errors.push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    await p.evaluate(()=>{ location.hash='#/planning'; }); await sleep(1500);
    // Tagesansicht sicherstellen
    await p.evaluate(() => { const b = [...document.querySelectorAll('button, a')].find(x => x.textContent.trim() === 'Tag'); if (b) b.click(); });
    await sleep(1000);

    ok('🔁-Marker am Serientermin sichtbar', await p.evaluate(() => !!document.querySelector('.tl-plan-entry .tl-e-time') && /🔁/.test(document.querySelector('.tl-plan-entry').textContent)));

    // ⋮-Menü öffnen → Löschen
    await p.evaluate(() => document.querySelector('.tl-plan-entry .plan-menu-btn').click()); await sleep(300);
    await p.evaluate(() => document.querySelector('.plan-menu-del').click()); await sleep(400);
    const opts = await p.evaluate(() => [...document.querySelectorAll('.modal [data-val]')].map(b => b.dataset.val));
    ok('Scope-Dialog mit 4 Optionen', JSON.stringify(opts) === JSON.stringify(['occurrence','following','series','stop']), JSON.stringify(opts));

    // „Nur diesen Termin" wählen
    await p.evaluate(() => document.querySelector('.modal [data-val="occurrence"]').click());
    await sleep(1200);
    ok('nach „nur diesen": Serie hat noch 3 Vorkommen', (await seriesCount(admin, s.series_id)) === 3, 'count=' + (await seriesCount(admin, s.series_id)));
    ok('keine Konsolen-/Seitenfehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
