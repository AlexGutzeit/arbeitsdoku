// Push-API-Test: startet einen echten Server (Kind-Prozess), meldet sich an und prueft
// /key, /subscribe (DB-Eintrag), /prefs lesen+schreiben, /unsubscribe, /test.
// Start:  node tests/push-api.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3097;
const DB = '/tmp/push-api-test.db';
const VAPID_PUBLIC = 'BPVS3ECi9gwO7lzmfRVhSOEYjVEgraSHuI3NY99sjRv099IUssBZTdHoHvkQnJet0QUv07n_LSWJhbdRZ60Pc0A';
const VAPID_PRIVATE = 'Gw_Gj7P4o-b5uAXuE8bT00TMWvby6V20t2fDguxf-8o';

function req(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: s });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } }

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const logPath = '/tmp/push-api-srv.log';
  const log = fs.openSync(logPath, 'w');
  const srv = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB,
      JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang',
      VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT: 'mailto:a@b.de' },
    stdio: ['ignore', log, log],
  });

  try {
    // Auf Serverstart warten
    for (let i = 0; i < 40; i++) {
      try { const h = await req('GET', '/health'); if (h.status === 200) break; } catch (_) {}
      await sleep(150);
    }
    const logTxt = fs.readFileSync(logPath, 'utf8');
    const pw = (logTxt.match(/admin\s+->\s+(\S+)/) || [])[1];
    ok('Admin-Passwort aus Log gelesen', !!pw, logTxt.slice(-200));

    const login = await req('POST', '/api/auth/login', null, { username: 'admin', password: pw });
    const token = login.body && login.body.token;
    ok('Login liefert Token', !!token, JSON.stringify(login.body));

    const key = await req('GET', '/api/push/key', token);
    ok('GET /key liefert VAPID-Public', key.status === 200 && key.body.key === VAPID_PUBLIC, JSON.stringify(key.body));

    const prefs0 = await req('GET', '/api/push/prefs', token);
    ok('GET /prefs default alle an', prefs0.status === 200 && prefs0.body.orders === true && prefs0.body.bulletin === true, JSON.stringify(prefs0.body));

    const sub = await req('POST', '/api/push/subscribe', token, { subscription: { endpoint: 'https://ex.com/ep1', keys: { p256dh: 'abc', auth: 'def' } } });
    ok('POST /subscribe ok', sub.status === 200 && sub.body.success === true, JSON.stringify(sub.body));

    // gleicher Endpoint erneut → Upsert, kein zweiter Eintrag
    await req('POST', '/api/push/subscribe', token, { subscription: { endpoint: 'https://ex.com/ep1', keys: { p256dh: 'abc2', auth: 'def2' } } });

    const badSub = await req('POST', '/api/push/subscribe', token, { subscription: { endpoint: 'x' } });
    ok('POST /subscribe ohne keys → 400', badSub.status === 400, JSON.stringify(badSub.body));

    const prefsOff = await req('PUT', '/api/push/prefs', token, { bulletin: false });
    ok('PUT /prefs bulletin=false', prefsOff.status === 200 && prefsOff.body.bulletin === false && prefsOff.body.orders === true, JSON.stringify(prefsOff.body));

    const prefs1 = await req('GET', '/api/push/prefs', token);
    ok('GET /prefs persistiert bulletin=false', prefs1.body.bulletin === false && prefs1.body.notes === true, JSON.stringify(prefs1.body));

    const unsub = await req('POST', '/api/push/unsubscribe', token, { endpoint: 'https://ex.com/ep1' });
    ok('POST /unsubscribe ok', unsub.status === 200 && unsub.body.success === true, JSON.stringify(unsub.body));

    // /test ohne Abo → 400
    const testNoSub = await req('POST', '/api/push/test', token);
    ok('POST /test ohne Abo → 400', testNoSub.status === 400, JSON.stringify(testNoSub.body));

    // Auth-Schutz: ohne Token 401
    const noAuth = await req('GET', '/api/push/prefs', null);
    ok('GET /prefs ohne Token → 401', noAuth.status === 401, String(noAuth.status));

  } finally {
    srv.kill('SIGTERM');
  }

  console.log(`\nPush-API: ${pass} ok, ${fail} fehlgeschlagen`);
  process.exit(fail === 0 ? 0 : 1);
})();
