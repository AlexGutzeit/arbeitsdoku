// Kann sich jemand aussperren? Gegen eine KOPIE der echten Produktivdaten (Alex, 23.08.2026).
//
// Die Zwei-Faktor-Anmeldung ist die einzige Änderung dieser Runde, die jemanden vor der Tür stehen
// lassen KANN. Deshalb wird hier nicht die Mechanik geprüft (das tun twofa-*.js), sondern die
// Frage dahinter: Kommt nach dem Ausrollen noch jeder hinein, und gibt es aus jeder Sackgasse
// einen Weg heraus?
//
// Durchgespielt an den echten Konten:
//   1. Nach dem Update ist NIEMAND betroffen — keine Rolle steht auf Pflicht.
//   2. Jeder aktive Mitarbeiter meldet sich wie bisher an.
//   3. Der Admin kann die Pflicht nicht scharf schalten, ohne seinen Generator zu beweisen.
//   4. Handy weg beim Mitarbeiter → Chef/Admin setzt zurück, er kommt wieder hinein.
//   5. Handy weg beim EINZIGEN Admin → Notfall-Schalter TWOFA_AUS lässt ihn hinein.
//   6. Der letzte Admin lässt sich weder herabstufen noch ausstellen.
//
// Nur lesend gegenüber der Quelle: Es wird eine Kopie angelegt und ausschließlich darauf gearbeitet.
//   node tests/aussperren-prodklon.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const totp = require('../totp');

const QUELLE = process.env.PRODKLON || '/tmp/prodklon.db';
const PORT = 3279, DB = '/tmp/aussperren-klon.db';
const SECRET = 'test-secret-mindestens-32-zeichen-lang';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const anmelden = (u, p = 'test') => req('POST', '/api/auth/login', null, { username: u, password: p });

let srv = null;
async function starten(extra = {}) {
  const lg = fs.openSync('/tmp/aussperren-klon-srv.log', 'a');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: SECRET, ...extra }, stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch');
}
async function stoppen() { if (srv) { srv.kill('SIGTERM'); await sleep(1200); srv = null; } }

(async () => {
  if (!fs.existsSync(QUELLE)) {
    console.log(`Prod-Klon ${QUELLE} fehlt — Test uebersprungen.`);
    process.exit(0);
  }
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync('/tmp/aussperren-klon-srv.log'); } catch (_) {}
  fs.copyFileSync(QUELLE, DB);           // ab hier NUR die Kopie
  try {
    await starten();

    console.log('── 1. Nach dem Update ist niemand betroffen ──');
    const admin = (await anmelden('admin')).body;
    ok('der Admin kommt ohne Code hinein', !!(admin && admin.token), JSON.stringify(admin).slice(0, 90));
    const st = (await req('GET', '/api/settings', admin.token)).body.settings;
    const rollen = ['admin', 'chef', 'buchhalter', 'mitarbeiter'];
    ok('keine Rolle steht auf Pflicht',
      rollen.every(r => (st['twofa_' + r] || 'aus') === 'aus'),
      JSON.stringify(rollen.map(r => r + '=' + (st['twofa_' + r] || 'aus'))));

    console.log('\n── 2. Jeder aktive Mitarbeiter meldet sich an ──');
    const alle = (await req('GET', '/api/users', admin.token)).body.users;
    const aktive = alle.filter(u => u.active !== 0);
    ok('es gibt ueberhaupt Konten zu pruefen', aktive.length >= 5, String(aktive.length));
    const rein = [], draussen = [];
    for (const u of aktive) {
      const a = await anmelden(u.username);
      (a.body && a.body.token ? rein : draussen).push(u.username);
    }
    ok(`alle ${aktive.length} aktiven Konten kommen hinein`, draussen.length === 0, 'draussen: ' + draussen.join(', '));
    const ausgestellt = alle.filter(u => u.active === 0);
    if (ausgestellt.length) {
      const a = await anmelden(ausgestellt[0].username);
      ok(`ein ausgestelltes Konto bleibt draussen (${ausgestellt[0].username})`, a.status === 403, String(a.status));
    } else { ok('kein ausgestelltes Konto im Bestand — nichts zu pruefen', true); }

    console.log('\n── 3. Der Admin kann die Pflicht nicht blind scharf schalten ──');
    let r = await req('PUT', '/api/settings', admin.token, { twofa_admin: 'immer' });
    ok('ohne eigenen Authenticator abgelehnt', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_SELBST_NOETIG', JSON.stringify(r.body));
    const setup = (await req('POST', '/api/auth/2fa/setup', admin.token, {})).body;
    await sleep(30000 - (Date.now() % 30000) + 600);     // frisches Zeitfenster
    const t0 = Date.now();
    await req('POST', '/api/auth/2fa/verify', admin.token, { code: totp.code(setup.geheim, t0 - 30000) });
    r = await req('PUT', '/api/settings', admin.token, { twofa_admin: 'immer', twofa_code: '000000' });
    ok('mit falschem Code abgelehnt', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_CODE_FALSCH', JSON.stringify(r.body));
    r = await req('PUT', '/api/settings', admin.token, { twofa_admin: 'immer', twofa_code: totp.code(setup.geheim, t0) });
    ok('mit gueltigem Code klappt es', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    const nachSchaerfen = await anmelden('admin');
    ok('… und der Admin muss ab jetzt einen Code eingeben',
      nachSchaerfen.body && nachSchaerfen.body.zwei_faktor_erforderlich === true, JSON.stringify(nachSchaerfen.body).slice(0, 90));
    ok('… kommt mit seinem Code aber hinein', (await req('POST', '/api/auth/login/2fa', null, {
      zwischen_token: nachSchaerfen.body.zwischen_token, code: totp.code(setup.geheim, t0 + 30000),
    })).status === 200);

    console.log('\n── 4. Handy weg beim Mitarbeiter ──');
    // Das vorhandene Admin-Token gilt weiter — Scharfschalten wirft niemanden hinaus, wer
    // eingerichtet ist. Genau deshalb wird hier NICHT neu angemeldet: Jede Anmeldung braucht
    // einen Code, und gueltig sind nur die drei Fenster um „jetzt". Fuer die Pflicht der
    // Mitarbeiter nimmt daher der CHEF seinen eigenen Generator — der hat einen eigenen Zaehler.
    const opfer = aktive.find(u => u.role === 'mitarbeiter');
    const adminT = admin.token;
    ok('das Admin-Token gilt nach dem Scharfschalten weiter',
      (await req('GET', '/api/entries', adminT)).status === 200);

    const chefName = (aktive.find(u => u.role === 'chef') || {}).username;
    ok('es gibt einen Chef im Bestand', !!chefName, String(chefName));
    const chefT = (await anmelden(chefName)).body.token;
    const chefSetup = (await req('POST', '/api/auth/2fa/setup', chefT, {})).body;
    await req('POST', '/api/auth/2fa/verify', chefT, { code: totp.code(chefSetup.geheim, t0 - 30000) });
    let rr = await req('PUT', '/api/settings', chefT, { twofa_mitarbeiter: 'immer', twofa_code: totp.code(chefSetup.geheim, t0) });
    ok('der Chef schaltet die Pflicht fuer Mitarbeiter scharf', rr.status === 200, `${rr.status} ${rr.text.slice(0, 80)}`);
    ok('… und sie steht', (await req('GET', '/api/settings', adminT)).body.settings.twofa_mitarbeiter === 'immer');

    // Der Mitarbeiter richtet ein und „verliert" dann sein Handy.
    const oT = (await anmelden(opfer.username)).body.token;
    const oSetup = (await req('POST', '/api/auth/2fa/setup', oT, {})).body;
    await req('POST', '/api/auth/2fa/verify', oT, { code: totp.code(oSetup.geheim) });
    ok(`${opfer.username} hat einen Authenticator`,
      (await req('GET', '/api/auth/2fa/status', oT)).body.zwei_faktor.eingerichtet === true);
    const ohneHandy = await anmelden(opfer.username);
    ok('… und wird beim Anmelden nach dem Code gefragt', ohneHandy.body.zwei_faktor_erforderlich === true);
    ok('… ohne Code kommt er nicht weiter', (await req('POST', '/api/auth/login/2fa', null, {
      zwischen_token: ohneHandy.body.zwischen_token, code: '123456' })).status === 401);
    ok('der Admin setzt zurueck', (await req('POST', `/api/users/${opfer.id}/twofa-reset`, adminT, {})).status === 200);
    const danach = await anmelden(opfer.username);
    ok('… danach kommt er mit Passwort bis zur Einrichtung',
      !!(danach.body && danach.body.token), JSON.stringify(danach.body).slice(0, 80));
    ok('… und wird dort zur Neueinrichtung gefuehrt (403 auf Datenrouten)',
      (await req('GET', '/api/entries', danach.body.token)).status === 403);
    ok('… die Konto-Seite bleibt ihm aber offen',
      (await req('GET', '/api/auth/2fa/status', danach.body.token)).status === 200);

    console.log('\n── 5. Handy weg beim EINZIGEN Admin → Notfall-Schalter ──');
    ok('vorher: der Admin braucht einen Code', (await anmelden('admin')).body.zwei_faktor_erforderlich === true);
    await stoppen();
    await starten({ TWOFA_AUS: '1' });
    const notfall = await anmelden('admin');
    ok('mit TWOFA_AUS=1 kommt er ohne Code hinein', !!(notfall.body && notfall.body.token),
      JSON.stringify(notfall.body).slice(0, 90));
    ok('… und darf sofort arbeiten', (await req('GET', '/api/entries', notfall.body.token)).status === 200);
    ok('… auch der Mitarbeiter ohne Authenticator',
      !!((await anmelden(opfer.username)).body || {}).token);
    ok('… und die Einstellung steht dabei UNVERAENDERT auf Pflicht (nichts wurde geloescht)',
      (await req('GET', '/api/settings', notfall.body.token)).body.settings.twofa_admin === 'immer');
    await stoppen();
    await starten();
    ok('ohne den Schalter greift die Pflicht sofort wieder',
      (await anmelden('admin')).body.zwei_faktor_erforderlich === true);

    console.log('\n── 6. Der letzte Admin bleibt Admin ──');
    await stoppen(); await starten({ TWOFA_AUS: '1' });   // zum Arbeiten am Bestand
    const aT = (await anmelden('admin')).body.token;
    const admins = (await req('GET', '/api/users', aT)).body.users.filter(u => u.role === 'admin' && u.active !== 0);
    ok('es gibt genau EINEN aktiven Admin', admins.length === 1, String(admins.length));
    ok('herabstufen wird verweigert',
      (await req('PUT', `/api/users/${admins[0].id}`, aT, { role: 'chef' })).status >= 400);
    ok('ausstellen wird verweigert',
      (await req('DELETE', `/api/users/${admins[0].id}`, aT)).status >= 400);
    ok('… und er ist immer noch Admin',
      (await req('GET', '/api/users', aT)).body.users.find(u => u.id === admins[0].id).role === 'admin');

  } finally {
    await stoppen();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nAussperren am Prod-Klon: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
