// UI-Test (Puppeteer): Empfänger sieht bei einer geteilten Notiz den „Freigabe verlassen"-Button und
// entfernt sie damit aus seiner Liste. Start: node tests/note-leave-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3106;
const DB = '/tmp/note-leave-ui.db';
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/note-leave-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/note-leave-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    const O = (await req('POST','/api/users', admin, { username:'owner', password:'test', name:'OWNER', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const B = (await req('POST','/api/users', admin, { username:'empf', password:'test', name:'EMPF', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    const tO = await tok('owner'), tB = await tok('empf');
    const note = (await req('POST','/api/notes', tO, { title:'Geteilte UI-Notiz', body:'Inhalt' })).body.note;
    await req('PUT','/api/notes/'+note.id+'/shares', tO, { shares:[{ user_id:B.id, permission:'read' }] });
    // B bekommt zusätzlich eine EIGENE Notiz (für den Owner-Filter)
    const ownNote = (await req('POST','/api/notes', tB, { title:'Meine eigene UI-Notiz', body:'X' })).body.note;
    ok('Setup: geteilte Notiz + eigene Notiz für B', !!note.id && !!ownNote.id);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:900 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','empf'); await p.type('#login-pass','test');
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/notes'; }); await sleep(1200);

    const sel = `.note-card[data-id="${note.id}"]`;
    const ownSel = `.note-card[data-id="${ownNote.id}"]`;
    ok('B sieht die geteilte Notiz', await p.evaluate((s) => !!document.querySelector(s), sel));
    ok('„Freigabe verlassen"-Button vorhanden', await p.evaluate((s) => !!document.querySelector(s + ' .note-leave-btn'), sel));

    // Owner-Filter: Eigene → nur eigene Notiz; Freigegeben → nur geteilte Notiz; Alle → beide
    const setOwner = async (v) => { await p.select('#note-filter-owner', v); await sleep(300); };
    await setOwner('own');
    ok('Filter „Eigene": eigene sichtbar, geteilte NICHT', await p.evaluate((o, s) => !!document.querySelector(o) && !document.querySelector(s), ownSel, sel));
    await setOwner('shared');
    ok('Filter „Freigegeben": geteilte sichtbar, eigene NICHT', await p.evaluate((o, s) => !document.querySelector(o) && !!document.querySelector(s), ownSel, sel));
    await setOwner('');
    ok('Filter „Alle": beide sichtbar', await p.evaluate((o, s) => !!document.querySelector(o) && !!document.querySelector(s), ownSel, sel));

    await p.evaluate((s) => document.querySelector(s + ' .note-leave-btn').click(), sel); await sleep(300);
    await p.evaluate(() => { const b = document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); }); await sleep(900);

    ok('Notiz aus B-Liste verschwunden (DOM)', await p.evaluate((s) => !document.querySelector(s), sel));
    ok('Notiz aus B-Liste verschwunden (API)', !((await req('GET','/api/notes', await tok('empf'))).body.notes || []).some(n => n.id === note.id));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nNote-Leave-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
