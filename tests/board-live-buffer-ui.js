// Live-Test (3 Browser): ändert Client A einen Zielstatus, müssen Client B und C OHNE Reload
// den Fortschrittsbalken UND das hellblaue Luft-Segment (Puffer) live nachziehen (SSE 'projects').
// Start: node tests/board-live-buffer-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3164;
const DB = '/tmp/board-live-buffer.db';
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
const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
// Datum exakt k Arbeitstage (Mo–Fr) nach heute — Wochenenden überspringen (available = k, laufunabhängig).
const dueInWorkdays = k => { const d = new Date(); let c = 0; while (c < k) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) c++; } return d.toLocaleDateString('sv-SE'); };
// Breite des hellblauen Luft-Segments am schlanken (eingeklappten) Balken
const bufSlim = (p, id) => p.evaluate(id => { const e = document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim .ms-buffer`); return e ? parseFloat(e.style.width) : 0; }, id);
// Breite des grünen (erledigt) Segments = 1. Span am schlanken Balken
const doneSlim = (p, id) => p.evaluate(id => { const b = document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim`); return b ? parseFloat(b.children[0].style.width) : 0; }, id);
async function loginPage(browser, base, user, pw) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user'); await p.type('#login-user', user); await p.type('#login-pass', pw);
  await p.click('#login-form button[type="submit"]');
  await p.waitForFunction(() => !document.querySelector('#login-user'), { timeout: 20000 }); // eingeloggt (rollenunabhängig)
  await sleep(200);
  await p.evaluate(() => { location.hash = '#/projects'; });
  await p.waitForSelector('.board-col', { timeout: 20000 }); await sleep(700);
  return p;
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/board-live-buffer-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/board-live-buffer-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = await tok('admin', apw);
    await req('POST','/api/users', admin, { username:'chefliv', password:'Test1234!', name:'Chefin Live', role:'chef', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const jakob = (await req('POST','/api/users', admin, { username:'jakobliv', password:'Test1234!', name:'Jakob Wolf', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    // Frist in 30 ARBEITSTAGEN, 2 offene Ziele à 10 AT → Rest 20 AT, Puffer vorhanden (Luft ~33%).
    // Nach „Ziel 1 erledigt": Rest 10 AT → mehr Luft (~50%) + grünes Segment erscheint.
    const pr = (await req('POST','/api/projects', admin, { name:'Live-Balken', assigned_user_ids:[jakob.id], due_date:dueInWorkdays(30), milestones:[{title:'Ziel 1', est_days:10},{title:'Ziel 2', est_days:10}] })).body.project;
    const mid1 = pr.milestones[0].id;

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    // 3 isolierte Browser-Kontexte (getrennte Sessions): A=admin (ändert), B=chef, C=jakob (beobachten)
    const A = await loginPage(browser, BASE, 'admin', apw);
    const B = await loginPage(browser, BASE, 'chefliv', 'Test1234!');
    const C = await loginPage(browser, BASE, 'jakobliv', 'Test1234!');

    const buf0B = await bufSlim(B, pr.id), buf0C = await bufSlim(C, pr.id);
    ok('B: Luft anfangs vorhanden (~33%)', buf0B > 25 && buf0B < 42, 'buf=' + buf0B);
    ok('C: Luft anfangs vorhanden (~33%)', buf0C > 25 && buf0C < 42, 'buf=' + buf0C);
    ok('B: grünes Segment anfangs 0', (await doneSlim(B, pr.id)) === 0);

    // Client A ändert „Ziel 1" auf erledigt — über die UI (löst API-PATCH + SSE-Broadcast aus)
    await A.evaluate(id => document.querySelector(`.proj-tile[data-id="${id}"]`).click(), pr.id); await sleep(300);
    await A.evaluate((id, mid) => document.querySelector(`.proj-tile[data-id="${id}"] .ms-opt[data-mid="${mid}"][data-status="done"]`).click(), pr.id, mid1);

    // B und C dürfen NICHT neu geladen werden — nur SSE
    await sleep(1500);

    const buf1B = await bufSlim(B, pr.id), buf1C = await bufSlim(C, pr.id);
    const doneB = await doneSlim(B, pr.id), doneC = await doneSlim(C, pr.id);
    ok('B: Luft LIVE gewachsen (~50%)', buf1B > buf0B + 8, `${buf0B} → ${buf1B}`);
    ok('C: Luft LIVE gewachsen (~50%)', buf1C > buf0C + 8, `${buf0C} → ${buf1C}`);
    ok('B: grünes (erledigt) Segment LIVE erschienen', doneB > 0, 'done=' + doneB);
    ok('C: grünes (erledigt) Segment LIVE erschienen', doneC > 0, 'done=' + doneC);

    // Gegenprobe: due_date entfernen → Luft/Frist-Marker verschwinden live bei B/C
    await req('PUT','/api/projects/' + pr.id, admin, { due_date:'' });
    await sleep(1500);
    ok('B: nach Frist-Entfernung KEINE Luft mehr (live)', (await bufSlim(B, pr.id)) === 0);
    ok('C: nach Frist-Entfernung KEIN Frist-Marker mehr (live)', await C.evaluate(id => !document.querySelector(`.proj-tile[data-id="${id}"] .ms-bar-slim .ms-goal`), pr.id));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nBoard-Live-Buffer (3 Browser): ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
