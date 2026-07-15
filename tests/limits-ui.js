// UI-Test (Puppeteer) der Admin-Karte „Speicher- & Größenlimits":
//  - drei Eingaben (Gesamtspeicher, Pro-Datei, Logo/App-Icon) + EIN gemeinsamer Speichern-Button
//  - Speichern persistiert alle drei (Doku-Limits + Branding-Limit) und überlebt einen Reload
//  - Nicht-Admin (Chef) sieht die Limits-Karte NICHT
// Start: node tests/limits-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3100;
const DB = '/tmp/limits-ui.db';
const BASE = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MB = 1024 * 1024, GB = 1024 * MB;
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
function req(method, p, token, body) {
  return new Promise((res, rej) => { const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{ 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } }, x => { let s=''; x.on('data',d=>s+=d); x.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; res({status:x.statusCode, body:j}); }); });
    r.on('error', rej); if (data) r.write(data); r.end(); });
}
async function loginUI(p, user, pass) {
  await p.evaluate(() => { try { localStorage.clear(); } catch(_){} });
  await p.goto(BASE, { waitUntil:'networkidle2' });
  await p.waitForSelector('#login-user');
  await p.type('#login-user', user); await p.type('#login-pass', pass);
  await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]'); await sleep(300);
}
const setVal = (p, id, v) => p.evaluate((id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles:true })); }, id, v);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/limits-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/limits-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await req('POST','/api/auth/login', null, { username:'admin', password:apw })).body.token;
    await req('POST','/api/users', admin, { username:'xchef', password:'Test1234!', name:'XCHEF', role:'chef', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    ok('Setup', !!admin);

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:900, height:1100 });

    // --- Admin: Karte vorhanden, 3 Eingaben + 1 Button ---
    await loginUI(p, 'admin', apw);
    await p.evaluate(() => { location.hash = '#/settings'; }); await sleep(1200);
    await p.waitForSelector('#doc-limit-save');
    const card = await p.evaluate(() => {
      const c = document.getElementById('doc-limit-save').closest('.card');
      return {
        title: (c.querySelector('h2')||{}).textContent || '',
        hasStorage: !!c.querySelector('#doc-limit-value'),
        hasFile: !!c.querySelector('#doc-file-value'),
        hasBrand: !!c.querySelector('#brand-file-value'),
        saveButtons: c.querySelectorAll('button').length,
      };
    });
    ok('Kartentitel „Speicher- & Größenlimits"', /Speicher- & Größenlimits/.test(card.title), JSON.stringify(card));
    ok('Drei Eingaben vorhanden (Gesamt/Pro-Datei/Logo-Icon)', card.hasStorage && card.hasFile && card.hasBrand, JSON.stringify(card));
    ok('Genau EIN Speichern-Button in der Karte', card.saveButtons === 1, JSON.stringify(card));

    // --- Werte setzen + EINMAL speichern ---
    await setVal(p, 'doc-limit-value', '2');
    await p.select('#doc-limit-unit', 'GB');
    await setVal(p, 'doc-file-value', '20');
    await p.select('#doc-file-unit', 'MB');
    await setVal(p, 'brand-file-value', '8');
    await p.select('#brand-file-unit', 'MB');
    await p.click('#doc-limit-save'); await sleep(1500);

    const ds = (await req('GET','/api/documents', admin)).body.storage;
    ok('Gesamtspeicher gespeichert (2 GB)', ds && ds.limit === 2*GB, JSON.stringify(ds && ds.limit));
    ok('Pro-Datei gespeichert (20 MB)', ds && ds.fileLimit === 20*MB, JSON.stringify(ds && ds.fileLimit));
    const setn = (await req('GET','/api/settings', admin)).body.settings;
    ok('Logo/Icon-Limit gespeichert (8 MB)', setn && parseInt(setn.branding_file_limit_bytes,10) === 8*MB, JSON.stringify(setn && setn.branding_file_limit_bytes));

    // --- Persistenz über Reload ---
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(300);
    await p.evaluate(() => { location.hash = '#/settings'; }); await sleep(1200);
    await p.waitForSelector('#brand-file-value');
    const vals = await p.evaluate(() => ({
      storage: document.getElementById('doc-limit-value').value, storageUnit: document.getElementById('doc-limit-unit').value,
      file: document.getElementById('doc-file-value').value,
      brand: document.getElementById('brand-file-value').value,
    }));
    ok('Nach Reload vorbefüllt (2 GB / 20 / 8)', vals.storage==='2' && vals.storageUnit==='GB' && vals.file==='20' && vals.brand==='8', JSON.stringify(vals));

    // --- Nicht-Admin (Chef): keine Limits-Karte ---
    await loginUI(p, 'xchef', 'Test1234!');
    await p.evaluate(() => { location.hash = '#/settings'; }); await sleep(1200);
    const chefSees = await p.evaluate(() => ({ settingsLoaded: !!document.querySelector('.main'), hasLimitCard: !!document.getElementById('doc-limit-save') }));
    ok('Chef: Einstellungen geladen, aber KEINE Limits-Karte', chefSees.settingsLoaded && chefSees.hasLimitCard === false, JSON.stringify(chefSees));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nLimits-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
