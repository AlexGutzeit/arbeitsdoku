// UI-Test: Der „Planung löschen"-Button IM Bearbeiten-Formular zeigt bei Serienterminen denselben
// Umfang-Dialog (nur dieser / folgende / ganze Serie / beenden) wie das ⋮-Menü; bei normalen Planungen
// nur die einfache Bestätigung.
// Start: node tests/planning-series-editdelete-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3196, DB = '/tmp/planning-series-editdelete.db', BASE = 'http://localhost:' + PORT;
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
const seriesE = async (t, sid) => ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === sid);
const uniq = a => [...new Set(a)];

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-series-editdelete-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-editdelete-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const today = new Date().toISOString().slice(0, 10);
    // Wochenserie count=4 (Einzeltag)
    const s = (await req('POST','/api/planning', admin, { date:today, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    ok('Serie (4 Vorkommen) angelegt', s.count === 4);
    const occs = uniq((await seriesE(admin, s.series_id)).map(e => e.occurrence_date)).sort();
    const occ2 = occs[1];
    const grp2 = (await seriesE(admin, s.series_id)).find(e => e.occurrence_date === occ2).group_id;
    // Normale Einzelplanung
    const normal = (await req('POST','/api/planning', admin, { date:today, time_from:'09:00', time_to:'12:00', client:'Normal', assigned_user_ids:[anna.id] })).body.entry;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:1050 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });

    // Serientermin bearbeiten → „Planung löschen" zeigt Umfang-Dialog
    await p.evaluate(g => { location.hash = '#/planning/edit-group/' + g; }, grp2); await sleep(1400);
    await p.evaluate(() => document.getElementById('delete-planning').click()); await sleep(500);
    const opts = await p.evaluate(() => [...document.querySelectorAll('.modal [data-val]')].map(b => b.dataset.val));
    ok('Formular-Löschen: Umfang-Dialog mit 4 Optionen', JSON.stringify(opts) === JSON.stringify(['occurrence','following','series','stop']), JSON.stringify(opts));
    // „Diesen + alle folgenden" (ab occ2) → occ1 bleibt, Rest weg
    await p.evaluate(() => document.querySelector('.modal [data-val="following"]').click()); await sleep(1500);
    const rest = uniq((await seriesE(admin, s.series_id)).map(e => e.occurrence_date)).sort();
    ok('following ab 2. Vorkommen: nur noch das erste übrig', rest.length === 1 && rest[0] === occs[0], JSON.stringify(rest));

    // Normale Planung bearbeiten → „Planung löschen" zeigt NUR die einfache Bestätigung (kein Scope)
    await p.evaluate(id => { location.hash = '#/planning/edit/' + id; }, normal.id); await sleep(1300);
    await p.evaluate(() => document.getElementById('delete-planning').click()); await sleep(500);
    ok('normale Planung: KEIN Umfang-Dialog (nur Ja/Nein)', await p.evaluate(() => document.querySelectorAll('.modal [data-val]').length === 0 && !!document.querySelector('.modal [data-act="ok"]')));
    await p.evaluate(() => document.querySelector('.modal [data-act="ok"]').click()); await sleep(1200);
    ok('normale Planung gelöscht', !((await req('GET','/api/planning', admin)).body.entries || []).some(e => e.id === normal.id));
    ok('keine JS-Fehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-EditDelete-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
