// UI-Test: Erinnerungs-Punkt im ⋮-Menü der Tagesansicht + Dialog. MA ohne Planungsrecht sieht nur
// „Benachrichtigung"; MA mit Recht Bearbeiten/Löschen/Benachrichtigung; Dialog anlegen/auflisten/löschen
// (mehrere) + Serien-Scope; „Planung" aus → Punkt/Menü weg. S.pushPlanning wird im Test direkt gesetzt
// (echtes Push ist headless nicht verfügbar). Start: node tests/planning-reminders-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const PORT = 3193, DB = '/tmp/planning-reminders-ui.db', BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(d?{'Content-Length':Buffer.byteLength(d)}:{}) } }, x => { let s=''; x.on('data',c=>s+=c); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const tok = async (u, pw) => (await req('POST','/api/auth/login', null, { username:u, password:pw })).body.token;
const nextMon = () => { const d = new Date(); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
async function loginBrowser(p, user, pw) {
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.evaluate(() => { try { localStorage.clear(); } catch (_) {} }); // evtl. Session beenden
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user', { timeout:20000 }); await p.evaluate(()=>{document.querySelector('#login-user').value='';document.querySelector('#login-pass').value='';});
  await p.type('#login-user', user); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
}
// Tagesansicht auf ein bestimmtes Datum + Erinnerungs-Feature erzwingen und neu rendern.
async function showDay(p, iso, planning) {
  await p.evaluate((d, pl) => { S.planningView = 'day'; S.planningDate = new Date(d + 'T12:00:00'); S.pushPlanning = pl; location.hash = '#/planning'; }, iso, planning);
  await sleep(500);
  await p.evaluate(() => renderPlanningContent()); await sleep(900);
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-reminders-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'), env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-reminders-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'annapw', name:'Anna', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const paul = (await req('POST','/api/users', admin, { username:'paul', password:'paulpw', name:'Paul', role:'mitarbeiter', can_plan:1, hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const MON = nextMon();
    // Annas Einzeltermin, Annas Serie, Pauls Einzeltermin (alle am MON)
    const eAnna = (await req('POST','/api/planning', admin, { date:MON, time_from:'07:00', time_to:'15:30', client:'AnnaKunde', assigned_user_ids:[anna.id] })).body.entry;
    const sAnna = (await req('POST','/api/planning', admin, { date:MON, time_from:'16:00', time_to:'17:00', client:'AnnaSerie', assigned_user_ids:[anna.id], recurrence:{ freq:'weekly', end_type:'count', end_count:4 } })).body;
    await req('POST','/api/planning', admin, { date:MON, time_from:'08:00', time_to:'12:00', client:'PaulKunde', assigned_user_ids:[paul.id] });

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1100, height:1200 });
    const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });

    // ===== Anna (kein Planungsrecht) =====
    await loginBrowser(p, 'anna', 'annapw');
    await showDay(p, MON, true);
    // Annas Einzeltermin: ⋮ vorhanden, nur „Benachrichtigung"
    const annaBtn = await p.$('.plan-menu-btn[data-series=""][data-canedit=""][data-remind="1"]');
    ok('Anna: ⋮ am eigenen Termin vorhanden', !!annaBtn);
    await p.evaluate(() => document.querySelector('.plan-menu-btn[data-series=""][data-canedit=""][data-remind="1"]').click()); await sleep(300);
    const annaMenu = await p.evaluate(() => {
      const m = document.querySelector('.plan-action-menu');
      return { remind: !!m.querySelector('.plan-menu-remind'), edit: !!m.querySelector('.plan-menu-edit'), del: !!m.querySelector('.plan-menu-del') };
    });
    ok('Anna: Menü nur „Benachrichtigung" (kein Bearbeiten/Löschen)', annaMenu.remind && !annaMenu.edit && !annaMenu.del, JSON.stringify(annaMenu));

    // Dialog: anlegen (2), auflisten, löschen
    await p.evaluate(() => document.querySelector('.plan-menu-remind').click()); await sleep(400);
    ok('Dialog offen (Vorlauf-Feld + Einheit)', !!(await p.$('#rem-num')) && !!(await p.$('#rem-unit')));
    const addRem = async (num, unit) => { await p.evaluate((n,u)=>{ const nn=document.querySelector('#rem-num'); nn.value=String(n); document.querySelector('#rem-unit').value=u; }, num, unit); await p.evaluate(()=>document.querySelector('#rem-add').click()); await sleep(600); };
    ok('Uhrzeit-Feld mit Beginn-Uhrzeit (07:00) vorbelegt', (await p.$eval('#rem-time', el => el.value)) === '07:00');
    await addRem(1, 'week');
    await addRem(1, 'day');
    ok('zwei Erinnerungen in der Liste', (await p.$$('#rem-list .rem-del')).length === 2);
    // Abend-Erinnerung mit eigener Uhrzeit 18:00
    await p.evaluate(() => { document.querySelector('#rem-num').value='1'; document.querySelector('#rem-unit').value='day'; document.querySelector('#rem-time').value='18:00'; document.querySelector('#rem-add').click(); }); await sleep(700);
    ok('drei Erinnerungen (Liste zeigt „um 18:00")', (await p.$$('#rem-list .rem-del')).length === 3 && /um 18:00/.test(await p.evaluate(()=>document.querySelector('#rem-list').innerHTML)));
    await p.evaluate(() => document.querySelector('#rem-list .rem-del').click()); await sleep(600);
    ok('nach Löschen zwei Erinnerungen', (await p.$$('#rem-list .rem-del')).length === 2);
    await p.evaluate(() => document.querySelector('.modal [data-act="close"]').click()); await sleep(900);
    const annaList = (await req('GET','/api/planning/reminders?entry_id='+eAnna.id, await tok('anna','annapw'))).body.reminders;
    ok('API bestätigt: Anna hat 2 Erinnerungen (eine um 18:00)', annaList.length === 2 && annaList.filter(x=>x.remind_time === '18:00').length === 1);
    // 🔔 in der Tagesansicht am Termin mit aktiver Erinnerung
    ok('Tagesansicht zeigt 🔔 an Annas Termin', /🔔/.test(await p.evaluate(() => { const el=[...document.querySelectorAll('.tl-plan-entry')].find(x=>/AnnaKunde/.test(x.textContent)); return el?el.innerHTML:''; })));

    // Serien-Scope: Erinnerung „ganze Serie"
    const serBtn = await p.$('.plan-menu-btn[data-remind="1"]:not([data-series=""])');
    ok('Anna: ⋮ am Serientermin vorhanden', !!serBtn);
    await p.evaluate(() => document.querySelector('.plan-menu-btn[data-remind="1"]:not([data-series=""])').click()); await sleep(300);
    await p.evaluate(() => document.querySelector('.plan-menu-remind').click()); await sleep(400);
    ok('Serien-Dialog zeigt 3 Scope-Optionen (dieser/folgende/ganze)', (await p.$$('input[name="rem-scope"]')).length === 3);
    await p.evaluate(() => { document.querySelector('input[name="rem-scope"][value="all"]').checked = true; document.querySelector('#rem-num').value='2'; document.querySelector('#rem-unit').value='day'; document.querySelector('#rem-add').click(); }); await sleep(700);
    await p.evaluate(() => document.querySelector('.modal [data-act="close"]').click()); await sleep(200);
    const serList = (await req('GET','/api/planning/reminders?series_id='+sAnna.series_id, await tok('anna','annapw'))).body.reminders;
    ok('API bestätigt: Serien-Erinnerung (ganze Serie) angelegt', serList.length === 1 && serList[0].target_type === 'series' && serList[0].from_occurrence === null);

    // 🔔 auch in der Wochenansicht
    await p.evaluate(() => { S.planningView = 'week'; renderPlanningContent(); }); await sleep(900);
    ok('Wochenansicht zeigt 🔔', /🔔/.test(await p.evaluate(() => { const el=[...document.querySelectorAll('.grid-plan-entry')].find(x=>/AnnaKunde/.test(x.textContent)); return el?el.innerHTML:''; })));

    // „Planung" aus → Annas ⋮ verschwindet
    await showDay(p, MON, false);
    ok('Anna: mit „Planung" aus kein ⋮ mehr', !(await p.$('.plan-menu-btn[data-canedit=""]')));

    // ===== Paul (mit Planungsrecht) =====
    await loginBrowser(p, 'paul', 'paulpw');
    await showDay(p, MON, true);
    const paulBtn = await p.$('.plan-menu-btn[data-canedit="1"][data-remind="1"]');
    ok('Paul: ⋮ vorhanden (edit + remind)', !!paulBtn);
    await p.evaluate(() => document.querySelector('.plan-menu-btn[data-canedit="1"][data-remind="1"]').click()); await sleep(300);
    const paulMenu = await p.evaluate(() => { const m = document.querySelector('.plan-action-menu'); return { remind: !!m.querySelector('.plan-menu-remind'), edit: !!m.querySelector('.plan-menu-edit'), del: !!m.querySelector('.plan-menu-del') }; });
    ok('Paul: Menü Bearbeiten + Löschen + Benachrichtigung', paulMenu.remind && paulMenu.edit && paulMenu.del, JSON.stringify(paulMenu));
    // „Planung" aus → ⋮ bleibt (Bearbeiten), aber ohne Benachrichtigung
    await p.evaluate(() => document.body.click()); await sleep(200);
    await showDay(p, MON, false);
    await p.evaluate(() => document.querySelector('.plan-menu-btn[data-canedit="1"]').click()); await sleep(300);
    const paulMenu2 = await p.evaluate(() => { const m = document.querySelector('.plan-action-menu'); return { remind: !!m.querySelector('.plan-menu-remind'), edit: !!m.querySelector('.plan-menu-edit') }; });
    ok('Paul: „Planung" aus → Bearbeiten bleibt, Benachrichtigung weg', paulMenu2.edit && !paulMenu2.remind, JSON.stringify(paulMenu2));

    ok('keine JS-Fehler', errors.length === 0, errors.slice(0,3).join(' | '));
  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Reminders-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
