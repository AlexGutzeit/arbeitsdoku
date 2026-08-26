// Nettostunden und gebuchte Pause je Auftrag im Zeitnachweis (Alex, 26.08.2026)
//
// Bis hierher stand am einzelnen Eintrag nur die Uhrzeit von–bis. Die Nettostunden fehlten in der
// Tagesansicht ganz, die Pause fehlte in der Wochenansicht und auf kurzen Bloecken. Und im
// Spaltenkopf stand nur der Name — wer wissen wollte, wie viel EINER an diesem Tag hat, musste
// selbst zusammenzaehlen.
//
// Die Regel fuer KURZE Bloecke ist bewusst: Netto und Pause erscheinen dort NUR, wenn eine Pause
// gebucht ist. Ohne Pause sagt „0:45" dasselbe wie „08:00-08:45" — die Zahl waere eine
// Wiederholung und wuerde den Projektnamen aus der ohnehin engen Zeile draengen (Entscheidung
// Alex). Genau diese Unterscheidung wird hier gemessen, mit eigens dafuer angelegten Eintraegen:
// echte Daten enthalten den Fall „kurz MIT Pause" nur zufaellig.
//
//   node tests/zeitnachweis-netto-pause-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3291, DB = '/tmp/zeitnachweis-netto.db', BASIS = `http://localhost:${PORT}`;
const LOG = '/tmp/zeitnachweis-netto-srv.log';
const TAG = '2026-07-06';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
// Text eines Eintrags im Zeitstrahl bzw. in der Wochenansicht.
const textVon = (seite, wahl, id) => seite.evaluate((w, i) => {
  const el = document.querySelector(`${w}[data-entry-id="${i}"]`);
  return el ? el.innerText.replace(/\s+/g, ' ').trim() : '(nicht gefunden)';
}, wahl, id);

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
    const pw = (log.match(/admin\s+->\s+(\S+)/) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw })).body.token;
    // Eintraege gehoeren einem Mitarbeiter, nicht dem Admin — der Server weist das ausdruecklich ab.
    const mitarbeiter = (await req('POST', '/api/users', admin, { username: 'monteur', password: 'Str3ng!Geheim',
      name: 'Mark Monteur', role: 'mitarbeiter', target_hours_per_week: 40 })).body.user;
    const ich = mitarbeiter && mitarbeiter.id;
    ok('Mitarbeiter angelegt', !!ich, JSON.stringify(mitarbeiter));

    // Drei Faelle, die die Regel auseinanderhalten. Ein Block ist kompakt, solange er unter einer
    // Stunde dauert (TL_HOUR_PX = 50 px/Stunde, Schwelle 50 px).
    const anlegen = async (von, bis, pause, name) =>
      (await req('POST', '/api/entries', admin, { user_id: ich, date: TAG, time_from: von, time_to: bis, break_minutes: pause, description: name })).body.entry;
    const kurzMitPause = await anlegen('08:00', '08:45', 15, 'Kurz mit Pause');
    const kurzOhnePause = await anlegen('09:00', '09:45', 0, 'Kurz ohne Pause');
    const langMitPause = await anlegen('10:00', '14:00', 30, 'Lang mit Pause');
    ok('drei Testeinträge angelegt', !!(kurzMitPause && kurzOhnePause && langMitPause),
      JSON.stringify([kurzMitPause, kurzOhnePause, langMitPause].map(e => e && e.id)));
    ok('… und die Schnittstelle rechnet netto richtig',
      kurzMitPause.net_hours === 0.5 && kurzOhnePause.net_hours === 0.75 && langMitPause.net_hours === 3.5,
      JSON.stringify([kurzMitPause.net_hours, kurzOhnePause.net_hours, langMitPause.net_hours]));

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 1000 });
    p.setDefaultTimeout(30000);
    const jsFehler = [];
    p.on('pageerror', e => jsFehler.push(e.message));

    await p.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#login-user');
    await p.type('#login-user', 'admin'); await p.type('#login-pass', pw);
    await p.click('#login-form button[type="submit"]');
    await sleep(2500);
    await p.evaluate(() => { location.hash = '#/'; }); await sleep(2000);
    await p.evaluate((d) => { S.view = 'day'; S.currentDate = new Date(d + 'T12:00:00'); render(); }, TAG);
    await sleep(2500);

    console.log('── Tagesansicht ──');
    const tLang = await textVon(p, '.tl-entry', langMitPause.id);
    ok('langer Block: Nettostunden neben der Uhrzeit', /10:00 - 14:00 · 3:30/.test(tLang), tLang);
    ok('… und die Pause steht weiterhin darunter', /Pause: 30 min/.test(tLang), tLang);

    const tKurzMit = await textVon(p, '.tl-entry', kurzMitPause.id);
    ok('kurzer Block MIT Pause: Netto erscheint', /0:30/.test(tKurzMit), tKurzMit);
    ok('… und die Pause als P15', /P15/.test(tKurzMit), tKurzMit);
    ok('… die Uhrzeit bleibt vorn', /^08:00-08:45/.test(tKurzMit), tKurzMit);

    const tKurzOhne = await textVon(p, '.tl-entry', kurzOhnePause.id);
    ok('kurzer Block OHNE Pause: keine Nettozahl (waere nur Wiederholung)',
      !/0:45/.test(tKurzOhne) && !/P\d/.test(tKurzOhne), tKurzOhne);
    ok('… er zeigt weiterhin Uhrzeit und Beschreibung', /09:00-09:45/.test(tKurzOhne) && /Kurz ohne Pause/.test(tKurzOhne), tKurzOhne);

    console.log('\n── Tagessumme je Mitarbeiter ──');
    const kopf = await p.evaluate(() => {
      const sp = [...document.querySelectorAll('.timeline-column')];
      const t = sp.find(c => /Monteur/.test(c.querySelector('.tl-col-header-name').innerText));
      const s = t && t.querySelector('.tl-col-header-sum');
      return s ? s.innerText.replace(/\s+/g, ' ').trim() : '(keine Summe)';
    });
    // 0:30 + 0:45 + 3:30 = 4:45 netto, Pausen 15 + 0 + 30 = 45 min.
    ok('der Spaltenkopf nennt Netto und Gesamtpause des Tages', kopf === '4:45 · 45 min Pause', kopf);

    // Ueberlappende Auftraege duerfen NICHT doppelt zaehlen — der haeufigste Rechenfehler bei
    // dieser Art Summe, und in dieser App schon einmal aufgetreten (Hoechstarbeitszeit-Warnung).
    const parallel = await anlegen('10:30', '11:30', 0, 'Gleichzeitig');
    await p.evaluate((d) => { S.currentDate = new Date(d + 'T12:00:00'); render(); }, TAG);
    await sleep(2500);
    const kopf2 = await p.evaluate(() => {
      const sp = [...document.querySelectorAll('.timeline-column')];
      const t = sp.find(c => /Monteur/.test(c.querySelector('.tl-col-header-name').innerText));
      const s = t && t.querySelector('.tl-col-header-sum');
      return s ? s.innerText.replace(/\s+/g, ' ').trim() : '(keine Summe)';
    });
    ok('ein zeitgleicher Auftrag erhöht die Summe NICHT (10:30-11:30 liegt in 10:00-14:00)',
      kopf2 === '4:45 · 45 min Pause', kopf2);
    await req('DELETE', '/api/entries/' + parallel.id, admin, { reason: 'Testaufräumen' });

    console.log('\n── Wochenansicht ──');
    await p.evaluate((d) => { S.view = 'week'; S.currentDate = new Date(d + 'T12:00:00'); render(); }, TAG);
    await sleep(2500);
    const wMit = await textVon(p, '.grid-entry', kurzMitPause.id);
    ok('Eintrag mit Pause: Netto UND Pause', /0:30/.test(wMit) && /P15/.test(wMit), wMit);
    const wLang = await textVon(p, '.grid-entry', langMitPause.id);
    ok('langer Eintrag: 3:30 · P30', /3:30/.test(wLang) && /P30/.test(wLang), wLang);
    const wOhne = await textVon(p, '.grid-entry', kurzOhnePause.id);
    ok('Eintrag ohne Pause: nur Netto, kein „P"', /0:45/.test(wOhne) && !/P\d/.test(wOhne), wOhne);

    console.log('\n── Die Zahlen stimmen auch wirklich ──');
    // Nicht im Zeilentext suchen: „14:00" der Uhrzeit enthaelt „4:00" und macht jede Pruefung auf
    // die Bruttostunden wertlos. Gemessen wird deshalb genau das Stunden-Feld.
    const stundenFeld = (id) => p.evaluate((i) => {
      const el = document.querySelector(`.grid-entry[data-entry-id="${i}"] .grid-e-hours`);
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '(nicht gefunden)';
    }, id);
    const fLang = await stundenFeld(langMitPause.id);
    const fMit = await stundenFeld(kurzMitPause.id);
    ok('08:00-08:45 minus 15 min ergibt genau „0:30 · P15"', fMit === '0:30 · P15', fMit);
    ok('10:00-14:00 minus 30 min ergibt genau „3:30 · P30" (nicht brutto 4:00)', fLang === '3:30 · P30', fLang);
    ok('ohne Pause steht dort nur die Nettozahl', (await stundenFeld(kurzOhnePause.id)) === '0:45',
      await stundenFeld(kurzOhnePause.id));

    ok('keine JavaScript-Fehler', jsFehler.length === 0, jsFehler.slice(0, 2).join(' | '));
  } catch (e) {
    console.error(e); fail++; fails.push('Ausnahme: ' + e.message);
  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
  }
  console.log(`\nNetto und Pause im Zeitnachweis: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})();
