// Backup-Round-Trip + dynamisches Restore-Limit: Backup herunterladen → wieder einspielen (200),
// Daten bleiben erhalten. Stellt sicher, dass das dynamische Restore-Upload-Limit (Speicherlimit +
// Reserve) den normalen Restore nicht bricht. Start: node tests/backup-restore.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3098;
const DB = '/tmp/backup-restore-test.db';

function reqJSON(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host:'localhost', port:PORT, path:p, method, headers:{
      'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}), ...(data?{'Content-Length':Buffer.byteLength(data)}:{}),
    }}, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function getBinary(p, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host:'localhost', port:PORT, path:p, method:'GET', headers:{ Authorization:'Bearer '+token } }, (res) => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject); r.end();
  });
}
function uploadZip(token, buf) {
  return new Promise((resolve, reject) => {
    const boundary = '----nodeform' + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    const r = http.request({ host:'localhost', port:PORT, path:'/api/backup/restore', method:'POST', headers:{
      'Content-Type':'multipart/form-data; boundary='+boundary, 'Content-Length': body.length, Authorization:'Bearer '+token,
    }}, (res) => { let s=''; res.on('data',d=>s+=d); res.on('end',()=>{ let j=null; try{j=JSON.parse(s)}catch(_){}; resolve({status:res.statusCode, body:j}); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ '+n)) : (fail++, console.log('  ✗ '+n+(e?'  → '+e:'')));

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const log = fs.openSync('/tmp/backup-restore-srv.log','w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT:String(PORT), DB_PATH:DB, JWT_SECRET:'test-secret-mindestens-32-zeichen-lang' }, stdio:['ignore', log, log] });
  try {
    for (let i=0;i<40;i++){ try{ const h=await reqJSON('GET','/health'); if(h.status===200) break; }catch(_){}; await sleep(150); }
    const pw = (fs.readFileSync('/tmp/backup-restore-srv.log','utf8').match(/admin\s+->\s+(\S+)/)||[])[1];
    const admin = (await reqJSON('POST','/api/auth/login', null, { username:'admin', password:pw })).body.token;
    ok('Admin-Login', !!admin);

    // Markante Daten anlegen
    const u = (await reqJSON('POST','/api/users', admin, { username:'backuptarget', password:'test', name:'BACKUP-TARGET', role:'mitarbeiter', hours_mon:8,hours_tue:8,hours_wed:8,hours_thu:8,hours_fri:8 })).body.user;
    ok('Testnutzer angelegt', !!(u && u.id));

    // Backup herunterladen (Zip)
    const dl = await getBinary('/api/backup/download', admin);
    const isZip = dl.buf[0] === 0x50 && dl.buf[1] === 0x4B;
    ok('Backup-Download liefert ein Zip', dl.status===200 && isZip, `status=${dl.status}, bytes=${dl.buf.length}`);

    // Backup wieder einspielen (dynamisches Limit, normales Backup → muss durchgehen)
    const rs = await uploadZip(admin, dl.buf);
    ok('Restore des eigenen Backups → 200', rs.status===200 && rs.body && rs.body.success, JSON.stringify(rs.body));

    // Daten noch da?
    await sleep(300);
    const list = await reqJSON('GET','/api/users', admin);
    ok('Nach Restore: Testnutzer noch vorhanden', (list.body.users||[]).some(x => x.username==='backuptarget'), '');

  } finally { srv.kill('SIGTERM'); }
  console.log(`\nBackup-Restore: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail===0?0:1);
})().catch(e => { console.error(e); process.exit(1); });
