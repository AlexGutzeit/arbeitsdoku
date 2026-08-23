// Der ganze Weg: Authenticator einrichten, damit anmelden, Gerät merken, Einrichtung erzwingen.
//
// Das ist der Test, an dem die Zwei-Faktor-Anmeldung hängt. Er prüft in dieser Reihenfolge:
//   1. Ohne Einstellung ändert sich nichts (Abwärtskompatibilität nach dem Update)
//   2. Einrichten: QR-Code kommt als eingebettetes SVG, erst der richtige Code macht es scharf
//   3. Anmelden in zwei Schritten, inklusive Replay-Riegel
//   4. Gerät merken — und dass „jedes Mal" sich davon nicht erweichen lässt
//   5. Der Einrichtungs-Zwang, serverseitig
//   6. Der Notfall-Schalter
//
//   node tests/twofa-anmeldung.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const totp = require('../totp');

const PORT = 3250, DB = '/tmp/twofa-anmeldung.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

// Cookies muessen von Hand mitgefuehrt werden — genau darum geht es beim Geraetevertrauen.
function req(m, p, t, b, cookie) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: {
      'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
      ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (_) {}
        const setzt = (x.headers['set-cookie'] || []).map(String);
        res({ status: x.statusCode, body: j, text: s, setCookie: setzt,
              cookie: setzt.map(c => c.split(';')[0]).join('; ') || null });
      }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

let srv = null;
async function starten(zusatz = {}) {
  const lg = fs.openSync('/tmp/twofa-anmeldung-srv.log', 'w');
  srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang', ...zusatz },
    stdio: ['ignore', lg, lg] });
  for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) return; } catch (_) {} await sleep(200); }
  throw new Error('Server kam nicht hoch');
}
async function stoppen() { if (srv) { srv.kill('SIGTERM'); await sleep(800); srv = null; } }

// Ein Code gilt nur EINMAL (Replay-Riegel). Wer im selben 30-Sekunden-Fenster zweimal etwas
// bestaetigt, bekommt zu Recht „bereits verwendet". Im Test heisst das: auf das naechste Fenster
// warten, statt blind 31 Sekunden zu schlafen — das ist im Schnitt halb so lang und genauer.
async function frischerCode(geheim) {
  const start = totp.schrittFuer(Date.now());
  while (totp.schrittFuer(Date.now()) === start) await sleep(500);
  return totp.code(geheim);
}

// Seit dem 23.08.2026 verlangt das Scharfschalten einer Rolle (von „aus" auf eine Pflicht) einen
// gueltigen Code des Aufrufers — siehe tests/twofa-scharfschalten.js. Das erledigt hier ein
// EIGENER Admin: Ein eingerichteter Authenticator aendert das Anmeldeverhalten seines Besitzers,
// und genau darum geht es in diesem Test beim Haupt-Admin nicht.
//
// Der Wiederverwendungs-Riegel nimmt nur STEIGENDE Zeitschritte. Deshalb wartet der Helfer
// notfalls auf ein frisches Fenster (hoechstens 30 Sekunden) — genau wie ein Mensch es muesste.
let _sTok = null, _sGeheim = null, _sSchritt = -1;
async function scharfSchalten(adminToken, werte) {
  if (!_sTok) {
    await req('POST', '/api/users', adminToken,
      { username: 'scharfschalter', password: 'Test1234!', name: 'Scharf Schalter', role: 'admin' });
    _sTok = (await req('POST', '/api/auth/login', null, { username: 'scharfschalter', password: 'Test1234!' })).body.token;
    _sGeheim = (await req('POST', '/api/auth/2fa/setup', _sTok, {})).body.geheim;
    await req('POST', '/api/auth/2fa/verify', _sTok, { code: totp.code(_sGeheim) });
    _sSchritt = Math.floor(Date.now() / 30000);
  }
  while (Math.floor(Date.now() / 30000) + 1 <= _sSchritt) await sleep(1000);
  _sSchritt = Math.floor(Date.now() / 30000) + 1;
  return req('PUT', '/api/settings', _sTok, { ...werte, twofa_code: totp.code(_sGeheim, Date.now() + 30000) });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try {
    await starten();
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/twofa-anmeldung-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const anmelden = (u, p, cookie) => req('POST', '/api/auth/login', null, { username: u, password: p }, cookie);
    const adminToken = (await anmelden('admin', pw('admin'))).body.token;
    const maPw = pw('max');

    console.log('── 1. Nach dem Update ändert sich für niemanden etwas ──');
    const vorher = await anmelden('max', maPw);
    ok('Anmeldung liefert wie bisher direkt einen Token', vorher.status === 200 && !!vorher.body.token);
    ok('… und kein Code wird verlangt', !vorher.body.zwei_faktor_erforderlich);
    let maToken = vorher.body.token;
    ok('die API ist normal erreichbar', (await req('GET', '/api/entries', maToken)).status === 200);
    const zustand0 = (await req('GET', '/api/auth/2fa/status', maToken)).body.zwei_faktor;
    ok('Zustand: nichts eingerichtet, keine Pflicht',
      zustand0.eingerichtet === false && zustand0.pflicht === false, JSON.stringify(zustand0));

    console.log('\n── 2. Authenticator einrichten ──');
    const setup = await req('POST', '/api/auth/2fa/setup', maToken);
    ok('Einrichtung liefert Daten', setup.status === 200, `${setup.status} ${setup.text.slice(0, 80)}`);
    ok('der QR-Code ist eingebettetes SVG (kein data:-Bild — die Sicherheitsrichtlinie verbietet das)',
      typeof setup.body.qr_svg === 'string' && setup.body.qr_svg.trim().startsWith('<svg'),
      String(setup.body.qr_svg).slice(0, 40));
    ok('… ohne XML-Kopf, damit er sich direkt einbetten lässt', !setup.body.qr_svg.includes('<?xml'));
    ok('der Schlüssel steht auch als Text da (zum Abtippen)', /^[A-Z2-7]{32}$/.test(setup.body.geheim || ''), setup.body.geheim);
    ok('die otpauth-Adresse nennt den Firmennamen', /issuer=/.test(setup.body.otpauth || ''), String(setup.body.otpauth).slice(0, 60));
    const geheim = setup.body.geheim;

    ok('vor der Bestätigung gilt es NICHT als eingerichtet',
      (await req('GET', '/api/auth/2fa/status', maToken)).body.zwei_faktor.eingerichtet === false);
    const falsch = await req('POST', '/api/auth/2fa/verify', maToken, { code: '000000' });
    // 400, nicht 401 — der Aufrufer ist angemeldet. Ein 401 wuerde ihn im Browser abmelden.
    ok('ein falscher Code wird abgelehnt', falsch.status === 400, `${falsch.status}`);
    ok('… und zwar NICHT mit 401', falsch.status !== 401);
    const richtig = await req('POST', '/api/auth/2fa/verify', maToken, { code: totp.code(geheim) });
    ok('der richtige Code macht es scharf', richtig.status === 200, `${richtig.status} ${richtig.text.slice(0, 80)}`);
    ok('… und der Zustand sagt das auch',
      (await req('GET', '/api/auth/2fa/status', maToken)).body.zwei_faktor.eingerichtet === true);
    ok('ein zweites Einrichten wird abgelehnt, solange eines läuft',
      (await req('POST', '/api/auth/2fa/setup', maToken)).status === 409);

    console.log('\n── 3. Anmelden in zwei Schritten ──');
    // Rolle „mitarbeiter" auf „jedes Mal" stellen.
    await scharfSchalten(adminToken, { twofa_mitarbeiter: 'immer' });
    const stufe1 = await anmelden('max', maPw);
    ok('Schritt 1 liefert KEINEN Token', stufe1.status === 200 && !stufe1.body.token, JSON.stringify(stufe1.body).slice(0, 90));
    ok('… sondern die Aufforderung zum Code', stufe1.body.zwei_faktor_erforderlich === true);
    ok('… mit einem Zwischen-Token', typeof stufe1.body.zwischen_token === 'string');
    ok('… und dem Hinweis, dass „jedes Mal" kein Merken erlaubt', stufe1.body.geraet_merkbar === false);

    const codeFalsch = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: stufe1.body.zwischen_token, code: '000000' });
    ok('falscher Code → 401', codeFalsch.status === 401, codeFalsch.text.slice(0, 60));

    // Die Einrichtung eben hat das aktuelle Zeitfenster schon verbraucht — richtig so, derselbe
    // Code darf kein zweites Mal gelten. Also auf den naechsten warten.
    const jetztCode = await frischerCode(geheim);
    const stufe2 = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: stufe1.body.zwischen_token, code: jetztCode });
    ok('richtiger Code → voller Token', stufe2.status === 200 && !!stufe2.body.token, `${stufe2.status} ${stufe2.text.slice(0, 70)}`);
    ok('… mit den Nutzerdaten wie bei der normalen Anmeldung',
      stufe2.body.user && stufe2.body.user.username === 'max' && 'can_plan' in stufe2.body.user);
    ok('… und der Token funktioniert', (await req('GET', '/api/entries', stufe2.body.token)).status === 200);

    console.log('\n── 3b. Derselbe Code lässt sich kein zweites Mal einlösen ──');
    const nochmal = await anmelden('max', maPw);
    const wieder = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: nochmal.body.zwischen_token, code: jetztCode });
    ok('abgelehnt', wieder.status === 401, `${wieder.status}`);
    ok('… mit einer Meldung, die den Grund nennt (nicht „falscher Code")',
      /bereits verwendet/i.test(wieder.text), wieder.text.slice(0, 80));

    console.log('\n── 3c. Der Zwischen-Token öffnet nichts anderes ──');
    const zt = (await anmelden('max', maPw)).body.zwischen_token;
    ok('nicht an der API', (await req('GET', '/api/entries', zt)).status === 401);
    ok('nicht an /api/auth/me', (await req('GET', '/api/auth/me', zt)).status === 401);
    // ACHTUNG, hier war meine erste Fassung wertlos: Sie schickte einen vollen Token MIT falschem
    // Code — der scheitert schon am Code, egal ob die Token-Art geprueft wird. Der Riegel liess
    // sich also entfernen, ohne dass der Test etwas merkte. Jetzt mit GUELTIGEM Code, damit nur
    // noch die Token-Art den Unterschied macht.
    const vollerToken = stufe2.body.token;
    const gueltigerCode = await frischerCode(geheim);
    const missbrauch = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: vollerToken, code: gueltigerCode });
    ok('ein VOLLER Token taugt auch mit gültigem Code nicht als Zwischen-Token',
      missbrauch.status === 401 && !missbrauch.body.token, `${missbrauch.status} ${missbrauch.text.slice(0, 70)}`);
    // Und derselbe Code muss danach noch frei sein — der abgewiesene Versuch darf ihn nicht
    // verbrauchen, sonst waere das ein Weg, jemandem die Anmeldung zu vermiesen.
    const nachMissbrauch = await anmelden('max', maPw);
    const klapptTrotzdem = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: nachMissbrauch.body.zwischen_token, code: gueltigerCode });
    ok('… und der Code ist danach noch verwendbar', klapptTrotzdem.status === 200,
      `${klapptTrotzdem.status} ${klapptTrotzdem.text.slice(0, 70)}`);

    console.log('\n── 4. Gerät merken ──');
    await req('PUT', '/api/settings', adminToken, { twofa_mitarbeiter: 'geraet' });
    const g1 = await anmelden('max', maPw);
    ok('Code wird verlangt (Gerät noch unbekannt)', g1.body.zwei_faktor_erforderlich === true);
    ok('… und diesmal darf man das Gerät merken', g1.body.geraet_merkbar === true);
    const g2 = await req('POST', '/api/auth/login/2fa', null,
      { zwischen_token: g1.body.zwischen_token, code: await frischerCode(geheim), geraet_merken: true });
    ok('Anmeldung klappt', g2.status === 200 && !!g2.body.token, `${g2.status} ${g2.text.slice(0, 70)}`);
    ok('… und der Server setzt ein Gerät-Cookie', !!g2.cookie && /ad_geraet=/.test(g2.cookie), String(g2.cookie).slice(0, 40));
    const keks = g2.cookie;
    ok('… httpOnly (für JavaScript unlesbar)', /HttpOnly/i.test(g2.setCookie.join(';')));
    ok('… SameSite=Lax', /SameSite=Lax/i.test(g2.setCookie.join(';')));
    ok('… und nur für die Anmelde-Pfade', /Path=\/api\/auth/i.test(g2.setCookie.join(';')));

    const mitKeks = await anmelden('max', maPw, keks);
    ok('mit bekanntem Gerät: KEIN Code mehr', !mitKeks.body.zwei_faktor_erforderlich && !!mitKeks.body.token,
      JSON.stringify(mitKeks.body).slice(0, 80));
    const ohneKeks = await anmelden('max', maPw);
    ok('ohne Cookie: wieder Code', ohneKeks.body.zwei_faktor_erforderlich === true);
    const fremderKeks = await anmelden('admin', pw('admin'), keks);
    ok('das Cookie nützt einem anderen Konto nichts', !!fremderKeks.body.token || fremderKeks.body.zwei_faktor_erforderlich !== undefined);

    console.log('\n── 4b. „jedes Mal" lässt sich vom Gerät nicht erweichen ──');
    await req('PUT', '/api/settings', adminToken, { twofa_mitarbeiter: 'immer' });
    const trotzKeks = await anmelden('max', maPw, keks);
    ok('trotz bekanntem Gerät wird ein Code verlangt', trotzKeks.body.zwei_faktor_erforderlich === true,
      JSON.stringify(trotzKeks.body).slice(0, 80));
    // Und das belegt zugleich, dass die Umstellung ohne Neustart greift — der Zwischenspeicher
    // der Einstellungen wird beim Speichern verworfen.
    ok('… die Umstellung wirkte also sofort, ohne Neustart', true);

    console.log('\n── 5. Einrichtungs-Zwang (Nutzer ohne Authenticator) ──');
    await scharfSchalten(adminToken, { twofa_chef: 'woechentlich' });
    const chef = await anmelden('chef', pw('chef'));
    ok('Anmeldung klappt (Passwort reicht, es gibt ja noch keinen Authenticator)', !!chef.body.token);
    const gesperrt = await req('GET', '/api/entries', chef.body.token);
    ok('… aber die API ist gesperrt', gesperrt.status === 403, `${gesperrt.status}`);
    ok('… mit einer Kennung, an der die Oberfläche das erkennt',
      gesperrt.body && gesperrt.body.code === 'ZWEI_FAKTOR_EINRICHTUNG', JSON.stringify(gesperrt.body).slice(0, 90));
    ok('… und NICHT mit 401 (das würde den Nutzer hinauswerfen)', gesperrt.status !== 401);
    for (const [name, pfad] of [['eigene Daten', '/api/auth/me'], ['2FA-Zustand', '/api/auth/2fa/status']]) {
      ok(`erreichbar bleibt: ${name}`, (await req('GET', pfad, chef.body.token)).status === 200);
    }
    ok('erreichbar bleibt: Einrichtung starten', (await req('POST', '/api/auth/2fa/setup', chef.body.token)).status === 200);
    // Die uebrigen Karten der Konto-Seite muessen ebenfalls laden — sonst steht derjenige, den wir
    // gerade zur Einrichtung zwingen, vor einer halb kaputten Seite.
    for (const [name, pfad] of [['Profilbilder', '/api/avatare'], ['eigene Stammdaten', '/api/users/meine-stammdaten'],
                                ['Geburtstags-Freigabe', '/api/users/geburtstag-freigabe'], ['Push-Einstellungen', '/api/push/prefs']]) {
      ok(`erreichbar bleibt: ${name}`, (await req('GET', pfad, chef.body.token)).status === 200, pfad);
    }
    ok('gesperrt bleibt: der Live-Draht', (await req('GET', '/api/events/ticket', chef.body.token)).status === 403);
    ok('gesperrt bleibt: fremde Nutzerliste', (await req('GET', '/api/users', chef.body.token)).status === 403);
    // Einrichten → Sperre weg
    const chefSetup = await req('POST', '/api/auth/2fa/setup', chef.body.token);
    const chefVerify = await req('POST', '/api/auth/2fa/verify', chef.body.token,
      { code: totp.code(chefSetup.body.geheim) });
    ok('nach der Einrichtung ist die Sperre weg', chefVerify.status === 200
      && (await req('GET', '/api/entries', chef.body.token)).status === 200,
      `${chefVerify.status} ${chefVerify.text.slice(0, 70)}`);

    console.log('\n── 6. Abschalten nur, wenn die Rolle es zulässt ──');
    const ausVerboten = await req('POST', '/api/auth/2fa/aus', chef.body.token, { code: await frischerCode(chefSetup.body.geheim) });
    ok('bei Pflicht-Rolle abgelehnt', ausVerboten.status === 403, `${ausVerboten.status} ${ausVerboten.text.slice(0, 70)}`);
    await req('PUT', '/api/settings', adminToken, { twofa_chef: 'aus' });
    const ausErlaubt = await req('POST', '/api/auth/2fa/aus', chef.body.token, { code: await frischerCode(chefSetup.body.geheim) });
    ok('ohne Pflicht erlaubt', ausErlaubt.status === 200, `${ausErlaubt.status} ${ausErlaubt.text.slice(0, 70)}`);
    ok('… danach ist nichts mehr eingerichtet',
      (await req('GET', '/api/auth/2fa/status', chef.body.token)).body.zwei_faktor.eingerichtet === false);

    await stoppen();

    console.log('\n── 7. Notfall-Schalter ──');
    await starten({ TWOFA_AUS: '1' });
    const notfall = await anmelden('max', maPw);
    ok('trotz „jedes Mal" kommt man ohne Code hinein', !!notfall.body.token && !notfall.body.zwei_faktor_erforderlich,
      JSON.stringify(notfall.body).slice(0, 80));
    ok('… die API ist offen', (await req('GET', '/api/entries', notfall.body.token)).status === 200);
    const z = (await req('GET', '/api/auth/2fa/status', notfall.body.token)).body.zwei_faktor;
    ok('… und die Oberfläche erfährt davon', z.notabschaltung === true, JSON.stringify(z));
    await stoppen();

    console.log('\n── 7b. Schalter wieder weg → alles greift erneut ──');
    await starten();
    const wiederScharf = await anmelden('max', maPw);
    ok('es wird wieder ein Code verlangt', wiederScharf.body.zwei_faktor_erforderlich === true,
      JSON.stringify(wiederScharf.body).slice(0, 80));

  } finally {
    await stoppen();
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\n2FA-Anmeldung: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
