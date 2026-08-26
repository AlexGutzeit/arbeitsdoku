// Warnungen für sich selbst ausblenden (Alex, 26.08.2026)
//
// Jeder darf die gesetzlichen Hinweise im Zeitnachweis abschalten — bewusst und für sich. Drei
// Eigenschaften entscheiden darüber, ob das Feature taugt oder gefährlich ist:
//
//   * Standard ist AN. Wer nichts einstellt, bekommt die Warnungen; abschalten muss eine
//     bewusste Handlung sein. Auch ein gescheiterter Abruf darf nichts ausblenden.
//   * Es gilt die Einstellung des BETRACHTERS. Sonst könnte jemand seine eigenen Verstösse vor
//     dem Chef verstecken — genau das darf nicht gehen.
//   * Ausblenden ändert KEINE Zahl. Es nimmt nur das Zeichen weg.
//
//   node tests/warn-schalter-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3294, DB = '/tmp/warn-schalter.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/warn-schalter-srv.log';
const TAG = '2026-07-08';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  await seite.setViewport({ width: 1200, height: 950 });
  seite.setDefaultTimeout(30000);
  await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await sleep(2500);
  await seite.evaluate(() => { location.hash = '#/'; }); await sleep(2000);
  return { ktx, seite };
}
const tagesbild = async (p) => {
  await p.evaluate((d) => { S.view = 'day'; S.currentDate = new Date(d + 'T12:00:00'); render(); }, TAG);
  await sleep(2500);
  return p.evaluate(() => ({
    zeichen: document.querySelectorAll('.verstoss-zeichen').length,
    arten: [...document.querySelectorAll('.verstoss-zeichen')].map(z => z.ariaLabel).join(' '),
    netto: (() => { const k = [...document.querySelectorAll('.summary-card')].find(c => /nettostunden/i.test(c.innerText)); return k ? k.querySelector('.value').innerText.trim() : null; })(),
    summen: [...document.querySelectorAll('.tl-col-header-sum')].map(e => e.innerText.trim()),
  }));
};

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  try { fs.unlinkSync(LOG); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pwAdmin = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pwAdmin })).body.token;
    const PW = 'Str3ng!Geheim';
    const volker = (await req('POST', '/api/users', admin, { username: 'volker', password: PW,
      name: 'Volker Vorarbeiter', role: 'mitarbeiter', target_hours_per_week: 40, birth_date: '1985-03-03' })).body.user;
    // Drei verschiedene Verstoßarten an einem Tag: zu lang, zu wenig Pause, zu kurze Ruhezeit.
    await req('POST', '/api/entries', admin, { user_id: volker.id, date: '2026-07-07', time_from: '06:00', time_to: '22:00', break_minutes: 45 });
    await req('POST', '/api/entries', admin, { user_id: volker.id, date: TAG, time_from: '06:00', time_to: '17:30', break_minutes: 30 });

    console.log('── Standard: alles an ──');
    const w0 = await req('GET', '/api/users/warnungen', admin);
    ok('ohne Einstellung sind alle drei an',
      w0.body.pausen === true && w0.body.arbeitszeit === true && w0.body.ruhezeit === true, JSON.stringify(w0.body));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const a = await anmelden(browser, 'admin', pwAdmin);
    const vorher = await tagesbild(a.seite);
    ok('der Admin sieht das Warnzeichen', vorher.zeichen === 1, JSON.stringify(vorher.zeichen));
    ok('… es nennt alle drei Verstöße',
      /11 Std Arbeitszeit/.test(vorher.arten) && /Pause/.test(vorher.arten) && /Ruhezeit/.test(vorher.arten), vorher.arten);

    console.log('\n── Ein Schalter aus: nur diese Art verschwindet ──');
    await req('PUT', '/api/users/warnungen', admin, { pausen: false, arbeitszeit: true, ruhezeit: true });
    await a.seite.evaluate(() => { S.warnungen = null; });   // wie nach einem Neuladen
    await a.seite.evaluate(() => ladeWarnungen());
    const ohnePause = await tagesbild(a.seite);
    ok('das Zeichen bleibt (es gibt noch andere Verstöße)', ohnePause.zeichen === 1, JSON.stringify(ohnePause.zeichen));
    ok('… aber der Pausen-Satz ist weg', !/Minuten Pause vorgeschrieben/.test(ohnePause.arten), ohnePause.arten);
    ok('… Arbeitszeit und Ruhezeit stehen weiterhin da',
      /11 Std Arbeitszeit/.test(ohnePause.arten) && /Ruhezeit/.test(ohnePause.arten), ohnePause.arten);

    console.log('\n── Ausblenden ändert KEINE Zahl ──');
    ok('die Nettostunden sind unverändert', ohnePause.netto === vorher.netto, `${vorher.netto} → ${ohnePause.netto}`);
    ok('… und die Spaltensummen ebenfalls',
      ohnePause.summen.join('|') === vorher.summen.join('|'), JSON.stringify([vorher.summen, ohnePause.summen]));

    console.log('\n── Alles aus: kein Zeichen mehr ──');
    await req('PUT', '/api/users/warnungen', admin, { pausen: false, arbeitszeit: false, ruhezeit: false });
    await a.seite.evaluate(() => { S.warnungen = null; });
    await a.seite.evaluate(() => ladeWarnungen());
    const allesAus = await tagesbild(a.seite);
    ok('kein Warnzeichen mehr', allesAus.zeichen === 0, JSON.stringify(allesAus.zeichen));
    ok('… und immer noch dieselben Zahlen', allesAus.netto === vorher.netto, `${vorher.netto} → ${allesAus.netto}`);

    console.log('\n── Es gilt die Einstellung des BETRACHTERS ──');
    // Der Admin hat alles abgeschaltet. Volker darf seine eigenen Verstöße trotzdem sehen — und
    // umgekehrt kann Volker dem Admin nichts ausblenden. Das ist der Kern der Entscheidung.
    const v = await anmelden(browser, 'volker', PW);
    const beiVolker = await tagesbild(v.seite);
    ok('Volker sieht sein Zeichen, obwohl der Admin alles ausgeblendet hat',
      beiVolker.zeichen === 1, JSON.stringify(beiVolker.zeichen));
    await req('PUT', '/api/users/warnungen', (await req('POST', '/api/auth/login', null, { username: 'volker', password: PW })).body.token,
      { pausen: false, arbeitszeit: false, ruhezeit: false });
    // Admin wieder alles an — er muss Volkers Verstoß dann WIEDER sehen.
    await req('PUT', '/api/users/warnungen', admin, { pausen: true, arbeitszeit: true, ruhezeit: true });
    await a.seite.evaluate(() => { S.warnungen = null; });
    await a.seite.evaluate(() => ladeWarnungen());
    const wieder = await tagesbild(a.seite);
    ok('Volker kann seinen Verstoß NICHT vor dem Admin verstecken', wieder.zeichen === 1, JSON.stringify(wieder.zeichen));
    await v.seite.close(); await v.ktx.close();

    console.log('\n── Die Karte in „Mein Konto" ──');
    await a.seite.evaluate(() => { location.hash = '#/konto'; }); await sleep(2500);
    const karte = await a.seite.evaluate(() => {
      const k = document.getElementById('konto-warnungen');
      return k ? { text: k.innerText.replace(/\s+/g, ' '), schalter: k.querySelectorAll('.warn-schalter').length,
                   gesetzt: [...k.querySelectorAll('.warn-schalter')].map(c => c.checked) } : null;
    });
    ok('die Karte ist da, mit drei Schaltern', karte && karte.schalter === 3, JSON.stringify(karte && karte.schalter));
    ok('… alle drei stehen auf an', karte.gesetzt.every(x => x === true), JSON.stringify(karte.gesetzt));
    ok('… sie nennt die Paragrafen', /§ 4 ArbZG/.test(karte.text) && /§ 5 ArbZG/.test(karte.text) && /§ 8 JArbSchG/.test(karte.text), karte.text.slice(0, 200));
    ok('… und sagt, dass es nur die eigene Ansicht betrifft', /nur für deine Ansicht/i.test(karte.text), karte.text.slice(0, 300));
    ok('… und dass es an den Pflichten des Betriebs nichts ändert', /Pflichten des Betriebs/.test(karte.text));

    // Klicken statt API: der Weg, den ein Mensch geht.
    await a.seite.evaluate(() => { document.querySelector('.warn-schalter[data-key="ruhezeit"]').click(); });
    await sleep(1500);
    const nachKlick = await req('GET', '/api/users/warnungen', admin);
    ok('ein Klick schaltet wirklich ab', nachKlick.body.ruhezeit === false, JSON.stringify(nachKlick.body));
    const sofort = await tagesbild(a.seite);
    ok('… und wirkt sofort, ohne neues Anmelden', !/Ruhezeit/.test(sofort.arten), sofort.arten);

    console.log('\n── Im Protokoll ──');
    const audit = await req('GET', '/api/audit?limit=50', admin);
    const eintrag = (audit.body.logs || audit.body.entries || []).find(z => z.action === 'warnungen_geaendert');
    ok('das Abschalten steht im Audit-Log', !!eintrag && /ausgeblendet/.test(eintrag.details || ''), JSON.stringify(eintrag && eintrag.details));

    console.log('\n── Ein unvollständiger Aufruf blendet nichts aus ──');
    const halb = await req('PUT', '/api/users/warnungen', admin, { pausen: false });
    ok('fehlende Felder gelten als AN', halb.body.arbeitszeit === true && halb.body.ruhezeit === true, JSON.stringify(halb.body));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
  }
  console.log(`\nWarn-Schalter: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
