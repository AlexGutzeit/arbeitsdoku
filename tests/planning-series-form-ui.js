// UI-Test: Serie über das Formular anlegen — Wiederholungs-Auswahl, Live-Vorschau, Absenden.
// Start: node tests/planning-series-form-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3174;
const DB = '/tmp/planning-series-form.db';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/planning-series-form-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/planning-series-form-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const anna = (await req('POST','/api/users', admin, { username:'anna', password:'Test1234!', name:'Anna Berg', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:900, height:1150, deviceScaleFactor:2 });
    const errors = [];
    p.on('pageerror', e => errors.push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout:20000 });
    await p.evaluate(()=>{ location.hash='#/planning/new'; }); await sleep(1200);

    ok('Wiederholungs-Auswahl vorhanden', !!(await p.$('#pf-recur')));
    // Mitarbeiter Anna anhaken
    await p.evaluate(id => { const cb = document.querySelector(`input[name="assigned"][value="${id}"]`); if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); } }, anna.id);
    // Wiederholung = wöchentlich
    await p.select('#pf-recur', 'weekly'); await sleep(600);
    const optText = await p.evaluate(() => document.querySelector('#pf-recur option[value="weekly"]').textContent);
    ok('Option-Label dynamisch (Wochentag)', /wöchentlich \(jeden \w+\)/.test(optText), optText);
    ok('Vorschau sichtbar nach Auswahl', await p.evaluate(() => { const b = document.getElementById('pf-recur-preview'); return b && b.style.display !== 'none' && /Nächste:/.test(b.textContent); }));

    // Ende: nach 3 Terminen
    await p.evaluate(() => { const r = document.querySelector('input[name="pfrend"][value="count"]'); r.checked = true; const c = document.getElementById('pf-recur-count'); c.value = '3'; c.dispatchEvent(new Event('input', {bubbles:true})); });
    await sleep(700);
    ok('Vorschau zeigt „3 Termine"', await p.evaluate(() => /3 Termine/.test(document.getElementById('pf-recur-preview').textContent)));
    await p.screenshot({ path:'/tmp/series-form.png' });

    // Absenden
    await p.evaluate(() => document.querySelector('form button[type="submit"]').click());
    await sleep(1400);
    const ents = ((await req('GET','/api/planning', admin)).body.entries || []).filter(e => e.series_id);
    ok('Serie über Formular angelegt (3 Vorkommen)', ents.length === 3, 'entries=' + ents.length);
    ok('alle mit derselben series_id + Anna', new Set(ents.map(e=>e.series_id)).size === 1 && ents.every(e => (e.assigned_users||[]).some(a=>a.user_id===anna.id)));
    ok('keine Konsolen-/Seitenfehler', errors.length === 0, errors.slice(0,3).join(' | '));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPlanning-Series-Form-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
