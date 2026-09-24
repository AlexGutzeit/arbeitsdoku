// Pause schluckt die Arbeitszeit — die Oberflaeche (R6, Alex 24.09.2026).
//
// Ausgeloest hatte den Fehler der Pausenvorschlag: Ein kurzer ERSTER Einsatz des Tages bekam die
// volle Tagespause (30 min) vorgeschlagen. Wer nicht hinsah, speicherte 0 Stunden.
//
// Jetzt:
//   * passt die Tagespause nicht in den Einsatz, wird 0 vorgeschlagen — mit Erklaerung
//   * verlaengert man den Einsatz, waechst der Vorschlag wieder auf die volle Pause
//   * der NAECHSTE Eintrag des Tages schlaegt die noch fehlende Pause vor (das verspricht der Hinweis)
//   * wer die Pause selbst zu lang eintraegt, wird vor dem Absenden aufgehalten — nichts gespeichert
//
//   node tests/pause-zu-lang-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const PORT = 3327, DB = '/tmp/pause-zu-lang-ui.db', LOG = '/tmp/pause-zu-lang-ui.log';
const BASIS = 'http://localhost:' + PORT;
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
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

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync(LOG, 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' },
    stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 200; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 200; i++) { log = fs.readFileSync(LOG, 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const maxTok = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body.token;
    // Ohne Geburtsdatum rechnet die App bewusst mit „unter 18" (Jugendschutz: 60 min ab 6 Stunden).
    // Dieser Test misst den gewoehnlichen Fall eines Erwachsenen — also ein Geburtsdatum setzen.
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body.token;
    const maxId = (await req('GET', '/api/users/list', admin)).body.users.find(u => u.name === 'Max Mustermann').id;
    const gb = await req('PUT', `/api/users/${maxId}`, admin, { birth_date: '1985-05-05' });
    if (gb.status !== 200) throw new Error('Geburtsdatum setzen: ' + gb.status + ' ' + gb.text.slice(0, 80));
    const TAG = '2026-09-09';   // ein Mittwoch ohne Eintraege

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const seite = await browser.newPage();
    await seite.setViewport({ width: 1000, height: 900 });
    seite.setDefaultTimeout(30000);
    const jsFehler = []; seite.on('pageerror', e => jsFehler.push(e.message));
    await seite.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await seite.waitForSelector('#login-user');
    await seite.type('#login-user', 'max'); await seite.type('#login-pass', pw('max'));
    await seite.click('#login-form button[type="submit"]'); await sleep(2600);

    const formular = async () => {
      await seite.goto(BASIS + '/#/entry/new', { waitUntil: 'domcontentloaded' });
      await seite.waitForSelector('#ef-break'); await sleep(900);
      await seite.evaluate((t) => { const d = document.getElementById('ef-date'); d.value = t; d.dispatchEvent(new Event('change', { bubbles: true })); }, TAG);
      await sleep(900);
    };
    const zeiten = async (von, bis) => {
      await seite.evaluate((v, b) => {
        for (const [id, w] of [['ef-from', v], ['ef-to', b]]) {
          const el = document.getElementById(id); el.value = w;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, von, bis);
      await sleep(900);
    };
    const pause = () => seite.$eval('#ef-break', el => el.value);
    const hinweis = () => seite.$eval('#ef-break-hinweis', el => el.style.display === 'none' ? '' : el.textContent);

    console.log('── Zeiten noch nicht eingegeben (Von = Bis) ──');
    // Dauer 0 beim Oeffnen heisst „noch nichts eingetragen", NICHT „kurzer Einsatz". Nachts steht das
    // Formular z. B. auf 16:00–16:00 (Bis nie vor Von). Die erste Fassung von R6 machte daraus Pause 0
    // — gefunden von tests/restpause-ui.js und restpause-firmenwert-ui.js, die um 1 Uhr nachts liefen.
    await formular();
    await zeiten('09:00', '09:00');
    ok('Von = Bis: die volle Firmenpause steht da (30), wie vor R6', await pause() === '30', await pause());
    ok('… ohne den Kurz-Hinweis', !/passt nicht/.test(await hinweis()), await hinweis());

    console.log('\n── Kurzer erster Einsatz des Tages ──');
    await formular();
    await zeiten('08:00', '08:30');
    ok('08:00–08:30: vorgeschlagen wird 0 statt 30', await pause() === '0', await pause());
    ok('… und der Hinweis erklärt warum', /passt nicht in diesen kurzen Einsatz \(30 min\)/.test(await hinweis()), await hinweis());
    ok('… und wo sie stattdessen hinkommt', /nächsten Eintrag des Tages/.test(await hinweis()));

    await zeiten('08:00', '16:00');
    ok('verlängert man auf 08:00–16:00, wächst der Vorschlag auf 30', await pause() === '30', await pause());
    ok('… und der Kurz-Hinweis verschwindet', !/passt nicht/.test(await hinweis()), await hinweis());

    console.log('\n── Selbst eingetragen, zu lang → aufgehalten ──');
    await zeiten('08:00', '08:30');
    await seite.evaluate(() => { const b = document.getElementById('ef-break'); b.value = '30'; b.dispatchEvent(new Event('input', { bubbles: true })); });
    await seite.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await sleep(900);
    const t = await seite.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
    ok('Absenden wird aufgehalten, mit klarer Meldung', /so lang wie die Arbeitszeit \(30 min\)/.test(t), t);
    ok('… der Fokus steht auf der Pause', await seite.evaluate(() => document.activeElement && document.activeElement.id === 'ef-break'));
    ok('… man bleibt im Formular', await seite.evaluate(() => location.hash) === '#/entry/new');
    ok('… und auf dem Server ist nichts angekommen',
      !(await req('GET', `/api/entries?date_from=${TAG}&date_to=${TAG}`, maxTok)).body.entries.length);

    console.log('\n── Das Versprechen des Hinweises: der nächste Eintrag bekommt die Pause ──');
    await seite.evaluate(() => { const b = document.getElementById('ef-break'); b.value = '0'; b.dispatchEvent(new Event('input', { bubbles: true })); });
    await seite.evaluate(() => document.querySelector('#entry-form button[type="submit"]').click());
    await sleep(1800);
    const erster = (await req('GET', `/api/entries?date_from=${TAG}&date_to=${TAG}`, maxTok)).body.entries;
    ok('der kurze Einsatz ist mit 0 Pause gespeichert — 0,5 Stunden', erster.length === 1 && erster[0].net_hours === 0.5,
      JSON.stringify(erster.map(e => [e.time_from, e.time_to, e.break_minutes, e.net_hours])));
    await formular();
    await zeiten('08:30', '16:00');
    ok('der zweite Eintrag des Tages schlägt die volle Pause vor (30)', await pause() === '30', await pause());

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    ok('Durchlauf ohne Ausnahme', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
  } finally { if (browser) await browser.close().catch(() => {}); srv.kill(); }

  console.log(`\nPause zu lang (geklickt): ${pass} bestanden, ${fail} fehlgeschlagen`);
  if (fail) { console.log('Fehlgeschlagen: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
