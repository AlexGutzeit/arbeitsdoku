// Vorgemerkter Austritt in der Oberfläche (Alex, 04.09.2026).
//
// Zwei Dinge, die hier wirklich schiefgehen können:
//
//  * Der Chef sieht nicht, dass jemand schon gekündigt hat, und stellt ihn ein zweites Mal aus —
//    oder wundert sich, warum der Kollege noch in der Liste steht.
//  * Der MITARBEITER erfährt aus der App von seiner Kündigung, bevor der Chef mit ihm gesprochen
//    hat. Das wäre der schlimmere Fehler, und deshalb wird er hier ausdrücklich geprüft.
//
//   node tests/austritt-vormerken-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3304, DB = '/tmp/austritt-vormerken-ui.db', LOG = '/tmp/austritt-vormerken-ui-srv.log';
const BASIS = `http://localhost:${PORT}`;
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
const plus = (n) => { const d = new Date(heute + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const deDatum = (iso) => iso.split('-').reverse().join('.');

async function anmelden(browser, user, pw) {
  const ktx = await browser.createBrowserContext();
  const seite = await ktx.newPage();
  seite.setDefaultTimeout(45000);
  await seite.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await seite.waitForSelector('#login-user');
  await seite.type('#login-user', user); await seite.type('#login-pass', pw);
  await seite.click('#login-form button[type="submit"]');
  await seite.waitForSelector('a[href="#/statistics"]'); await sleep(700);
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
    const PW = 'Vormerk!2345';
    const ma = (await req('POST', '/api/users', chefTok, { username: 'gehtbald', password: PW,
      name: 'Gerd Gehtbald', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    ok('Aufbau: Mitarbeiter angelegt', !!ma, JSON.stringify(ma && ma.id));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const jsFehler = [];
    const c = await anmelden(browser, 'chef', pw('chef'));
    c.seite.on('pageerror', e => jsFehler.push('chef: ' + e.message));

    console.log('\n── Der Dialog sagt, was wirklich passiert ──');
    await c.seite.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await c.seite.waitForSelector('.deactivate-user'); await sleep(600);
    await c.seite.evaluate((id) => document.querySelector(`.deactivate-user[data-id="${id}"]`).click(), ma.id);
    await sleep(600);
    const dialog = await c.seite.evaluate(() => (document.querySelector('.modal, .modal-box, [role="dialog"]') || document.body).innerText);
    ok('… dass der Zugang bis zum letzten Arbeitstag bleibt',
      /bis einschließlich zum letzten arbeitstag bleibt der zugang/i.test(dialog), dialog.slice(0, 220));
    ok('… und dass ein vergangener Tag sofort wirkt',
      /vergangenheit.*sofort/i.test(dialog), dialog.slice(0, 260));

    // Datum in die Zukunft setzen und bestätigen
    const zieltag = plus(14);
    await c.seite.evaluate((d) => {
      const feld = document.querySelector('.modal input[type="date"], input[type="date"]');
      feld.value = d; feld.dispatchEvent(new Event('input', { bubbles: true }));
    }, zieltag);
    await c.seite.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /ausstellen/i.test(x.textContent) && !x.className.includes('deactivate-user'));
      b.click();
    });
    await sleep(2000);

    console.log('\n── Die Liste zeigt die Vormerkung ──');
    const liste = await c.seite.evaluate((id) => {
      const zeile = document.querySelector(`.austritt-aufheben[data-id="${id}"]`)?.closest('tr');
      return {
        nochInDerListe: !!zeile,
        hinweis: zeile ? (zeile.querySelector('.austritt-vormerkung')?.textContent.trim() || '') : '',
        knopfAufheben: !!zeile?.querySelector('.austritt-aufheben'),
        knopfAusstellen: !!zeile?.querySelector('.deactivate-user'),
      };
    }, ma.id);
    ok('der Mitarbeiter steht weiterhin in der Liste', liste.nochInDerListe, JSON.stringify(liste));
    ok('… mit dem Hinweis „scheidet aus zum …"',
      liste.hinweis.includes(deDatum(zieltag)), JSON.stringify(liste.hinweis));
    ok('… und „Ausstellen" ist durch „Vormerkung aufheben" ersetzt',
      liste.knopfAufheben && !liste.knopfAusstellen, JSON.stringify(liste));

    console.log('\n── Der Mitarbeiter sieht NICHTS davon ──');
    // Der schlimmere Fehler wäre, dass er aus der App von seiner Kündigung erfährt, bevor der
    // Chef mit ihm gesprochen hat. Deshalb hier ausdrücklich geprüft, nicht nur angenommen.
    const m = await anmelden(browser, 'gehtbald', PW);
    m.seite.on('pageerror', e => jsFehler.push('ma: ' + e.message));
    const beimMa = await m.seite.evaluate(async () => {
      const texte = [];
      for (const route of ['/welcome', '/konto', '/dashboard', '/absences']) {
        location.hash = route;
        await new Promise(r => setTimeout(r, 1400));
        texte.push(document.body.innerText);
      }
      return texte.join('\n');
    });
    ok('nirgends steht „scheidet aus"', !/scheidet aus/i.test(beimMa));
    ok('… und auch nicht sein Austrittsdatum', !beimMa.includes(deDatum(zieltag)), deDatum(zieltag));
    // Der Zeitnachweis haengt im Menue an `#/` (app-2-auth-layout.js:327), nicht an `#/dashboard`.
    ok('… er kann normal arbeiten: Zeitnachweis im Menü und Eintragen möglich',
      await m.seite.evaluate(() => !!document.querySelector('a[href="#/"]')
        && !!document.querySelector('a[href="#/absences"]')));
    const buchen = await req('POST', '/api/entries',
      (await req('POST', '/api/auth/login', null, { username: 'gehtbald', password: PW })).body.token,
      { date: heute, time_from: '07:00', time_to: '15:30', break_minutes: 30, description: 'noch dabei' });
    ok('… und er kann tatsächlich Stunden buchen', buchen.status === 201, buchen.status + ' ' + buchen.text.slice(0, 90));

    console.log('\n── Die Vormerkung lässt sich aufheben ──');
    await c.seite.goto(BASIS + '/#/users', { waitUntil: 'domcontentloaded' });
    await c.seite.waitForSelector('.austritt-aufheben'); await sleep(600);
    await c.seite.evaluate((id) => document.querySelector(`.austritt-aufheben[data-id="${id}"]`).click(), ma.id);
    await sleep(600);
    await c.seite.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^aufheben$/i.test(x.textContent.trim()));
      b.click();
    });
    await sleep(2000);
    const danach = await c.seite.evaluate((id) => {
      const zeile = document.querySelector(`[data-id="${id}"]`)?.closest('tr');
      return { hinweis: zeile?.querySelector('.austritt-vormerkung')?.textContent || '',
               knopfAusstellen: !!zeile?.querySelector('.deactivate-user') };
    }, ma.id);
    ok('der Hinweis ist weg', !danach.hinweis, JSON.stringify(danach));
    ok('… und „Ausstellen" steht wieder da', danach.knopfAusstellen, JSON.stringify(danach));
    const zeitraum = (await req('GET', '/api/users', chefTok)).body.users.find(u => u.id === ma.id);
    ok('… auch in den Daten ist kein Austritt mehr vermerkt',
      !(zeitraum.employment || []).some(p => p.e), JSON.stringify(zeitraum && zeitraum.employment));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.join(' | '));
    await m.seite.close(); await m.ktx.close();
    await c.seite.close(); await c.ktx.close();
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(`\nVormerkung in der Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
