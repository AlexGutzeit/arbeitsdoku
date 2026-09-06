// Überstunden-Auszahlung in der Oberfläche.
//
// Was hier wirklich schiefgehen kann:
//   * Der Mitarbeiter sieht die Anfrage nicht und der Chef wartet ewig auf eine Antwort.
//   * Der Zähler fehlt — genau der Fehler, den Alex beim Bestell-Zähler gefunden hat: Die Zahl
//     kam vom Server, aber das Feld war nie da, und refreshBadges überspringt fehlende Felder
//     stillschweigend. Deshalb wird hier das ZÄHLERFELD selbst geprüft, nicht nur die Zahl.
//   * Der Unterschriftsweg sieht aus wie eine Zustimmung des Mitarbeiters.
//
//   node tests/ueberstunden-auszahlung-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3305, DB = '/tmp/auszahlung-ui.db', LOG = '/tmp/auszahlung-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
const AUFNAHMEN = process.env.SHOTS_DIR || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

const heute = new Date().toLocaleDateString('sv-SE');
async function schuss(seite, name) {
  if (!AUFNAHMEN) return;
  try { await seite.screenshot({ path: path.join(AUFNAHMEN, name), fullPage: false }); } catch (_) {}
}

async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  seite.setDefaultTimeout(45000);
  await seite.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await seite.waitForSelector('a[href="#/statistics"]'); await sleep(800);
  return { ktx, seite };
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 150; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/chef\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const chefTok = (await req('POST', '/api/auth/login', null, { username: 'chef', password: pw('chef') })).body.token;
    const PW = 'Auszahl!2345';
    const ma = (await req('POST', '/api/users', chefTok, { username: 'ottok', password: PW,
      name: 'Otto Konto', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    ok('Aufbau: Mitarbeiter angelegt', !!ma, JSON.stringify(ma && ma.id));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];
    const c = await anmelden(browser, 'chef', pw('chef'));
    c.seite.on('pageerror', e => jsFehler.push('chef: ' + e.message));

    console.log('\n── Der Chef legt eine Auszahlung an ──');
    await c.seite.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await c.seite.waitForSelector('.auszahlen-user'); await sleep(600);
    ok('der Knopf steht in der Mitarbeiterliste',
      await c.seite.$(`.auszahlen-user[data-id="${ma.id}"]`) !== null);
    await c.seite.evaluate(id => document.querySelector(`.auszahlen-user[data-id="${id}"]`).click(), ma.id);
    await sleep(700);
    await schuss(c.seite, '1-chef-dialog.png');
    const dialog = await c.seite.evaluate(() => (document.querySelector('.modal') || document.body).innerText);
    ok('… der Dialog nennt den aktuellen Stand', /Überstunden/i.test(dialog), dialog.slice(0, 160));
    ok('… und erklärt den Unterschriftsweg als Ausnahme',
      /unterschrieben/i.test(dialog) && /entscheidet .* selbst in der App/i.test(dialog), dialog.slice(0, 400));

    await c.seite.evaluate(() => {
      document.querySelector('#az-stunden').value = '12';
      document.querySelector('[data-act="ok"]').click();
    });
    await sleep(1800);
    ok('… nach dem Anlegen ist der Dialog zu', await c.seite.$('#az-stunden') === null);

    console.log('\n── Der Mitarbeiter sieht sie — mit Zähler ──');
    const m = await anmelden(browser, 'ottok', PW);
    m.seite.on('pageerror', e => jsFehler.push('ma: ' + e.message));
    await sleep(1200);
    // Das ZÄHLERFELD selbst, nicht nur die Zahl: refreshBadges überspringt fehlende Felder still.
    const zaehler = await m.seite.evaluate(() => {
      const el = document.getElementById('nav-badge-konto');
      return { da: !!el, sichtbar: el ? el.style.display !== 'none' : false, text: el ? el.textContent.trim() : null };
    });
    ok('das Zählerfeld an „Mein Konto" ist vorhanden', zaehler.da, JSON.stringify(zaehler));
    ok('… es ist sichtbar und zeigt 1', zaehler.sichtbar && zaehler.text === '1', JSON.stringify(zaehler));
    await schuss(m.seite, '2-ma-zaehler.png');

    await m.seite.goto(BASIS + '/#/konto', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await schuss(m.seite, '3-ma-karte.png');
    const karte = await m.seite.evaluate(() => {
      const k = document.getElementById('konto-auszahlung');
      return { sichtbar: !!k && k.style.display !== 'none', text: k ? k.innerText : '' };
    });
    ok('die Karte steht auf „Mein Konto"', karte.sichtbar, JSON.stringify(karte).slice(0, 200));
    ok('… sie nennt Stunden und Stichtag', /12:00/.test(karte.text) && /wirksam ab/i.test(karte.text), karte.text.slice(0, 220));
    ok('… und bietet beides an: zustimmen und ablehnen',
      /Zustimmen/.test(karte.text) && /Ablehnen/.test(karte.text), karte.text.slice(0, 220));

    console.log('\n── Zustimmen wirkt ──');
    const vorher = (await req('GET', `/api/statistics/overtime?user_id=${ma.id}&date_to=${heute}`, chefTok)).body.overtime;
    await m.seite.evaluate(() => document.getElementById('auszahlung-ja').click());
    await sleep(700);
    await m.seite.evaluate(() => {
      const b = [...document.querySelectorAll('.modal [data-act="ok"]')].pop(); if (b) b.click();
    });
    await sleep(2000);
    const nachher = (await req('GET', `/api/statistics/overtime?user_id=${ma.id}&date_to=${heute}`, chefTok)).body.overtime;
    ok('der Überstundenstand sinkt um 12', Math.round((vorher - nachher) * 100) / 100 === 12, `${vorher} → ${nachher}`);
    await schuss(m.seite, '4-nach-zustimmung.png');
    const nachKarte = await m.seite.evaluate(() => {
      const k = document.getElementById('konto-auszahlung');
      return k ? k.innerText : '';
    });
    ok('… die Karte zeigt jetzt den Verlauf statt der Frage',
      /Ausgezahlte Überstunden/i.test(nachKarte) && !/Zustimmen/.test(nachKarte), nachKarte.slice(0, 200));
    const zaehlerDanach = await m.seite.evaluate(() => {
      const el = document.getElementById('nav-badge-konto');
      return el ? el.style.display !== 'none' : false;
    });
    ok('… und der Zähler ist wieder weg', zaehlerDanach === false, String(zaehlerDanach));

    console.log('\n── Der Unterschriftsweg ist als solcher erkennbar ──');
    await req('POST', '/api/payouts', chefTok, { user_id: ma.id, stunden: 3, wirksam_ab: heute, belegweg: 'unterschrift' });
    // MESSFALLE: goto auf DIESELBE Adresse loest kein hashchange aus — die Seite baute sich nicht
    // neu auf, und der Test las die alte Liste. reload() ist ein echter Seitenaufbau.
    await m.seite.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const mitUnterschrift = await m.seite.evaluate(() => {
      const k = document.getElementById('konto-auszahlung'); return k ? k.innerText : '';
    });
    ok('… er steht im Verlauf mit dem Vermerk',
      /per Unterschrift/i.test(mitUnterschrift), mitUnterschrift.slice(0, 260));
    await schuss(m.seite, '5-unterschrift.png');

    console.log('\n── Der Ausstellen-Dialog nennt den Stand ──');
    await c.seite.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await c.seite.waitForSelector('.deactivate-user'); await sleep(700);
    await c.seite.evaluate(id => document.querySelector(`.deactivate-user[data-id="${id}"]`).click(), ma.id);
    await sleep(1200);
    await schuss(c.seite, '6-ausstellen-mit-stand.png');
    const ausDialog = await c.seite.evaluate(() => (document.querySelector('.modal') || document.body).innerText);
    ok('… „abfeiern, stehen lassen oder auszahlen" wird gefragt',
      /abfeiern, stehen lassen oder auszahlen/i.test(ausDialog), ausDialog.slice(0, 300));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }

  console.log(`\nAuszahlung in der Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
