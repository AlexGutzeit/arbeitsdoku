// UI-Test (Puppeteer) der Zusammenfassungs-Sektion: anlegen (+ mit Name), bearbeiten (Zeit ändern),
// Einzel-Pause, „Alle pausieren", löschen. Da ohne echtes VAPID der aktiv-Zweig der Push-Karte nicht
// erreichbar ist, wird initSummarySection() direkt in einen injizierten Container gerendert (die UI-Logik
// ist identisch). Start: node tests/push-summaries-ui.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3103;
const DB = '/tmp/push-summaries-ui.db';
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
  const lg = fs.openSync('/tmp/push-summaries-ui-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', lg, lg] });
  let browser;
  try {
    for (let i=0;i<50;i++){ try{ const h=await req('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const apw = (fs.readFileSync('/tmp/push-summaries-ui-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];

    browser = await puppeteer.launch({ executablePath:CHROME, headless:'shell', args:['--no-sandbox','--disable-setuid-sandbox'] });
    const p = await browser.newPage(); await p.setViewport({ width:1000, height:1000 });
    await p.goto(BASE, { waitUntil:'networkidle2' });
    await p.waitForSelector('#login-user'); await p.type('#login-user','admin'); await p.type('#login-pass', apw);
    await p.click('#login-form button[type="submit"]'); await p.waitForSelector('a[href="#/planning"]');
    await p.evaluate(() => { location.hash = '#/notifications'; }); await sleep(900);

    // Container injizieren + Sektion rendern (unabhängig vom Push-Aktiv-Status)
    await p.evaluate(async () => {
      const main = document.querySelector('.main') || document.body;
      if (!document.getElementById('summary-section')) {
        const d = document.createElement('div'); d.id = 'summary-section'; d.className = 'summary-section'; main.appendChild(d);
      }
      await initSummarySection();
    });
    await sleep(500);
    ok('Sektion + „+"-Button vorhanden', await p.evaluate(() => !!document.getElementById('sum-add')));

    // Anlegen: + → Formular → Name/Zeit → Speichern
    await p.evaluate(() => document.getElementById('sum-add').click()); await sleep(300);
    ok('Formular geöffnet (Name/Zeit/Kategorien)', await p.evaluate(() => !!document.getElementById('sf-name') && !!document.getElementById('sf-time') && document.querySelectorAll('.sf-cat').length > 0));
    await p.evaluate(() => { document.getElementById('sf-name').value = 'Einkaufen'; const t = document.getElementById('sf-time'); t.value = '17:30'; });
    await p.evaluate(() => document.getElementById('sf-save').click()); await sleep(700);
    let list = await p.evaluate(() => document.querySelector('.summary-list').textContent);
    ok('Plan „Einkaufen" erscheint (17:30)', /Einkaufen/.test(list) && /17:30/.test(list), list);

    // Bearbeiten: Zeit ändern
    await p.evaluate(() => document.querySelector('[data-sum="edit"]').click()); await sleep(300);
    await p.evaluate(() => { document.getElementById('sf-time').value = '18:45'; });
    await p.evaluate(() => document.getElementById('sf-save').click()); await sleep(700);
    list = await p.evaluate(() => document.querySelector('.summary-list').textContent);
    ok('Zeit bearbeitet → 18:45', /18:45/.test(list) && !/17:30/.test(list), list);

    // Einzel-Pause
    await p.evaluate(() => document.querySelector('[data-sum="toggle"]').click()); await sleep(600);
    ok('Plan pausiert (Zeile „paused" + Button „Fortsetzen")', await p.evaluate(() => {
      const row = document.querySelector('.summary-row');
      const btn = document.querySelector('[data-sum="toggle"]');
      return row.classList.contains('paused') && /Fortsetzen/.test(btn.textContent);
    }));

    // Alle pausieren
    await p.evaluate(() => document.getElementById('sum-pause-all').click()); await sleep(600);
    ok('„Alle pausieren" gesetzt (API pausedAll=true)', (await req('GET','/api/push/summaries', (await req('POST','/api/auth/login',null,{username:'admin',password:apw})).body.token)).body.pausedAll === true);

    // Löschen
    await p.evaluate(() => document.querySelector('[data-sum="del"]').click()); await sleep(300);
    await p.evaluate(() => { const b = document.querySelector('.dialog-modal [data-act="ok"]'); if (b) b.click(); }); await sleep(700);
    ok('Plan gelöscht (Liste leer)', await p.evaluate(() => /Noch keine Zusammenfassung/.test(document.querySelector('.summary-list').textContent)));

  } finally { if (browser) await browser.close(); srv.kill('SIGTERM'); }
  console.log(`\nPush-Summaries-UI: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
