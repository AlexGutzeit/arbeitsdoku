// Gesetzliche Mindestpause (§ 4 ArbZG) in der Vorbelegung.
//
// Firmenwert 30, aber der Tag geht über 9 Stunden Arbeitszeit → das Gesetz verlangt 45. Die
// fehlenden 15 Minuten werden vorgeschlagen, sobald jemand „Bis" so weit setzt, und ein Satz
// unter dem Feld sagt warum.
//
// Der heikle Teil ist die Wechselwirkung: Die Pause bemisst sich an der Arbeitszeit, und die ist
// Anwesenheit MINUS Pause. Bei 9:45 Anwesenheit ergäbe 30 min Pause 9:15 Arbeitszeit (über 9 →
// 45 nötig), 45 min aber 9:00 (nicht über 9 → 30 genügt). Gesucht ist die KLEINSTE Pause, mit der
// die Vorschrift erfüllt ist — sonst pendelt der Vorschlag. Genau diese Grenzfälle stehen unten.
//
// Der Firmenwert ist die Untergrenze: Das Gesetz kann ihn anheben, nie senken.
//   node tests/pause-gesetz-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3196, DB = '/tmp/pause-gesetz.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
async function uhrStellen(page, h, m) {
  await page.evaluateOnNewDocument((s, min) => {
    const E = Date; const b = new E(); b.setHours(s, min, 0, 0); const v = b.getTime() - E.now();
    function G(...a) { return a.length === 0 ? new E(E.now() + v) : new E(...a); }
    G.prototype = E.prototype; G.now = () => E.now() + v; G.parse = E.parse; G.UTC = E.UTC; window.Date = G;
  }, h, m);
}
const feld = (page, id) => page.evaluate(i => (document.getElementById(i) || {}).value, id);
const hinweis = (page) => page.evaluate(() => {
  const el = document.getElementById('ef-break-hinweis');
  return el && el.checkVisibility && el.checkVisibility() ? el.innerText : '';
});
async function anmelden(page, n, pw) {
  await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-user', { timeout: 15000 });
  await page.type('#login-user', n); await page.type('#login-pass', pw);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('a[href="#/statistics"]', { timeout: 15000 }); await sleep(500);
}
async function formular(page, datum) {
  await page.goto(BASIS + '/#/', { waitUntil: 'networkidle0' }); await sleep(800);
  await page.goto(BASIS + '/#/entry/new', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ef-break', { timeout: 15000 }); await sleep(900);
  await page.evaluate(d => { const e = document.getElementById('ef-date'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, datum);
  await sleep(1500);
}
// „Bis" setzen und den Vorschlag nachziehen lassen
async function setzeZeiten(page, von, bis) {
  await page.evaluate((v, b) => {
    const f = document.getElementById('ef-from'), t = document.getElementById('ef-to');
    f.value = v; f.dispatchEvent(new Event('change', { bubbles: true }));
    t.value = b; t.dispatchEvent(new Event('change', { bubbles: true }));
  }, von, bis);
  await sleep(1600);
}

const T = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/pause-gesetz-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = '';
    for (let i = 0; i < 100; i++) {
      log = fs.readFileSync('/tmp/pause-gesetz-srv.log', 'utf8');
      if (/admin\s+->\s+\S+/.test(log) && /max\s+->\s+\S+/.test(log)) break;
      await sleep(200);
    }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const an = async n => (await req('POST', '/api/auth/login', null, { username: n, password: pw(n) })).body;
    const adminA = await an('admin'), maxA = await an('max');
    const uid = maxA.user.id;
    const eintrag = (d, von, bis, p) => req('POST', '/api/entries', adminA.token,
      { date: d, time_from: von, time_to: bis, break_minutes: p, user_id: uid });
    await req('PUT', '/api/settings', adminA.token, { break_minutes_default: 30 });
    // Diese Prüfungen gelten der ERWACHSENEN-Tabelle (§ 4 ArbZG). Ohne Geburtsdatum nimmt die App
    // vorsichtshalber „unter 18" an — das muss hier also ausdrücklich gesetzt werden, sonst prüfte
    // der Test unbemerkt die Jugendschutz-Werte. (§ 11 JArbSchG: tests/pause-jugendschutz-ui.js)
    const volljaehrig = new Date(); volljaehrig.setFullYear(volljaehrig.getFullYear() - 35);
    await req('PUT', `/api/users/${uid}`, adminA.token, { birth_date: volljaehrig.toISOString().slice(0, 10) });


    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 950 });
    await uhrStellen(page, 18, 0);
    await anmelden(page, 'max', pw('max'));

    // ══ Ein einzelner langer Eintrag ═══════════════════════════════════════════════════
    console.log('\nEin langer Tag am Stück (Firmenwert 30):');
    await formular(page, T(1));
    await setzeZeiten(page, '07:00', '15:00');           // 8 Std
    ok('8 Std Anwesenheit → 30 min (Firmenwert)', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    ok('und kein Gesetzes-Hinweis', !/Arbeitszeitgesetz/.test(await hinweis(page)), await hinweis(page));

    await setzeZeiten(page, '07:00', '16:30');           // 9 Std 30
    ok('9 Std 30 Anwesenheit → immer noch 30', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));

    await setzeZeiten(page, '07:00', '16:45');           // 9 Std 45 — der Wackelfall
    const wackel = await feld(page, 'ef-break');
    ok('9 Std 45 → 45 min (mit 30 wären es 9 Std 15 Arbeitszeit)', wackel === '45', wackel);
    const hw = await hinweis(page);
    console.log(`      Hinweis: „${hw}"`);
    ok('der Hinweis nennt das Gesetz', /Arbeitszeitgesetz/.test(hw), hw);
    ok('er nennt die 9-Stunden-Schwelle', /Ab 9 Stunden/.test(hw), hw);
    ok('er nennt die Anwesenheit des Tages', /9 Std 45/.test(hw), hw);
    ok('und den Firmenwert zum Vergleich', /Firmenwert: 30/.test(hw), hw);
    // Der Mitarbeiter ist volljährig und sein Geburtsdatum hinterlegt: Der Hinweis nennt deshalb
    // das Arbeitszeitgesetz — nicht den Jugendschutz — und keine Annahme über das Alter.
    ok('bei bekanntem Geburtsdatum kein Hinweis auf eine Annahme',
      !/vorsichtshalber/.test(hw), hw);
    ok('und nicht das Jugendarbeitsschutzgesetz', !/Jugendarbeitsschutzgesetz/.test(hw), hw);

    await setzeZeiten(page, '07:00', '18:00');           // 11 Std
    ok('11 Std → 45 min', (await feld(page, 'ef-break')) === '45', await feld(page, 'ef-break'));

    // Zurück unter die Schwelle: der Vorschlag geht wieder runter
    await setzeZeiten(page, '07:00', '15:00');
    ok('zurück auf 8 Std → wieder 30 min', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    ok('und der Gesetzes-Hinweis verschwindet', !/Arbeitszeitgesetz/.test(await hinweis(page)), await hinweis(page));

    // ══ Alex' Fall: über den Tag verteilt ══════════════════════════════════════════════
    console.log('\nDer Alltagsfall — 30 min schon genommen, dann läuft der Tag über 9 Std:');
    await eintrag(T(2), '07:00', '12:00', 15);           // 5 Std brutto
    await eintrag(T(2), '12:00', '16:00', 15);           // 4 Std brutto → zusammen 9 Std, 30 min Pause
    await formular(page, T(2));
    await setzeZeiten(page, '16:00', '17:00');           // + 1 Std → 10 Std Anwesenheit
    const nachschlag = await feld(page, 'ef-break');
    const hw2 = await hinweis(page);
    console.log(`      Vorschlag: ${nachschlag} min`);
    console.log(`      Hinweis: „${hw2}"`);
    ok('der dritte Eintrag schlägt die fehlenden 15 min vor', nachschlag === '15', nachschlag);
    ok('der Hinweis nennt die schon erfassten 30 min', /Bisher 30 min erfasst/.test(hw2), hw2);
    ok('und was noch fehlt', /es fehlen 15 min/.test(hw2), hw2);

    // Kurz bleiben → kein Nachschlag
    await setzeZeiten(page, '16:00', '16:15');           // nur 9 Std 15 gesamt
    ok('bleibt der Tag unter der Schwelle, gibt es keinen Nachschlag',
      (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));

    // ══ Sechs-Stunden-Falle ════════════════════════════════════════════════════════════
    console.log('\nDie Sechs-Stunden-Falle (Firmenwert auf 0 gesetzt):');
    await req('PUT', '/api/settings', adminA.token, { break_minutes_default: 0 });
    await anmelden(page, 'max', pw('max'));
    await formular(page, T(3));
    await setzeZeiten(page, '07:00', '12:30');           // 5 Std 30
    ok('5 Std 30 → 0 min, das Gesetz verlangt nichts', (await feld(page, 'ef-break')) === '0', await feld(page, 'ef-break'));
    await setzeZeiten(page, '07:00', '13:20');           // 6 Std 20
    ok('6 Std 20 → 30 min, obwohl der Firmenwert 0 ist', (await feld(page, 'ef-break')) === '30', await feld(page, 'ef-break'));
    ok('der Hinweis nennt die 6-Stunden-Schwelle', /Ab 6 Stunden/.test(await hinweis(page)), await hinweis(page));

    // ══ Firmenwert bleibt Untergrenze ══════════════════════════════════════════════════
    console.log('\nDer Firmenwert ist die Untergrenze:');
    await req('PUT', '/api/settings', adminA.token, { break_minutes_default: 60 });
    await anmelden(page, 'max', pw('max'));
    await formular(page, T(4));
    await setzeZeiten(page, '07:00', '18:00');           // 11 Std → Gesetz 45
    ok('Firmenwert 60 bei gesetzlichen 45 → 60 gewinnt', (await feld(page, 'ef-break')) === '60', await feld(page, 'ef-break'));
    ok('kein Gesetzes-Hinweis, weil die Firma schon darüber liegt',
      !/Arbeitszeitgesetz/.test(await hinweis(page)), await hinweis(page));

    // ══ Manuell gesetzt bleibt stehen ══════════════════════════════════════════════════
    console.log('\nManuelle Eingabe hat weiterhin Vorrang:');
    await page.evaluate(() => { const e = document.getElementById('ef-break'); e.value = '35'; e.dispatchEvent(new Event('change', { bubbles: true })); });
    await setzeZeiten(page, '07:00', '20:00');
    ok('manuell gesetzte 35 min bleiben trotz Verlängerung stehen',
      (await feld(page, 'ef-break')) === '35', await feld(page, 'ef-break'));

    // ══ Gespeicherte Werte unberührt ═══════════════════════════════════════════════════
    const alle = (await req('GET', `/api/entries?date_from=${T(4)}&date_to=${T(1)}`, adminA.token)).body.entries
      .filter(e => Number(e.user_id) === Number(uid));
    ok('die beiden gespeicherten Einträge haben weiterhin 15 min',
      alle.length === 2 && alle.every(e => e.break_minutes === 15),
      JSON.stringify(alle.map(e => e.break_minutes)));

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  console.log(`\nGesetzliche Mindestpause: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
