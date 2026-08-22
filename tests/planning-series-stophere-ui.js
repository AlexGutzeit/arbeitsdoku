// UI-Test: „Ab hier keine Wiederholung mehr" im Bearbeiten-Formular + geführter Folgeschritt.
// Start: node tests/planning-series-stophere-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3179, DB = '/tmp/planning-series-stophere.db', BASE = 'http://localhost:' + PORT;
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
const seriesN = async (t, sid) => ((await req('GET','/api/planning', t)).body.entries || []).filter(e => e.series_id === sid).length;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-series-stophere-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-stophere-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const today = new Date().toLocaleDateString('sv-SE');
    const s = (await req('POST','/api/planning', admin, { date:today, time_from:'07:00', time_to:'15:30', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:5 } })).body;
    ok('Serie (5 Vorkommen) angelegt', s.count === 5);
    // Gruppe der ersten (heutigen) Occurrence — direkt ins Bearbeiten navigieren (unabhängig vom Wochentag/Tagesansicht)
    const grpToday = ((await req('GET','/api/planning', admin)).body.entries || []).find(e => e.series_id === s.series_id && e.occurrence_date === today).group_id;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:1000 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    await p.evaluate(g => { location.hash = '#/planning/edit-group/' + g; }, grpToday); await sleep(1400);

    ok('Taktung wird angezeigt (Serien-Banner)', await p.evaluate(() => { const b = document.querySelector('.planning-series-banner'); return !!b && /Wiederholung:\s*wöchentlich/.test(b.textContent); }));
    ok('Banner zeigt „Nächste Termine" (Folgedaten)', await p.evaluate(() => { const b = document.querySelector('.planning-series-banner'); return !!b && /Nächste Termine:\s*\d{2}\.\d{2}\.\d{4}/.test(b.textContent); }));
    ok('„Auftrag erneut planen" vorhanden', !!(await p.$('#replan-entry')));
    ok('Button „Ab hier keine Wiederholung mehr" vorhanden', !!(await p.$('#series-stop-here')));
    await p.evaluate(() => document.getElementById('series-stop-here').click()); await sleep(400);
    ok('Sicherheitsabfrage erscheint', !!(await p.$('.modal [data-act="ok"]')));
    await p.evaluate(() => document.querySelector('.modal [data-act="ok"]').click()); await sleep(700);
    const opts = await p.evaluate(() => [...document.querySelectorAll('.modal [data-val]')].map(b => b.dataset.val));
    ok('Folge-Dialog „neue Serie / fertig"', JSON.stringify(opts) === JSON.stringify(['new','done']), JSON.stringify(opts));
    await p.evaluate(() => document.querySelector('.modal [data-val="done"]').click()); await sleep(1200);

    const remainToday = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.date === today);
    ok('Serie ab heute beendet → heutiger Termin bleibt als Einzelplanung (keine series_id, kein 🔁)', remainToday.length === 1 && !remainToday[0].series_id, JSON.stringify(remainToday.map(e=>({d:e.date,s:e.series_id}))));

    // Normale Planung (ohne Serie): kein Serien-Banner, kein „ab hier"-Button, aber „erneut planen" da
    const n = (await req('POST','/api/planning', admin, { date:today, time_from:'08:00', time_to:'16:00', assigned_user_ids:[anna.id] })).body;
    await p.evaluate((id) => { location.hash = '#/planning/edit/' + id; }, n.entry.id); await sleep(1300);
    ok('normale Planung: KEIN Serien-Banner', await p.evaluate(() => !document.querySelector('.planning-series-banner')));
    ok('normale Planung: KEIN „ab hier"-Button', await p.evaluate(() => !document.querySelector('#series-stop-here')));
    ok('normale Planung: „erneut planen" trotzdem da', await p.evaluate(() => !!document.querySelector('#replan-entry')));
    ok('keine Konsolen-/Seitenfehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-StopHere-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
