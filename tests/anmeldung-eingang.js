// Anmelde-Eingang: Eingaben müssen Text sein, der Name kommt gekürzt ins Protokoll, und viele Fehlversuche auf EIN Konto werden gebremst, nicht gesperrt.
//
// Sicherheitsprüfung vom 10.11.2026, P3 und P5:
//   * Ein Objekt statt Text ließ bcrypt werfen → 500 „Interner Serverfehler" für eine falsch gestellte Anfrage.
//   * Ein Benutzername mit 90 000 Zeichen stand nach der Fehlanmeldung vollständig im Audit-Protokoll.
//   * Die Bremse zählte nur je Adresse: von vielen Adressen aus ließ sich ein Konto beliebig oft durchprobieren.
//
// Teil 1 prüft die Bremse als Baustein mit gestellter Uhr, Teil 2 am laufenden Server — jeder
// Versuch dort von einer ANDEREN Adresse, damit nur die Bremse je Konto antworten kann.
//   node tests/anmeldung-eingang.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const { kontobremse } = require('../kontobremse');

const PORT = 3397, DB = '/tmp/anmeldung-eingang.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const LOG = '/tmp/anmeldung-eingang-srv.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

let adresse = 0;
const frisch = () => { adresse++; return `198.51.${100 + Math.floor(adresse / 250)}.${1 + (adresse % 250)}`; };

// Jede Anfrage kommt von einer frischen Adresse (X-Forwarded-For; der Server vertraut einem Proxy).
function req(method, p, { token, body, roh } = {}) {
  return new Promise((resolve) => {
    const data = roh !== undefined ? roh : (body ? JSON.stringify(body) : null);
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': frisch(),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, kopf: res.headers }); }); });
    r.on('error', () => resolve({ status: 0 })); if (data) r.write(data); r.end();
  });
}
const anmelden = (username, password) => req('POST', '/api/auth/login', { body: { username, password } });

function bausteinPruefen() {
  console.log('── Baustein: Bremse mit gestellter Uhr ──');
  let t = 1000000;
  const b = kontobremse({ jetzt: () => t });
  const erste = []; for (let i = 0; i < 5; i++) erste.push(b.anklopfen('pruefling').wartenS);
  ok('fünf Versuche ohne Wartezeit', erste.every(w => w === 0), erste.join(','));
  let r = b.anklopfen('pruefling');
  ok('der sechste sofort danach wartet eine Sekunde', r.wartenS === 1, String(r.wartenS));
  ok('… und meldet sich als „erstmals"', r.erstmals === true);
  r = b.anklopfen('pruefling');
  ok('weiteres Anklopfen in der Pause: nicht noch einmal „erstmals"', r.wartenS === 1 && r.erstmals === false, JSON.stringify(r));
  for (let i = 0; i < 50; i++) b.anklopfen('pruefling');
  t += 999;
  ok('50× Anklopfen verlängert die Pause nicht (noch 1 s nach 999 ms)', b.anklopfen('pruefling').wartenS === 1);
  t += 1;
  ok('nach genau einer Sekunde ist der Weg frei', b.anklopfen('pruefling').wartenS === 0);

  // Die Pause wächst: nach dem 6. Versuch 2 s, dann 4, 8, 16, 32 — und bleibt bei 60 stehen.
  const pausen = [];
  for (let i = 0; i < 9; i++) {
    const w = b.anklopfen('pruefling').wartenS; pausen.push(w);
    t += w * 1000; ok(`  nach ${w} s wieder frei`, b.anklopfen('pruefling').wartenS === 0);
  }
  ok('Pausen verdoppeln sich bis höchstens 60 s', pausen.join(',') === '2,4,8,16,32,60,60,60,60', pausen.join(','));

  ok('ein anderes Konto ist davon unberührt', b.anklopfen('kollegin').wartenS === 0);
  ok('Groß-/Kleinschreibung trennt (wie der Benutzername selbst)', b.anklopfen('Pruefling').wartenS === 0);

  b.erfolg('pruefling');
  const nachErfolg = []; for (let i = 0; i < 5; i++) nachErfolg.push(b.anklopfen('pruefling').wartenS);
  ok('nach der richtigen Anmeldung beginnt der Zähler von vorn', nachErfolg.every(w => w === 0), nachErfolg.join(','));
  ok('… und die Pause wieder bei einer Sekunde', b.anklopfen('pruefling').wartenS === 1);

  t += 15 * 60 * 1000 + 1;
  const nachPause = []; for (let i = 0; i < 5; i++) nachPause.push(b.anklopfen('pruefling').wartenS);
  ok('eine Viertelstunde ohne Versuch: vergessen', nachPause.every(w => w === 0), nachPause.join(','));

  // Der Speicher bleibt begrenzt, auch wenn jemand zehntausende Namen durchprobiert.
  const klein = kontobremse({ jetzt: () => t, maxKonten: 50 });
  for (let i = 0; i < 500; i++) klein.anklopfen('name' + i);
  ok('höchstens so viele Namen gemerkt wie erlaubt', klein.anzahl() <= 50, String(klein.anzahl()));
  ok('der zuletzt gesehene Name ist noch dabei', (() => { for (let i = 0; i < 4; i++) klein.anklopfen('name499'); return klein.anklopfen('name499').wartenS === 1; })());
}

(async () => {
  bausteinPruefen();

  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 60; i++) { if ((await req('GET', '/health')).status === 200) break; await sleep(150); }
    const apw = (fs.readFileSync(LOG, 'utf8').match(/admin\s+->\s+(\S+)/) || [])[1];
    let r = await anmelden('admin', apw);
    const admin = r.body && r.body.token;
    ok('Admin angemeldet', !!admin, String(r.status));
    for (const [username, name] of [['pruefling', 'Paula Prüfling'], ['kollegin', 'Karla Kollegin']]) {
      r = await req('POST', '/api/users', { token: admin, body: { username, name, password: 'Test1234!', role: 'mitarbeiter',
        hours_mon: 8, hours_tue: 8, hours_wed: 8, hours_thu: 8, hours_fri: 8 } });
      if (r.status !== 200 && r.status !== 201) ok('Konto ' + username + ' angelegt', false, r.status + ' ' + JSON.stringify(r.body));
    }
    const audit = async (action) => ((await req('GET', '/api/audit?limit=500&action=' + action, { token: admin })).body || {}).logs || [];

    console.log('── P3: Eingaben, die kein Text sind ──');
    const falsch = [
      ['Benutzername als Objekt', { username: { a: 1 }, password: 'x' }],
      ['Benutzername als Liste', { username: ['admin'], password: 'x' }],
      ['Benutzername als Zahl', { username: 12345, password: 'x' }],
      ['Passwort als Objekt', { username: 'admin', password: { $ne: '' } }],
      ['Passwort als Liste', { username: 'admin', password: ['a', 'b'] }],
      ['Passwort als Zahl', { username: 'admin', password: 12345678 }],
      ['Passwort als Wahrheitswert', { username: 'admin', password: true }],
      ['beides leer', { username: '', password: '' }],
      ['gar nichts', {}],
    ];
    for (const [was, body] of falsch) {
      r = await req('POST', '/api/auth/login', { body });
      ok(`${was} → 400`, r.status === 400 && /erforderlich/.test((r.body || {}).error || ''), r.status + ' ' + JSON.stringify(r.body));
    }
    r = await req('POST', '/api/auth/login', { roh: '[]' });
    ok('Anfrage ist eine Liste statt eines Objekts → 400', r.status === 400, String(r.status));
    r = await req('POST', '/api/auth/login', { roh: 'null' });
    ok('Anfrage ist „null" → 400', r.status === 400, String(r.status));
    ok('für keine dieser Anfragen wurde eine Fehlanmeldung protokolliert', (await audit('login_failed')).length === 0);

    r = await req('PUT', '/api/auth/password', { token: admin, body: { aktuell: { a: 1 }, neu: 'Neu-Passwort1!' } });
    ok('Passwortwechsel mit Objekt als aktuellem Passwort → 400', r.status === 400, r.status + ' ' + JSON.stringify(r.body));
    r = await req('PUT', '/api/auth/password', { token: admin, body: { aktuell: apw, neu: ['Neu-Passwort1!'] } });
    ok('Passwortwechsel mit Liste als neuem Passwort → 400', r.status === 400, r.status + ' ' + JSON.stringify(r.body));
    r = await anmelden('admin', apw);
    ok('das Passwort ist dabei unverändert geblieben', r.status === 200, String(r.status));

    console.log('── P3: Riesenname bläht das Protokoll nicht auf ──');
    const riese = 'R' + 'x'.repeat(89999);
    r = await anmelden(riese, 'irgendwas');
    ok('90 000 Zeichen als Benutzername → 401 wie jeder unbekannte Name', r.status === 401, String(r.status));
    let zeilen = await audit('login_failed');
    const zeile = zeilen.find(z => String(z.username).startsWith('Rxxx'));
    ok('Fehlanmeldung steht im Protokoll', !!zeile);
    ok('der Name ist dort gekürzt (höchstens ~130 Zeichen)', !!zeile && zeile.username.length <= 130, zeile && String(zeile.username.length));
    ok('… mit Hinweis auf die ursprüngliche Länge', !!zeile && /90000 Zeichen/.test(zeile.username), zeile && zeile.username.slice(-30));
    r = await anmelden('pruefling', 'P'.repeat(90000));
    ok('90 000 Zeichen als Passwort → 401, kein Serverfehler', r.status === 401, String(r.status));
    r = await anmelden('pruefling', 'Test1234!');
    ok('ein gewöhnlicher Name wird nicht gekürzt und meldet sich an', r.status === 200, String(r.status));

    console.log('── P5: viele Fehlversuche auf ein Konto, jeder von einer anderen Adresse ──');
    // „max" hat sich eben richtig angemeldet → sein Zähler steht auf null.
    const fehlVorher = (await audit('login_failed')).filter(z => z.username === 'pruefling').length;
    const stati = [];
    for (let i = 1; i <= 5; i++) stati.push((await anmelden('pruefling', 'falsch' + i)).status);
    ok('fünf Fehlversuche → je 401, noch keine Bremse', stati.every(s => s === 401), stati.join(','));
    r = await anmelden('pruefling', 'falsch6');
    ok('der sechste sofort danach → 429', r.status === 429, String(r.status));
    ok('Kennung KONTO_GEBREMST und Wartezeit in Sekunden', (r.body || {}).code === 'KONTO_GEBREMST' && r.body.warten_s === 1, JSON.stringify(r.body));
    ok('Kopfzeile Retry-After: 1', r.kopf['retry-after'] === '1', String(r.kopf['retry-after']));
    ok('Meldung nennt das Konto und die Wartezeit', /für dieses Konto/.test(r.body.error) && /einer Sekunde/.test(r.body.error), r.body.error);
    r = await anmelden('pruefling', 'Test1234!');
    ok('auch das RICHTIGE Passwort wartet in der Pause (sonst verriete die Antwort jeden Treffer)', r.status === 429, String(r.status));
    r = await anmelden('kollegin', 'Test1234!');
    ok('ein anderes Konto meldet sich währenddessen normal an', r.status === 200 && !!r.body.token, String(r.status));
    for (let i = 0; i < 4; i++) await anmelden('pruefling', 'klopf' + i);   // Anklopfen in der Pause
    await sleep(1100);
    r = await anmelden('pruefling', 'Test1234!');
    ok('nach der Sekunde kommt der Richtige hinein — Anklopfen hat die Pause nicht verlängert', r.status === 200 && !!r.body.token, r.status + ' ' + JSON.stringify(r.body && r.body.error));

    const gebremst = (await audit('login_gebremst')).filter(z => z.username === 'pruefling');
    ok('EINE Zeile „gebremst" im Protokoll trotz sechs abgewiesener Versuche', gebremst.length === 1, String(gebremst.length));
    const fehl = (await audit('login_failed')).filter(z => z.username === 'pruefling');
    ok('abgewiesene Versuche zählen nicht als Fehlanmeldung (nur die fünf geprüften)', fehl.length - fehlVorher === 5, String(fehl.length - fehlVorher));

    console.log('── P5: gebremst, nicht gesperrt — die Pause wächst und endet ──');
    const nachErfolg = [];
    for (let i = 1; i <= 5; i++) nachErfolg.push((await anmelden('pruefling', 'wieder' + i)).status);
    ok('nach der richtigen Anmeldung wieder fünf Versuche ohne Bremse', nachErfolg.every(s => s === 401), nachErfolg.join(','));
    await sleep(1100);
    r = await anmelden('pruefling', 'wieder6');
    ok('sechster Fehlversuch nach der Pause → geprüft (401)', r.status === 401, String(r.status));
    r = await anmelden('pruefling', 'wieder7');
    ok('danach zwei Sekunden Pause', r.status === 429 && r.body.warten_s === 2, r.status + ' ' + JSON.stringify(r.body));
    ok('Meldung nennt „2 Sekunden"', /in 2 Sekunden/.test(r.body.error || ''), r.body.error);
    await sleep(2100);
    r = await anmelden('pruefling', 'Test1234!');
    ok('nach den zwei Sekunden ist das Konto wieder frei — keine Sperre', r.status === 200, String(r.status));

    console.log('── P5: die Bremse verrät nicht, welche Namen es gibt ──');
    const unbekannt = [];
    for (let i = 1; i <= 5; i++) unbekannt.push((await anmelden('gibtesnicht', 'falsch' + i)).status);
    r = await anmelden('gibtesnicht', 'falsch6');
    ok('unbekannter Name: fünfmal 401, dann 429 — genau wie ein vorhandener', unbekannt.every(s => s === 401) && r.status === 429,
      unbekannt.join(',') + ' / ' + r.status);
    ok('… mit derselben Kennung und Wartezeit', (r.body || {}).code === 'KONTO_GEBREMST' && r.body.warten_s === 1, JSON.stringify(r.body));

    await sleep(300);
    const protokoll = fs.readFileSync(LOG, 'utf8');
    const fehler = protokoll.split('\n').filter(z => /Login-Fehler|Interner Serverfehler|TypeError|Illegal arguments|ERR_ERL_|ValidationError/.test(z));
    ok('keine Fehlerzeile im Server-Protokoll', fehler.length === 0, fehler.slice(0, 3).join(' | '));
  } catch (e) { ok('Ablauf ohne Ausnahme', false, e && e.stack); }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (_) {} }
  console.log(`\nAnmelde-Eingang: ${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})();
