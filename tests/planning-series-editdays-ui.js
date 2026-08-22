// UI-Test: In einer mehrtägigen Serie im Bearbeiten-Formular einen Tag löschen und „Diesen + alle
// folgenden" speichern → künftige Vorkommen verlieren den Tag, Vergangenes bleibt.
// Start: node tests/planning-series-editdays-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3194, DB = '/tmp/planning-series-editdays.db', BASE = 'http://localhost:' + PORT;
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
const nextMon = () => { const d = new Date(); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.toLocaleDateString('sv-SE'); };
const addCal = (isoStr, n) => { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-series-editdays-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-editdays-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const MON = nextMon(), TUE = addCal(MON,1), WED = addCal(MON,2);
    const occ2 = addCal(MON,7); const tue2 = addCal(MON,8); // 2. Vorkommen + dessen Dienstag
    // 3-tägige Wochenserie (Mo/Di/Mi), count=4
    const s = (await req('POST','/api/planning', admin, { days:[
      { date:MON, time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:TUE, time_from:'07:00', time_to:'15:30', break_minutes:30 },
      { date:WED, time_from:'07:00', time_to:'15:30', break_minutes:30 },
    ], assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    ok('3-tägige Serie (4 Vorkommen à 3 Tage) angelegt', s.count === 4 && s.days_per_occurrence === 3);
    const es = (await req('GET','/api/planning', admin)).body.entries.filter(e => e.series_id === s.series_id);
    const grp2 = es.find(e => e.occurrence_date === occ2).group_id;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:1100 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    // Occurrence 2 bearbeiten
    await p.evaluate(g => { location.hash = '#/planning/edit-group/' + g; }, grp2); await sleep(1400);
    ok('Bearbeiten: 3 Tage-Zeilen sichtbar', (await p.$$('.plan-day-row')).length === 3);
    // Dienstag-Zeile (des 2. Vorkommens) löschen
    await p.evaluate(t => { const rows=[...document.querySelectorAll('.plan-day-row')]; const tr=rows.find(r=>r.textContent.includes(t.split('-').reverse().join('.'))); if(tr) tr.querySelector('.plan-day-del').click(); }, tue2); await sleep(500);
    ok('nach Löschen noch 2 Tage-Zeilen', (await p.$$('.plan-day-row')).length === 2);
    // Speichern → Scope „Diesen + alle folgenden"
    await p.evaluate(() => document.querySelector('form button[type="submit"]').click()); await sleep(600);
    const hasScope = await p.$('.modal [data-val="following"]');
    ok('Scope-Dialog erscheint', !!hasScope);
    await p.evaluate(() => document.querySelector('.modal [data-val="following"]').click()); await sleep(1600);

    // Prüfen
    const es2 = (await req('GET','/api/planning', admin)).body.entries.filter(e => e.series_id === s.series_id);
    const perOcc = {}; es2.forEach(e => perOcc[e.occurrence_date] = (perOcc[e.occurrence_date] || 0) + 1);
    ok('erste Occurrence behält 3 Tage', perOcc[MON] === 3);
    ok('ab 2. Vorkommen nur noch 2 Tage', perOcc[occ2] === 2 && perOcc[addCal(MON,14)] === 2 && perOcc[addCal(MON,21)] === 2);
    ok('gelöschter Dienstag ab Vorkommen 2 wirklich weg', !es2.some(e => [tue2, addCal(MON,15), addCal(MON,22)].includes(e.date)));
    ok('Dienstag der 1. Occurrence bleibt', es2.some(e => e.date === TUE));
    ok('Serie erhalten', es2.every(e => e.series_id === s.series_id));
    ok('keine JS-Fehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-EditDays-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
