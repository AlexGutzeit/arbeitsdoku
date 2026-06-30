// Dokument-Limits-Test: kombinierter /limits-Endpunkt (Validierung + Pro-Datei≤Gesamt) und das
// dynamische Pro-Datei-Upload-Limit (über-/innerhalb). Start: node tests/doc-limits.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3090;
const DB = '/tmp/doc-limits-test.db';

function reqJSON(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// Minimaler multipart/form-data-Upload (Feld 'file' + optionale Textfelder)
function upload(token, filename, contentBuffer, fields) {
  return new Promise((resolve, reject) => {
    const boundary = '----nodeform' + Date.now() + Math.random().toString(16).slice(2);
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`));
    parts.push(contentBuffer);
    parts.push(Buffer.from('\r\n'));
    for (const [k, v] of Object.entries(fields || {})) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(parts);
    const r = http.request({ host:'localhost', port:PORT, path:'/api/documents/upload', method:'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': bodyBuf.length,
      Authorization: 'Bearer ' + token,
    } }, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); r.write(bodyBuf); r.end();
  });
}

// Generischer multipart-Upload an einen beliebigen Pfad/Feldnamen (für Logo/Icon)
function uploadField(token, urlPath, field, filename, contentBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----nodeform' + Date.now() + Math.random().toString(16).slice(2);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuf = Buffer.concat([head, contentBuffer, tail]);
    const r = http.request({ host:'localhost', port:PORT, path:urlPath, method:'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': bodyBuf.length,
      Authorization: 'Bearer ' + token,
    } }, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); r.write(bodyBuf); r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const MB = 1024 * 1024;

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/doc-limits-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await reqJSON('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/doc-limits-srv.log','utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    const login = await reqJSON('POST','/api/auth/login', null, { username:'admin', password:pw });
    const token = login.body && login.body.token;
    ok('Admin-Login', !!token);

    // Default ohne Setzen: fileLimit = 5 MB
    let g = await reqJSON('GET','/api/documents', token);
    ok('GET: Default fileLimit 5 MB', g.body && g.body.storage && g.body.storage.fileLimit === 5*MB, JSON.stringify(g.body && g.body.storage));

    // Beide Limits setzen: Gesamt 500 MB, Datei 1 MB
    let r = await reqJSON('PUT','/api/documents/limits', token, { storageValue:'500', storageUnit:'MB', fileValue:'1', fileUnit:'MB' });
    ok('PUT /limits ok', r.status===200 && r.body.fileLimit===1*MB && r.body.limit===500*MB, JSON.stringify(r.body));
    g = await reqJSON('GET','/api/documents', token);
    ok('GET zeigt neues fileLimit (1 MB)', g.body.storage.fileLimit === 1*MB, String(g.body.storage.fileLimit));

    // Validierung
    r = await reqJSON('PUT','/api/documents/limits', token, { storageValue:'0', storageUnit:'MB', fileValue:'1', fileUnit:'MB' });
    ok('Wert ≤ 0 → 400', r.status===400, String(r.status));
    r = await reqJSON('PUT','/api/documents/limits', token, { storageValue:'10', storageUnit:'MB', fileValue:'20', fileUnit:'MB' });
    ok('Pro-Datei > Gesamt → 400', r.status===400 && /Gesamtlimit/.test(r.body.error||''), JSON.stringify(r.body));

    // Limit wieder auf Gesamt 500 / Datei 1 MB für Upload-Tests
    await reqJSON('PUT','/api/documents/limits', token, { storageValue:'500', storageUnit:'MB', fileValue:'1', fileUnit:'MB' });

    // Upload über dem Pro-Datei-Limit (1,3 MB) → 400 „zu groß"
    const big = Buffer.alloc(Math.round(1.3*MB), 0x41); // 'A'
    let u = await upload(token, 'gross.txt', big);
    ok('Upload > Pro-Datei-Limit → 400 „zu groß"', u.status===400 && /zu groß/.test(u.body && u.body.error || ''), JSON.stringify(u.body));

    // Upload innerhalb des Limits (0,2 MB) → 201
    const small = Buffer.alloc(Math.round(0.2*MB), 0x41);
    u = await upload(token, 'klein.txt', small);
    ok('Upload innerhalb Limit → 201', u.status===201 && u.body.document, JSON.stringify(u.body));

    // ===== Durchsetzung GESAMT-Speicherlimit (Ablage) =====
    // Belegt sind jetzt ~0,2 MB. Limit knapp setzen: Gesamt 1 MB, Pro-Datei 1 MB.
    await reqJSON('PUT','/api/documents/limits', token, { storageValue:'1', storageUnit:'MB', fileValue:'1', fileUnit:'MB' });
    const g0 = await reqJSON('GET','/api/documents', token);
    ok('Belegt < Gesamtlimit vor dem Test', g0.body.storage.used < g0.body.storage.limit, JSON.stringify(g0.body.storage));
    // 0,9 MB: passt pro Datei (≤1 MB), aber 0,2+0,9 = 1,1 > 1 MB Gesamt → muss am Gesamtlimit scheitern
    let over = await upload(token, 'voll.txt', Buffer.alloc(Math.round(0.9*MB), 0x43));
    ok('Upload über Gesamt-Speicherlimit → 400 „Speicherlimit"', over.status===400 && /Speicherlimit/.test(over.body && over.body.error || ''), JSON.stringify(over.body));
    // Limit anheben → derselbe Upload geht jetzt durch (Limit ist dynamisch/scharf)
    await reqJSON('PUT','/api/documents/limits', token, { storageValue:'500', storageUnit:'MB', fileValue:'5', fileUnit:'MB' });
    let now = await upload(token, 'jetzt-ok.txt', Buffer.alloc(Math.round(0.9*MB), 0x43));
    ok('Nach Limit-Erhöhung: gleicher Upload → 201', now.status===201 && now.body.document, JSON.stringify(now.body));

    // ===== Branding-Limit (Logo/App-Icon), Admin-konfigurierbar =====
    // PUT setzt das Limit
    r = await reqJSON('PUT','/api/settings/branding-limit', token, { fileValue:'2', fileUnit:'MB' });
    ok('PUT /branding-limit (2 MB) → 200', r.status===200 && r.body.brandingFileLimit === 2*MB, JSON.stringify(r.body));
    // Clamp nach oben (50 MB)
    r = await reqJSON('PUT','/api/settings/branding-limit', token, { fileValue:'100', fileUnit:'MB' });
    ok('Branding-Limit > 50 MB → auf 50 MB geclampt', r.status===200 && r.body.brandingFileLimit === 50*MB, JSON.stringify(r.body));
    // Ungültig
    r = await reqJSON('PUT','/api/settings/branding-limit', token, { fileValue:'0', fileUnit:'MB' });
    ok('Branding-Limit ≤ 0 → 400', r.status===400, String(r.status));
    // admin-only: Chef bekommt 403
    await reqJSON('POST','/api/users', token, { username:'cheflimit', password:'test', name:'CHEF', role:'chef', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 });
    const cTok = (await reqJSON('POST','/api/auth/login', null, { username:'cheflimit', password:'test' })).body.token;
    r = await reqJSON('PUT','/api/settings/branding-limit', cTok, { fileValue:'3', fileUnit:'MB' });
    ok('Branding-Limit als Chef → 403 (nur Admin)', r.status===403, String(r.status));

    // Logo-Upload gegen das gesetzte Limit (1 MB): groß → 413, klein → 200
    await reqJSON('PUT','/api/settings/branding-limit', token, { fileValue:'1', fileUnit:'MB' });
    const bigLogo = Buffer.alloc(Math.round(1.3*MB), 0x42);
    let lu = await uploadField(token, '/api/settings/logo', 'logo', 'logo.png', bigLogo, 'image/png');
    ok('Logo > Branding-Limit → 413', lu.status===413, JSON.stringify(lu.body));
    const smallLogo = Buffer.from([0x89,0x50,0x4e,0x47, ...new Array(2000).fill(0x42)]); // ~2 KB „PNG"
    lu = await uploadField(token, '/api/settings/logo', 'logo', 'logo.png', Buffer.from(smallLogo), 'image/png');
    ok('Logo innerhalb Branding-Limit → 200', lu.status===200 && lu.body && lu.body.logo, JSON.stringify(lu.body));

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nDoc-Limits: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
