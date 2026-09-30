// Regelmäßige Meldungen — Oberfläche und echter Zeitplaner (Etappe 3, 30.09.2026).
//
// Alex: „jeden 1. und 3. Montag des Monats" über mehrere Auslöser; nur Chef/Admin legen sie an; siehe auch die
// Benachrichtigungen der Planung. Geprüft in der echten App:
//   A  Chef: 🔁 am Thema → Regeln → „+ Regel": zwei Auslöser (1. und 3. Montag), die Vorschau nennt beide
//      und echte Montage; „ab Erledigung" ist mit zwei Auslösern gesperrt. Gespeichert steht die Regel mit
//      ihrer nächsten Fälligkeit in der Liste und als „🔁 Restmüll · Datum" am Thema.
//   B  Mitarbeiterin: sieht „demnächst", aber keinen 🔁-Knopf.
//   C  Der ECHTE Zeitplaner des Servers legt eine heute fällige Meldung von selbst an — im Board als
//      „🔁 automatisch" mit „fällig am", live, ohne Neuladen.
//   D  Pausieren und Löschen aus der Liste.
//
//   node tests/meldung-regeln-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3361, DB = '/tmp/meldung-regeln-ui.db', LOG = '/tmp/meldung-regeln-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));
const HEUTE = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const deDatum = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ agent: false, host: 'localhost', port: PORT, path: p, method: m,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); }); });
    r.setTimeout(15000, () => { r.destroy(); res({ status: 'keine Antwort', body: null }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const gestartet = Date.now();
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser; const jsFehler = [];
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(150); }
    let log = ''; for (let i = 0; i < 100; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/admin\s+->\s+\S+/.test(log)) break; await sleep(150); }
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: (log.match(/admin\s+->\s+(\S+)/) || [])[1] })).body.token;
    for (const [u, n, r] of [['carla', 'Carla Chef', 'chef'], ['anna', 'Anna Berger', 'mitarbeiter']]) {
      await req('POST', '/api/users', admin, { username: u, password: 'Test1234!', name: n, role: r });
    }
    const muell = (await req('POST', '/api/meldungen/themen', admin, { name: 'Restmüll' })).body.thema.id;
    const tonne = (await req('POST', '/api/meldungen/themen', admin, { name: 'Tonnen' })).body.thema.id;
    // C vorbereiten: heute 00:00 fällig — der erste Lauf des Zeitplaners (15 s nach dem Start) legt sie an
    const heuteRegel = await req('POST', '/api/meldungen/regeln', admin, { thema_id: tonne, text: 'Gelbe Tonne rausstellen', uhrzeit: '00:00',
      ausloeser: [{ art: 'intervall', einheit: 'woche', n: 1, start_datum: HEUTE }] });
    const gestelltNach = Date.now() - gestartet;

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const neueSeite = async () => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', e => jsFehler.push(e.message));
      await p.setViewport({ width: 1280, height: 900 });
      p.setDefaultTimeout(15000);
      return p;
    };
    const anmelden = async (p, u) => {
      await p.goto(BASIS + '/#/login', { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#login-user');
      await p.type('#login-user', u); await p.type('#login-pass', 'Test1234!');
      await p.click('#login-form button[type="submit"]');
      await p.waitForFunction(() => document.querySelector('.main')); await sleep(600);
    };
    const zu = async (p, hash) => { await p.evaluate(h => { location.hash = h; }, hash); await p.waitForFunction(() => !document.querySelector('.main .loading')); await sleep(500); };

    console.log('A · Chef legt „Restmüll: 1. und 3. Montag" an');
    const C = await neueSeite();
    await anmelden(C, 'carla');
    await zu(C, '/meldungen');
    await C.evaluate((id) => document.querySelector(`.mld-regel-knopf[data-thema-id="${id}"]`).click(), muell);
    await C.waitForSelector('#mld-r-neu'); await sleep(400);
    ok('Regeln des Themas: noch keine', await C.evaluate(() => /Noch keine regelmäßige Meldung/.test(document.getElementById('mld-r-liste').textContent)));
    await C.click('#mld-r-neu'); await C.waitForSelector('#mld-rf-text'); await sleep(300);
    await C.type('#mld-rf-text', 'Restmüll rausstellen');
    const setze = async (i, feld, wert) => { await C.evaluate((i, feld, wert) => {
      const el = document.querySelector(`.mld-rf-ausl[data-i="${i}"] [data-f="${feld}"]`); el.value = String(wert); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, i, feld, wert); await sleep(150); };
    await setze(0, 'art', 'wochentag');
    await setze(0, 'nth', 1); await setze(0, 'wochentag', 1); await setze(0, 'n', 1);
    await C.click('#mld-rf-ausl-neu'); await sleep(300);
    const zweiter = await C.evaluate(() => { const r = document.querySelector('.mld-rf-ausl[data-i="1"]'); return r && { nth: r.querySelector('[data-f="nth"]').value, wt: r.querySelector('[data-f="wochentag"]').value }; });
    ok('„+ Auslöser" schlägt gleich den 3. Montag vor', zweiter && zweiter.nth === '3' && zweiter.wt === '1', JSON.stringify(zweiter));
    await C.waitForFunction(() => /Nächste:/.test(document.getElementById('mld-rf-vorschau').textContent), { timeout: 8000 }).catch(() => {});
    const vorschau = await C.evaluate(() => document.getElementById('mld-rf-vorschau').textContent);
    ok('Vorschau nennt beide Auslöser', /jeden 1\. Montag im Monat \+ jeden 3\. Montag im Monat/.test(vorschau), vorschau);
    const daten = (vorschau.match(/\d\d\.\d\d\.\d{4}/g) || []).map(x => `${x.slice(6)}-${x.slice(3, 5)}-${x.slice(0, 2)}`);
    ok('… mit fünf echten Montagen (1.–7. bzw. 15.–21.)', daten.length === 5 && daten.every(d => new Date(d + 'T12:00:00Z').getUTCDay() === 1
      && ((+d.slice(8) <= 7) || (+d.slice(8) >= 15 && +d.slice(8) <= 21))), JSON.stringify(daten));
    ok('„ab Erledigung" ist bei zwei Auslösern gesperrt', await C.evaluate(() => document.querySelector('input[name="mld-rf-takt"][value="ab_erledigung"]').disabled));
    await C.click('.mld-regel-form [data-act="ok"]'); await sleep(900);
    const listenText = await C.evaluate(() => document.getElementById('mld-r-liste').textContent.replace(/\s+/g, ' '));
    ok('Regel steht in der Liste — Beschreibung und nächste Fälligkeit', /Restmüll rausstellen/.test(listenText) && /jeden 1\. Montag im Monat \+ jeden 3\. Montag im Monat/.test(listenText)
      && listenText.includes('fällig am ' + deDatum(daten[0])), listenText);
    await C.click('.mld-regeln-dialog [data-act="zu"]'); await sleep(800);
    const zeile = await C.evaluate((id) => (document.querySelector(`.mld-col[data-thema-id="${id}"] .mld-regel-zeile`) || {}).textContent, muell);
    ok('am Thema: „🔁 Restmüll rausstellen · <nächster Montag>"', zeile && zeile.includes('Restmüll rausstellen') && zeile.includes(deDatum(daten[0])), zeile);

    console.log('B · Mitarbeiterin');
    const A = await neueSeite();
    await anmelden(A, 'anna');
    await zu(A, '/meldungen');
    ok('sieht, was demnächst kommt', await A.evaluate((id) => !!document.querySelector(`.mld-col[data-thema-id="${id}"] .mld-regel-zeile`), muell));
    ok('… aber keinen 🔁-Knopf', await A.evaluate(() => !document.querySelector('.mld-regel-knopf')));

    console.log('C · Der Zeitplaner legt von selbst an');
    ok('(Regel für heute rechtzeitig vor dem ersten Lauf angelegt)', heuteRegel.status === 201 && gestelltNach < 14000, `${heuteRegel.status} nach ${gestelltNach} ms`);
    await A.waitForFunction(() => [...document.querySelectorAll('.mld-karte')].some(k => /Gelbe Tonne/.test(k.textContent)), { timeout: 30000 }).catch(() => {});
    const karte = await A.evaluate(() => { const k = [...document.querySelectorAll('.mld-karte')].find(x => /Gelbe Tonne/.test(x.textContent));
      return k && { meta: k.querySelector('.mld-meta').textContent.trim(), faellig: (k.querySelector('.mld-faellig') || {}).textContent }; });
    ok('„Gelbe Tonne rausstellen" erscheint live im Board', !!karte, 'nach ' + Math.round((Date.now() - gestartet) / 1000) + ' s nicht da');
    ok('… als „🔁 automatisch", fällig heute', karte && /^🔁 automatisch/.test(karte.meta) && karte.faellig === 'fällig am ' + deDatum(HEUTE), JSON.stringify(karte));
    await A.evaluate(() => [...document.querySelectorAll('.mld-karte')].find(x => /Gelbe Tonne/.test(x.textContent)).click());
    await A.waitForSelector('.mld-detail'); await sleep(300);
    const detail = await A.evaluate(() => document.querySelector('.mld-detail').textContent.replace(/\s+/g, ' '));
    ok('Detail: „Regelmäßige Meldung · fällig am", Verlauf „automatisch (Regel von …)"', /Regelmäßige Meldung · fällig am/.test(detail) && /automatisch \(Regel von /.test(detail), detail.slice(0, 300));
    await A.evaluate(() => document.querySelector('.mld-detail [data-act="zu"]').click());

    console.log('D · Pausieren, Löschen');
    await C.evaluate((id) => document.querySelector(`.mld-regel-knopf[data-thema-id="${id}"]`).click(), muell);
    await C.waitForFunction(() => /Restmüll rausstellen/.test((document.getElementById('mld-r-liste') || {}).textContent || ''));
    await C.evaluate(() => [...document.querySelectorAll('.mld-regel [data-r="pause"]')][0].click()); await sleep(800);
    ok('pausiert: in der Liste markiert, Knopf heißt „Fortsetzen"', await C.evaluate(() => /pausiert/.test(document.getElementById('mld-r-liste').textContent)
      && [...document.querySelectorAll('.mld-regel [data-r="pause"]')][0].textContent === 'Fortsetzen'));
    await C.evaluate(() => [...document.querySelectorAll('.mld-regel [data-r="loeschen"]')][0].click());
    await C.waitForFunction(() => [...document.querySelectorAll('.modal p')].some(p => /Regel „Restmüll rausstellen" löschen/.test(p.textContent)));
    await C.evaluate(() => [...document.querySelectorAll('.modal-overlay')].pop().querySelector('[data-act="ok"]').click()); await sleep(800);
    ok('gelöscht: die Liste ist leer', await C.evaluate(() => /Noch keine regelmäßige Meldung/.test(document.getElementById('mld-r-liste').textContent)));
    await C.click('.mld-regeln-dialog [data-act="zu"]'); await sleep(800);
    ok('… und am Thema steht nichts mehr', await C.evaluate((id) => !document.querySelector(`.mld-col[data-thema-id="${id}"] .mld-regel-zeile`), muell));

    ok('keine Skriptfehler', jsFehler.length === 0, jsFehler.slice(0, 3).join(' | '));
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, (e && e.stack) + (jsFehler.length ? '\n    Skriptfehler: ' + jsFehler.slice(0, 3).join(' | ') : ''));
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await new Promise(r => { srv.once('exit', r); setTimeout(r, 3000); });
  }
  console.log(`\nRegelmäßige Meldungen — Oberfläche: ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})();
