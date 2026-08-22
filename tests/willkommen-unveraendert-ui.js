// RÜCKSCHRITTS-PRÜFUNG der Willkommensseite (Alex, 07.08.2026).
//
// Die Seite hat einen einzigen Sammel-Handler für alle Klicks. Dort sind seit heute zwei Zweige
// dazugekommen (Aushang antippen, Termin antippen). Dieser Test fragt nicht, ob das Neue geht —
// das prüfen aushang-sprung-ui.js und planung-sprung-ui.js —, sondern ob ALLES ANDERE noch genauso
// funktioniert wie vorher:
//
//   * „Navigieren" öffnet den Karten-Auswahldialog und springt NICHT in die Planung
//   * „Übernehmen" führt weiterhin ins Zeiteintrags-Formular
//   * Abwesenheits-Karten sind NICHT anklickbar geworden
//   * die Wetter-Vorschau klappt weiterhin auf
//   * Enter/Leertaste an anderer Stelle löst nichts aus
//   * die Tagesansicht scrollt ohne Sprung wie gehabt zur Kernarbeitszeit und hebt nichts hervor
//   * nach einem Sprung bleibt keine Markierung an einem anderen Tag hängen
//
// Die Browser-Uhr wird dabei fest auf 12:00 gestellt. Ohne das prueft die Zeile „mit der geplanten
// Startzeit" die Uhrzeit des Laufs statt die Vorbelegung: Liegt „jetzt" VOR dem geplanten Beginn,
// schlaegt das Formular korrekt „jetzt" vor (app-3-dashboard.js, zeitenAbgleichen — eine Annahme
// von 07:00 waere um 01:24 Uhr schlicht falsch). Der Test war deshalb nachts rot, obwohl an der
// App nichts fehlte. Dasselbe Vorgehen wie in entry-start-and-note-ui.js.
//
//   node tests/willkommen-unveraendert-ui.js
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const puppeteer = require('puppeteer');

// Feste Tageszeit fuer den Browser. Feste Zeitstempel bleiben unberuehrt, nur „jetzt" wandert.
const TEST_STUNDE = 12, TEST_MINUTE = 0;
async function uhrStellen(page) {
  await page.evaluateOnNewDocument((h, m) => {
    const Echt = Date;
    const basis = new Echt();
    basis.setHours(h, m, 0, 0);
    const versatz = basis.getTime() - Echt.now();
    function Gestellt(...args) {
      if (args.length === 0) return new Echt(Echt.now() + versatz);
      return new Echt(...args);
    }
    Gestellt.prototype = Echt.prototype;
    Gestellt.now = () => Echt.now() + versatz;
    Gestellt.parse = Echt.parse;
    Gestellt.UTC = Echt.UTC;
    window.Date = Gestellt;
  }, TEST_STUNDE, TEST_MINUTE);
}

const CHROME = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/puppeteer/chrome-headless-shell/linux-149.0.7827.22/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 3235, DB = '/tmp/willkommen-unveraendert.db', BASIS = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = []; const uebersprungen = [];
const ok = (n, c, e) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, fails.push(n), console.log('  ✗ ' + n + (e ? '  → ' + e : '')));

function req(m, p, t, b) {
  return new Promise((res, rej) => { const d = b ? JSON.stringify(b) : null;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      x => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j, text: s }); }); });
    r.on('error', rej); if (d) r.write(d); r.end(); });
}
function tagDerWoche(n) {
  const h = new Date(); const wt = h.getDay();
  const mo = new Date(h); mo.setDate(h.getDate() + (wt === 0 ? -6 : 1 - wt));
  const d = new Date(mo); d.setDate(mo.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  const lg = fs.openSync('/tmp/willkommen-unveraendert-srv.log', 'w');
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: DB, JWT_SECRET: 'test-secret-mindestens-32-zeichen-lang' }, stdio: ['ignore', lg, lg] });
  let browser;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await req('GET', '/health')).status === 200) break; } catch (_) {} await sleep(200); }
    let log = ''; for (let i = 0; i < 120; i++) { log = fs.readFileSync('/tmp/willkommen-unveraendert-srv.log', 'utf8'); if (/max\s+->\s+\S+/.test(log)) break; await sleep(200); }
    const pw = n => (log.match(new RegExp(n + '\\s+->\\s+(\\S+)')) || [])[1];
    const admin = (await req('POST', '/api/auth/login', null, { username: 'admin', password: pw('admin') })).body;
    const max = (await req('POST', '/api/auth/login', null, { username: 'max', password: pw('max') })).body;

    const tag1 = tagDerWoche(1), tag2 = tagDerWoche(3);
    const plan = async (datum, von, bis, adr) => (await req('POST', '/api/planning', admin.token,
      { date: datum, time_from: von, time_to: bis, description: 'Einsatz', address: adr,
        assigned_user_ids: [max.user.id] })).body.entry.id;
    // 09:15 und NICHT 07:00: Der Firmen-Arbeitsbeginn ist 07:00, und das Formular greift darauf
    // zurueck, wenn keine Planung vorliegt. Mit 07:00 im Plan waere die Zusicherung „mit der
    // geplanten Startzeit" nicht von „mit dem Firmenwert" zu unterscheiden gewesen — sie haette
    // also nichts geprueft.
    const t1 = await plan(tag1, '09:15', '11:00', 'Musterstr. 1, 96199 Zapfendorf');
    const t2 = await plan(tag2, '13:00', '16:00', 'Hauptstr. 12, 96052 Bamberg');
    // Ein Termin fuer HEUTE. Ohne ihn haengt der Abschnitt „Tagesansicht ohne Sprung" davon ab,
    // welcher Wochentag gerade ist: `#/planning` oeffnet immer den heutigen Tag, und an einem Tag
    // ohne Eintraege gibt es gar keine Zeitleiste. Am 07.08. (Freitag) war der Test nur deshalb
    // gruen, weil auf den Freitag zufaellig die Urlaubs-Abwesenheit fiel und diese eine Leiste
    // erzeugte; am Samstag darauf lief er in eine Zeitueberschreitung. Gruen aus dem falschen Grund.
    await plan(new Date().toLocaleDateString('sv-SE'), '09:00', '12:00', 'Heutiger Einsatz');
    // Eine genehmigte Abwesenheit an einem dritten Tag — sie darf NICHT anklickbar sein.
    const abw = await req('POST', '/api/absences', admin.token,
      { type: 'urlaub', date_from: tagDerWoche(4), date_to: tagDerWoche(4), target_user_id: max.user.id });
    if (abw.status < 300) await req('POST', `/api/absences/${abw.body.absence.id}/approve`, admin.token);
    // Ein Aushang von heute, damit auch dieser Zweig auf der Seite steht.
    await req('POST', '/api/bulletin', admin.token, { title: 'Info', text: 'Kurzinfo' });

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage(); await page.setViewport({ width: 520, height: 900 });
    page.setDefaultTimeout(45000);
    await uhrStellen(page);
    await page.goto(BASIS + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASIS + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-user');
    await page.type('#login-user', 'max'); await page.type('#login-pass', pw('max'));
    await page.click('#login-form button[type="submit"]');
    await page.waitForSelector('a[href="#/statistics"]'); await sleep(500);
    const willkommen = async () => {
      await page.goto(BASIS + '/#/welcome', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.welcome-page'); await sleep(1700);
    };

    console.log('── „Navigieren" im Termin ──');
    await willkommen();
    await page.click(`[data-planung="${t1}"] .nav-to-addr`);
    await sleep(900);
    const nachNav = await page.evaluate(() => ({
      hash: location.hash,
      dialog: !!document.querySelector('.modal-overlay, .dialog-modal'),
    }));
    ok('öffnet den Karten-Auswahldialog', nachNav.dialog, JSON.stringify(nachNav));
    ok('… und springt NICHT in die Planung', nachNav.hash !== '#/planning', JSON.stringify(nachNav));
    // Dialog schließen (Escape), Seite muss weiter stehen
    await page.keyboard.press('Escape'); await sleep(600);
    ok('nach Escape ist man weiterhin auf der Willkommensseite',
      (await page.evaluate(() => location.hash)) === '#/welcome');

    console.log('\n── „Übernehmen" im Termin ──');
    await willkommen();
    await page.click(`[data-planung="${t1}"] .accept-welcome-plan`);
    await sleep(1600);
    const nachUeber = await page.evaluate(() => location.hash);
    // Der Weg geht ueber #/planning/accept/<id> — von dort in das vorbefuellte Eintragsformular.
    // (Meine erste Erwartung „/entry/" war falsch; die App war richtig.)
    ok('führt auf die Übernahme-Route', /#\/planning\/accept\/\d+/.test(nachUeber), nachUeber);
    ok('… und NICHT in die Tagesansicht', nachUeber !== '#/planning', nachUeber);
    await page.waitForSelector('#ef-date', { timeout: 15000 }).catch(() => {});
    const formular = await page.evaluate(() => ({
      da: !!document.getElementById('ef-date'),
      von: (document.getElementById('ef-from') || {}).value,
      bis: (document.getElementById('ef-to') || {}).value,
      adresse: (document.getElementById('ef-address') || {}).value,
    }));
    ok('… und landet im Zeiteintrags-Formular', formular.da, JSON.stringify(formular));
    ok('… mit der geplanten Startzeit (09:15, nicht dem Firmenwert 07:00)',
      formular.von === '09:15', JSON.stringify(formular));
    ok('… und der Adresse aus der Planung', /Musterstr/.test(formular.adresse || ''), JSON.stringify(formular));
    // „Bis" ist bewusst die AKTUELLE Uhrzeit, nicht das geplante Ende — das ist die dokumentierte
    // Regel der Zeiterfassung („Realität schlägt Planung"). Erwartet wird also nur eine gueltige
    // Uhrzeit, nicht 11:00. Meine erste Erwartung war hier falsch, nicht die App.
    ok('… und einer gültigen „Bis"-Zeit', /^\d{2}:\d{2}$/.test(formular.bis || ''), JSON.stringify(formular));

    console.log('\n── Abwesenheits-Karten sind nicht anklickbar geworden ──');
    await willkommen();
    const abwZustand = await page.evaluate(() => {
      const alle = [...document.querySelectorAll('.welcome-task')];
      const ohne = alle.filter(el => !el.dataset.planung);
      return {
        gesamt: alle.length, ohneTermin: ohne.length,
        rollen: ohne.map(el => el.getAttribute('role')),
        klickbar: ohne.filter(el => el.classList.contains('welcome-task--klickbar')).length,
      };
    });
    ok('es gibt Karten ohne Termin-Kennung (die Abwesenheiten)', abwZustand.ohneTermin > 0, JSON.stringify(abwZustand));
    ok('… sie haben keine Knopf-Rolle', abwZustand.rollen.every(r => !r), JSON.stringify(abwZustand));
    ok('… und sind nicht als anklickbar ausgezeichnet', abwZustand.klickbar === 0, JSON.stringify(abwZustand));
    // Draufklicken darf nichts tun
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.welcome-task')].find(e => !e.dataset.planung);
      if (el) el.click();
    });
    await sleep(900);
    ok('Klick darauf führt nirgendwohin', (await page.evaluate(() => location.hash)) === '#/welcome');

    console.log('\n── Wetter-Vorschau klappt weiterhin auf ──');
    // Der Testrechner hat kein Internet, echtes Wetter kommt hier also nie an. Der Klick-Zweig ist
    // aber reine Oberflaeche — deshalb wird die Antwort des Servers im Browser bereitgestellt.
    // Das prueft genau das, worum es geht: dass der Sammel-Handler das Aufklappen weiterhin macht
    // und die neuen Zweige nicht dazwischenfunken.
    await page.evaluateOnNewDocument(() => {
      const echt = window.fetch;
      window.fetch = function (u, o) {
        const url = typeof u === 'string' ? u : (u && u.url) || '';
        if (!/\/api\/settings\/weather/.test(url)) return echt.apply(this, arguments);
        const tage = [0, 1, 2, 3].map(n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); });
        const time = [], temp = [], code = [], regen = [];
        tage.forEach(t => { for (let h = 0; h < 24; h++) {
          time.push(t + 'T' + String(h).padStart(2, '0') + ':00'); temp.push(15 + (h % 7)); code.push(1); regen.push(0);
        } });
        const daten = { city: 'Bamberg',
          current: { temperature_2m: 19, weather_code: 1, wind_speed_10m: 8, relative_humidity_2m: 55 },
          daily: { temperature_2m_max: [22, 23, 21, 20], temperature_2m_min: [11, 12, 10, 9] },
          hourly: { time, temperature_2m: temp, weather_code: code, precipitation_probability: regen } };
        return Promise.resolve(new Response(JSON.stringify(daten), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      };
    });
    // Wichtig: bis hierher wurde nur der Hash gewechselt — das laedt KEIN neues Dokument, der Stub
    // saesse also nie drin. Einmal richtig neu laden (die Anmeldung liegt im localStorage).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="#/statistics"]');
    await willkommen();
    const wetterDa = await page.$('.weather-week .ww-item .ww-row[data-day]');
    if (wetterDa) {
      const vorher = await page.$$eval('#welcome-weather .wh-scroll', els => els.filter(e => e.checkVisibility && e.checkVisibility()).length);
      await page.click('.weather-week .ww-item .ww-row[data-day]');
      await sleep(700);
      const nachher = await page.$$eval('#welcome-weather .wh-scroll', els => els.filter(e => e.checkVisibility && e.checkVisibility()).length);
      ok('ein Tag lässt sich aufklappen', nachher === vorher + 1, `${vorher} → ${nachher}`);
      ok('… und das Aufklappen springt nicht weg', (await page.evaluate(() => location.hash)) === '#/welcome');
      ok('… und markiert keinen Termin', await page.$$eval('.tl-plan-entry--hervor, .welcome-task--hervor', e => e.length) === 0);
    } else {
      const wie = await page.$eval('#welcome-weather', el => el.innerText.slice(0, 120)).catch(() => 'kein Wetterbereich');
      ok('Wetter-Vorschau ist da', false, wie);
    }

    console.log('\n── Tastatur an anderer Stelle löst nichts aus ──');
    await willkommen();
    await page.evaluate(() => { const h = document.querySelector('.welcome-header'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } });
    await page.keyboard.press('Enter'); await sleep(700);
    ok('Enter auf der Kopfzeile bewirkt nichts', (await page.evaluate(() => location.hash)) === '#/welcome');

    console.log('\n── Tagesansicht ohne Sprung ──');
    await page.goto(BASIS + '/#/planning', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tl-plan-entry, .timeline-scroll'); await sleep(1800);
    ok('die Tagesansicht zeigt überhaupt eine Zeitleiste', await page.$('.timeline-scroll') !== null,
      'ohne Leiste sagt der Abschnitt nichts aus');
    const ohneSprung = await page.evaluate(() => {
      const sc = document.querySelector('.timeline-scroll');
      return {
        gescrollt: sc ? sc.scrollTop : null,
        markiert: document.querySelectorAll('.tl-plan-entry--hervor').length,
      };
    });
    ok('nichts ist hervorgehoben, wenn man direkt hingeht', ohneSprung.markiert === 0, JSON.stringify(ohneSprung));
    ok('… und der Verlauf ist wie gehabt zur Kernarbeitszeit gescrollt',
      ohneSprung.gescrollt === null || ohneSprung.gescrollt > 0, JSON.stringify(ohneSprung));

    console.log('\n── Keine hängengebliebene Markierung ──');
    await willkommen();
    await page.click(`[data-planung="${t2}"]`);
    await page.waitForFunction(() => location.hash === '#/planning'); await sleep(1200);
    ok('nach dem Sprung ist genau EINER markiert',
      (await page.$$eval('.tl-plan-entry--hervor', e => e.length)) === 1);
    await sleep(2200);   // Markierung läuft nach 2,5 s aus
    ok('… danach ist die Markierung wieder weg',
      (await page.$$eval('.tl-plan-entry--hervor', e => e.length)) === 0);
    // Einen Tag weiterblättern: dort darf nichts markiert sein
    await page.evaluate(() => { const b = document.querySelector('.date-nav button, #plan-next, [aria-label*="ächster"]'); if (b) b.click(); });
    await sleep(1500);
    ok('auch nach dem Weiterblättern ist nichts markiert',
      (await page.$$eval('.tl-plan-entry--hervor', e => e.length)) === 0);

  } finally {
    if (browser) await browser.close();
    srv.kill('SIGTERM'); await sleep(700);
    try { fs.unlinkSync(DB); } catch (_) {}
  }
  if (uebersprungen.length) console.log(`\nNICHT geprüft: ${uebersprungen.join(', ')}`);
  console.log(`\nWillkommensseite unverändert: ${pass} bestanden, ${fail} fehlgeschlagen` + (fails.length ? `\nFehlgeschlagen: ${fails.join(', ')}` : ''));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
