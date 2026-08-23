// Scharfschalten nur mit gültigem Code (Alex, 23.08.2026).
//
// „Die 2fa darf man nur mit einem gültigen Code scharf schalten können, um diese erst nutzen zu
// können, wenn der Generator definitiv funktioniert."
//
// Die Gefahr ist konkret: Wer eine Rolle von „aus" auf Pflicht stellt, sperrt damit Menschen aus —
// sich selbst zuerst. Ein QR-Code, den man eingescannt zu haben GLAUBT, oder eine falsch gestellte
// Handy-Uhr fällt sonst erst auf, wenn niemand mehr hineinkommt. Also: eingerichteter
// Authenticator UND ein frischer, gültiger Code, bevor die Pflicht greift.
//
// Bewusst nur in DIESE Richtung geprüft — Abschalten und der Wechsel zwischen zwei Pflicht-Stufen
// müssen OHNE Code gehen. Sonst wäre es eine Falle: Ein Admin ohne eigenen Authenticator könnte
// die Pflicht für die Mitarbeiter nicht mehr zurücknehmen. Der gefährliche Weg ist das Anziehen.
//
//   node tests/twofa-scharfschalten.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');
const totp = require('../totp');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');

const PORT = 3278, DB = '/tmp/twofa-scharf.db';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
const stand = async (t) => (await req('GET', '/api/settings', t)).body.settings || {};
// Ein Code aus dem NAECHSTEN 30-Sekunden-Fenster. Der Server nimmt ihn (Toleranz +/-1 Fenster),
// und sein Zeitschritt ist groesser als der zuletzt verbrauchte — damit laesst sich der
// Wiederverwendungs-Riegel umgehen, OHNE im Test eine halbe Minute zu warten.
// Nutzbar ist er nur EINMAL je Nutzer und Fenster: Der Server nimmt now-1, now und now+1, und
// verbraucht ist danach dieser Schritt. Wer zweimal nacheinander scharf schalten will, braucht
// entweder eine halbe Minute Geduld oder eine andere Person — genau wie im Alltag.
const naechsterCode = (geheim) => totp.code(geheim, Date.now() + 30000);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/twofa-scharf-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync('/tmp/twofa-scharf-srv.log', 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const chef = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;

    console.log('── Ohne eigenen Authenticator geht Scharfschalten NICHT ──');
    let r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet' });
    ok('abgelehnt', r.status === 400, `${r.status} ${r.text.slice(0, 80)}`);
    ok('… mit eigener Kennung, damit die Oberfläche reagieren kann',
      r.body && r.body.code === 'ZWEI_FAKTOR_SELBST_NOETIG', JSON.stringify(r.body));
    ok('… und die Einstellung steht unverändert auf „aus"',
      ((await stand(admin)).twofa_mitarbeiter || 'aus') === 'aus');

    console.log('\n── Authenticator einrichten und bestätigen ──');
    const setup = (await req('POST', '/api/auth/2fa/setup', admin, {})).body;
    ok('Schlüssel erzeugt', !!(setup && setup.geheim));
    ok('… aber noch NICHT aktiv (erst der Code macht ihn gültig)',
      (await req('GET', '/api/auth/2fa/status', admin)).body.zwei_faktor.eingerichtet === false);
    // Zwischendurch: auch jetzt darf man noch nicht scharf schalten.
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet' });
    ok('mit bloss BEGONNENER Einrichtung immer noch nicht', r.body && r.body.code === 'ZWEI_FAKTOR_SELBST_NOETIG',
      JSON.stringify(r.body));
    ok('Bestätigung mit gültigem Code klappt',
      (await req('POST', '/api/auth/2fa/verify', admin, { code: totp.code(setup.geheim) })).status === 200);
    ok('… jetzt ist er aktiv',
      (await req('GET', '/api/auth/2fa/status', admin)).body.zwei_faktor.eingerichtet === true);

    console.log('\n── Scharfschalten ohne Code ──');
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet' });
    ok('abgelehnt', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_CODE_NOETIG', JSON.stringify(r.body));
    ok('… Einstellung unverändert', ((await stand(admin)).twofa_mitarbeiter || 'aus') === 'aus');

    console.log('\n── Scharfschalten mit FALSCHEM Code ──');
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet', twofa_code: '000000' });
    ok('abgelehnt', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_CODE_FALSCH', JSON.stringify(r.body));
    ok('… Einstellung unverändert', ((await stand(admin)).twofa_mitarbeiter || 'aus') === 'aus');
    // Ein Code, der zwar gültig gerechnet ist, aber zu einem FREMDEN Schlüssel gehört.
    const fremd = totp.geheimnisErzeugen();
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet', twofa_code: totp.code(fremd) });
    ok('ein Code aus einer fremden App nützt nichts', r.status === 400, `${r.status} ${r.text.slice(0, 70)}`);

    console.log('\n── Scharfschalten mit gültigem Code ──');
    // Der Code aus der Bestaetigung eben liegt im SELBEN Zeitfenster und ist verbraucht — deshalb
    // einer aus dem naechsten. Das ist keine Testkruecke, sondern derselbe Fall wie im Alltag:
    // Wer binnen 30 Sekunden zweimal einen Code braucht, muss auf den naechsten warten.
    const gueltig = naechsterCode(setup.geheim);
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'geraet', twofa_code: gueltig });
    ok('klappt', r.status === 200, `${r.status} ${r.text.slice(0, 90)}`);
    ok('… und die Pflicht steht', (await stand(admin)).twofa_mitarbeiter === 'geraet');
    ok('der Code landet NICHT als Einstellung in der Datenbank',
      (await stand(admin)).twofa_code === undefined, JSON.stringify(Object.keys(await stand(admin)).filter(k => /code/.test(k))));

    console.log('\n── Derselbe Code ein zweites Mal ──');
    r = await req('PUT', '/api/settings', admin, { twofa_chef: 'taeglich', twofa_code: gueltig });
    ok('wird abgewiesen (Wiederverwendung)', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_CODE_VERBRAUCHT',
      JSON.stringify(r.body));

    console.log('\n── Ein Chef ohne eigenen Authenticator ──');
    r = await req('PUT', '/api/settings', chef, { twofa_buchhalter: 'woechentlich' });
    ok('kann nicht scharf schalten', r.status === 400 && r.body.code === 'ZWEI_FAKTOR_SELBST_NOETIG', JSON.stringify(r.body));
    ok('… darf aber weiterhin abschalten', (await req('PUT', '/api/settings', chef, { twofa_buchhalter: 'aus' })).status === 200);
    ok('… und andere Einstellungen ganz normal speichern',
      (await req('PUT', '/api/settings', chef, { company_name: 'SenTec Elektro' })).status === 200);
    ok('… die auch ankommen', (await stand(chef)).company_name === 'SenTec Elektro');

    console.log('\n── Lösen bleibt frei — sonst baut man eine Falle ──');
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'aus' });
    ok('Abschalten OHNE Code klappt', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    ok('… und wirkt', ((await stand(admin)).twofa_mitarbeiter || 'aus') === 'aus');
    // Wechsel zwischen zwei Pflicht-Stufen: kein neues Aussperr-Risiko, also ohne Code.
    // Erneut scharf schalten — diesmal durch den CHEF mit seinem eigenen Code. Das umgeht nicht
    // nur den verbrauchten Zeitschritt des Admins, sondern prueft zugleich, dass auch ein
    // Nicht-Admin eine Rolle scharf schalten darf, wenn er seinen Generator nachweist.
    const chefSetup = (await req('POST', '/api/auth/2fa/setup', chef, {})).body;
    await req('POST', '/api/auth/2fa/verify', chef, { code: totp.code(chefSetup.geheim) });
    ok('der Chef hat jetzt selbst einen Authenticator',
      (await req('GET', '/api/auth/2fa/status', chef)).body.zwei_faktor.eingerichtet === true);
    r = await req('PUT', '/api/settings', chef, { twofa_mitarbeiter: 'geraet', twofa_code: naechsterCode(chefSetup.geheim) });
    ok('der Chef schaltet mit seinem eigenen Code scharf', r.status === 200, `${r.status} ${r.text.slice(0, 90)}`);
    r = await req('PUT', '/api/settings', admin, { twofa_mitarbeiter: 'taeglich' });
    ok('Wechsel geraet → taeglich ohne Code', r.status === 200, `${r.status} ${r.text.slice(0, 80)}`);
    ok('… und wirkt', (await stand(admin)).twofa_mitarbeiter === 'taeglich');

    console.log('\n── Und derselbe Riegel in der Oberfläche ──');
    // Der Server allein genuegt fuer die Sicherheit — aber wenn die Oberflaeche den Code nicht
    // abfragt, laeuft der Nutzer in eine Fehlermeldung statt durch einen Dialog.
    //
    // Eigener Admin dafuer, und ein Wort zum Zeitfenster: Der Wiederverwendungs-Riegel nimmt je
    // Nutzer nur STEIGENDE Zeitschritte, und gueltig sind nur die drei Fenster um „jetzt". Dieser
    // Ablauf braucht drei Codes (bestaetigen, anmelden, scharf schalten) — also genau jetzt-1,
    // jetzt und jetzt+1, in dieser Reihenfolge. Damit die Fenstergrenze nicht mitten hineinfaellt,
    // wird vorher auf den Anfang eines frischen Fensters gewartet (hoechstens 30 Sekunden).
    await req('POST', '/api/users', admin, { username: 'admin2', password: 'Test1234!', name: 'Zweiter Admin', role: 'admin' });
    const a2 = (await req('POST', '/api/auth/login', null, { username: 'admin2', password: 'Test1234!' })).body.token;
    const a2Setup = (await req('POST', '/api/auth/2fa/setup', a2, {})).body;
    await sleep(30000 - (Date.now() % 30000) + 600);
    const jetzt = Date.now();
    ok('zweiter Admin bestätigt seinen Authenticator (Fenster jetzt-1)',
      (await req('POST', '/api/auth/2fa/verify', a2, { code: totp.code(a2Setup.geheim, jetzt - 30000) })).status === 200);
    await req('PUT', '/api/settings', admin, { twofa_buchhalter: 'aus' });   // sauberer Ausgangspunkt

    const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 950 });
      page.setDefaultTimeout(30000);
      await page.evaluateOnNewDocument(() => {
        window.__put = null;
        const echt = window.fetch;
        window.fetch = function (...args) {
          try {
            const o = args[1];
            if (o && o.method === 'PUT' && String(args[0]).includes('/api/settings') && typeof o.body === 'string') {
              window.__put = JSON.parse(o.body);
            }
          } catch (_) {}
          return echt.apply(this, args);
        };
      });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-user');
      await page.type('#login-user', 'admin2'); await page.type('#login-pass', 'Test1234!');
      await page.click('#login-form button[type="submit"]');
      await sleep(1800);
      // Freiwillig eingerichtete 2FA gilt nach der Regel „geraet" — die Anmeldung fragt also.
      ok('die Anmeldung verlangt einen Code', !!(await page.$('#login-code')));
      await page.type('#login-code', totp.code(a2Setup.geheim, jetzt));
      await page.click('#code-form button[type="submit"]');
      await sleep(2600);
      ok('… und danach ist er drin', !(await page.$('#login-user')) && !(await page.$('#login-code')));

      await page.goto(`http://localhost:${PORT}/#/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#s-twofa-buchhalter'); await sleep(1800);
      await page.select('#s-twofa-buchhalter', 'woechentlich');
      await page.evaluate(() => document.getElementById('twofa-form').requestSubmit());
      await sleep(900);
      ok('es kommt eine Rückfrage, bevor etwas passiert', !!(await page.$('.dialog-modal [data-act="ok"]')));
      await page.click('.dialog-modal [data-act="ok"]');
      await sleep(900);
      ok('… und danach die Abfrage des Codes', !!(await page.$('#pm-input')),
        'ohne sie liefe der Nutzer in eine Fehlermeldung');
      ok('bis hierher wurde NICHTS gesendet', (await page.evaluate(() => window.__put)) === null);
      await page.type('#pm-input', totp.code(a2Setup.geheim, jetzt + 30000));
      await page.click('.dialog-modal [data-act="ok"]');
      await sleep(2400);
      const gesendet = await page.evaluate(() => window.__put);
      ok('der Code geht mit', !!(gesendet && /^\d{6}$/.test(String(gesendet.twofa_code || ''))), JSON.stringify(gesendet));
      ok('… und die Pflicht steht danach', (await stand(admin)).twofa_buchhalter === 'woechentlich',
        String((await stand(admin)).twofa_buchhalter));
    } finally { await browser.close(); }

    console.log('\n── Im Protokoll ──');
    const eintraege = JSON.stringify((await req('GET', '/api/audit?limit=200', admin)).body);
    ok('falscher Code beim Scharfschalten protokolliert', /twofa_scharf_code_falsch/.test(eintraege));
    ok('die Änderung selbst ebenfalls', /twofa_mitarbeiter/.test(eintraege));

  } finally {
    srv.kill('SIGTERM'); await sleep(800);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nScharfschalten nur mit Code: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
