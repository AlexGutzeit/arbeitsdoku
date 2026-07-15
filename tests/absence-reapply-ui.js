// UI-Smoke (Puppeteer): Abwesenheits-Papierkorb bietet „Neu beantragen" (kein „Wiederherstellen"),
// und der Klick öffnet das Antragsformular VORBEFÜLLT mit Typ/Datum der gelöschten Abwesenheit.
// Start: node tests/absence-reapply-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3096;
const DB = '/tmp/absence-reapply-ui.db';
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
  const lg = fs.openSync('/tmp/absence-reapply-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<40;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/absence-reapply-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    await req('POST','/api/users', admin, { username:'wkr', password:'Test1234!', name:'Worker', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const tok = (await req('POST','/api/auth/login', null, { username:'wkr', password:'Test1234!' })).body.token;
    // MA legt eine Abwesenheit an und löscht sie (landet im Papierkorb)
    const D = '2026-09-15';
    const a = (await req('POST','/api/absences', tok, { type:'krank', date_from:D, date_to:D })).body.absence;
    await req('DELETE','/api/absences/'+a.id, tok);
    ok('Setup: Abwesenheit angelegt + gelöscht', !!(a && a.id));

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1200, height:820 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','wkr'); await p.type('#login-pass','Test1234!');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/deleted-absences'; }); await sleep(1000);

    const btns = await p.evaluate(() => ({
      reapply: document.querySelectorAll('.reapply-absence').length,
      reapplyText: (document.querySelector('.reapply-absence')||{}).textContent || '',
      restore: document.querySelectorAll('.restore-absence').length,
    }));
    ok('Papierkorb zeigt „Neu beantragen"-Button', btns.reapply === 1 && /Neu beantragen/.test(btns.reapplyText), JSON.stringify(btns));
    ok('Kein „Wiederherstellen"-Button mehr', btns.restore === 0, JSON.stringify(btns));

    // Klick → Antragsformular vorbefüllt
    await p.evaluate(() => document.querySelector('.reapply-absence').click());
    await sleep(500);
    const form = await p.evaluate(() => ({
      overlay: !!document.getElementById('absence-form-overlay'),
      type: (document.getElementById('abs-type')||{}).value || '',
      from: (document.getElementById('abs-from')||{}).value || '',
      to: (document.getElementById('abs-to')||{}).value || '',
      isNew: /eintragen/i.test((document.querySelector('.absence-form-card h3')||{}).textContent || ''),
    }));
    ok('Antragsformular öffnet sich (neuer Antrag)', form.overlay && form.isNew, JSON.stringify(form));
    ok('Vorbefüllt: Typ krank', form.type === 'krank', JSON.stringify(form));
    ok('Vorbefüllt: Datum 2026-09-15', form.from === D && form.to === D, JSON.stringify(form));

    // --- Admin: sieht „Wiederherstellen" statt „Neu beantragen" ---
    await p.evaluate(() => { localStorage.clear(); });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/deleted-absences'; }); await sleep(1000);
    const adminBtns = await p.evaluate(() => ({
      restore: document.querySelectorAll('.restore-absence').length,
      restoreText: (document.querySelector('.restore-absence')||{}).textContent || '',
      reapply: document.querySelectorAll('.reapply-absence').length,
    }));
    ok('Admin: „Wiederherstellen"-Button', adminBtns.restore === 1 && /Wiederherstellen/.test(adminBtns.restoreText), JSON.stringify(adminBtns));
    ok('Admin: KEIN „Neu beantragen"-Button', adminBtns.reapply === 0, JSON.stringify(adminBtns));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nAbsence-Reapply-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
